package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/cyberark/conjur-api-go/conjurapi"
	"github.com/cyberark/conjur-api-go/conjurapi/response"
)

type fakeConjurLoginClient struct {
	identity string
	secret   string
	result   []byte
	err      error
	calls    int
}

func (f *fakeConjurLoginClient) Login(identity, secret string) ([]byte, error) {
	f.calls++
	f.identity = identity
	f.secret = secret
	return f.result, f.err
}

func readyConjurSnapshot() discovery.Snapshot {
	return discovery.NewSnapshot([]discovery.ToolState{{
		PackID:      conjurCredentialPackID,
		PackVersion: "0.1.2",
		ToolID:      conjurCredentialToolID,
		Status:      discovery.StatusReady,
		Version:     "9.3.1",
	}})
}

func supportedConjurConfig() conjurapi.Config {
	return conjurapi.Config{
		Account:               "engineering",
		ApplianceURL:          "https://conjur.example.test",
		AuthnType:             "authn",
		CredentialStorage:     conjurapi.CredentialStorageKeyring,
		CredentialStorageMode: conjurapi.CredentialStorageModeReadWrite,
	}
}

func TestConjurCredentialLoginUsesVendorClientWithoutExposingReturnedAPIKey(t *testing.T) {
	service := newConjurCredentialLoginService(readyConjurSnapshot())
	config := supportedConjurConfig()
	service.loadConfig = func() (conjurapi.Config, error) { return config, nil }
	returned := []byte("sensitive-returned-api-key")
	client := &fakeConjurLoginClient{result: returned}
	service.newClient = func(got conjurapi.Config) (conjurLoginClient, error) {
		if got.HTTPTimeout != credentialLoginHTTPTimeoutSeconds {
			t.Fatalf("HTTP timeout = %d, want %d", got.HTTPTimeout, credentialLoginHTTPTimeoutSeconds)
		}
		return client, nil
	}

	err := service.Login(context.Background(), server.CredentialLoginRequest{
		PackID:   conjurCredentialPackID,
		ToolID:   conjurCredentialToolID,
		Identity: "alice",
		Secret:   "correct horse battery staple",
	})
	if err != nil {
		t.Fatal(err)
	}
	if client.calls != 1 || client.identity != "alice" || client.secret != "correct horse battery staple" {
		t.Fatalf("vendor client call = %#v", client)
	}
	for _, value := range returned {
		if value != 0 {
			t.Fatalf("returned API key buffer was not cleared: %q", returned)
		}
	}
}

func TestConjurCredentialLoginSanitizesRejectedCredentialErrors(t *testing.T) {
	service := newConjurCredentialLoginService(readyConjurSnapshot())
	service.loadConfig = func() (conjurapi.Config, error) { return supportedConjurConfig(), nil }
	service.newClient = func(conjurapi.Config) (conjurLoginClient, error) {
		return &fakeConjurLoginClient{err: &response.ConjurError{Code: 401, Message: "server echoed password super-secret"}}, nil
	}

	err := service.Login(context.Background(), server.CredentialLoginRequest{
		PackID: conjurCredentialPackID, ToolID: conjurCredentialToolID, Identity: "alice", Secret: "super-secret",
	})
	var loginErr *server.CredentialLoginError
	if !errors.As(err, &loginErr) || loginErr.Code != server.CredentialLoginRejected {
		t.Fatalf("error = %#v, want sanitized rejected error", err)
	}
	if got := err.Error(); got == "" || got == "server echoed password super-secret" {
		t.Fatalf("unsafe error text = %q", got)
	}
}

func TestConjurCredentialLoginTreatsNonCredentialFailuresAsUnavailable(t *testing.T) {
	cases := []struct {
		name   string
		result []byte
		err    error
	}{
		{name: "network-or-tls", err: errors.New("dial tcp: private infrastructure detail")},
		{name: "vendor-service", err: &response.ConjurError{Code: 503, Message: "upstream internal detail"}},
		{name: "credential-storage-after-remote-success", result: []byte("sensitive-returned-api-key"), err: errors.New("keyring unavailable")},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			service := newConjurCredentialLoginService(readyConjurSnapshot())
			service.loadConfig = func() (conjurapi.Config, error) { return supportedConjurConfig(), nil }
			returned := append([]byte(nil), tc.result...)
			service.newClient = func(conjurapi.Config) (conjurLoginClient, error) {
				return &fakeConjurLoginClient{result: returned, err: tc.err}, nil
			}

			err := service.Login(context.Background(), server.CredentialLoginRequest{
				PackID: conjurCredentialPackID, ToolID: conjurCredentialToolID, Identity: "alice", Secret: "super-secret",
			})
			var loginErr *server.CredentialLoginError
			if !errors.As(err, &loginErr) || loginErr.Code != server.CredentialLoginUnavailable {
				t.Fatalf("error = %#v, want sanitized unavailable error", err)
			}
			for _, value := range returned {
				if value != 0 {
					t.Fatalf("returned API key buffer was not cleared: %q", returned)
				}
			}
		})
	}
}

func TestConjurCredentialLoginRejectsUnsupportedModesAndStorage(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*conjurapi.Config)
	}{
		{name: "oidc", mutate: func(c *conjurapi.Config) { c.AuthnType = "oidc" }},
		{name: "jwt", mutate: func(c *conjurapi.Config) { c.AuthnType = "jwt" }},
		{name: "storage-none", mutate: func(c *conjurapi.Config) { c.CredentialStorage = conjurapi.CredentialStorageNone }},
		{name: "storage-readonly", mutate: func(c *conjurapi.Config) { c.CredentialStorageMode = conjurapi.CredentialStorageModeReadOnly }},
		{name: "plaintext-appliance", mutate: func(c *conjurapi.Config) { c.ApplianceURL = "http://conjur.example.test" }},
		{name: "appliance-userinfo", mutate: func(c *conjurapi.Config) { c.ApplianceURL = "https://alice:secret@conjur.example.test" }},
		{name: "appliance-query", mutate: func(c *conjurapi.Config) { c.ApplianceURL = "https://conjur.example.test?redirect=other" }},
		{name: "appliance-fragment", mutate: func(c *conjurapi.Config) { c.ApplianceURL = "https://conjur.example.test#other" }},
		{name: "invalid-account", mutate: func(c *conjurapi.Config) { c.Account = "engineering\nother" }},
		{name: "noncanonical-account", mutate: func(c *conjurapi.Config) { c.Account = " engineering " }},
		{name: "noncanonical-ldap-service", mutate: func(c *conjurapi.Config) { c.AuthnType = "ldap"; c.ServiceID = " corp " }},
		{name: "saas", mutate: func(c *conjurapi.Config) { c.Environment = conjurapi.EnvironmentSaaS }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			service := newConjurCredentialLoginService(readyConjurSnapshot())
			config := supportedConjurConfig()
			tc.mutate(&config)
			service.loadConfig = func() (conjurapi.Config, error) { return config, nil }
			service.newClient = func(conjurapi.Config) (conjurLoginClient, error) {
				t.Fatal("vendor client must not be created for unsupported configuration")
				return nil, nil
			}

			_, _, _, available := service.Capability()
			if available {
				t.Fatal("unsupported configuration unexpectedly advertised credential login")
			}

			err := service.Login(context.Background(), server.CredentialLoginRequest{
				PackID: conjurCredentialPackID, ToolID: conjurCredentialToolID, Identity: "alice", Secret: "secret",
			})
			var loginErr *server.CredentialLoginError
			if !errors.As(err, &loginErr) || loginErr.Code != server.CredentialLoginUnsupported {
				t.Fatalf("error = %#v, want unsupported", err)
			}
		})
	}
}

func TestConjurCredentialCapabilityOnlyOffersSetupForSafeWritablePartialConfig(t *testing.T) {
	cases := []struct {
		name          string
		config        conjurapi.Config
		wantAvailable bool
		wantSetup     bool
	}{
		{
			name: "missing-account",
			config: func() conjurapi.Config {
				config := supportedConjurConfig()
				config.Account = ""
				return config
			}(),
			wantAvailable: true,
			wantSetup:     true,
		},
		{
			name: "missing-appliance",
			config: func() conjurapi.Config {
				config := supportedConjurConfig()
				config.ApplianceURL = ""
				return config
			}(),
			wantAvailable: true,
			wantSetup:     true,
		},
		{
			name: "unsafe-existing-appliance",
			config: func() conjurapi.Config {
				config := supportedConjurConfig()
				config.Account = ""
				config.ApplianceURL = "https://alice:secret@conjur.example.test"
				return config
			}(),
		},
		{
			name: "noncanonical-existing-account",
			config: func() conjurapi.Config {
				config := supportedConjurConfig()
				config.ApplianceURL = ""
				config.Account = " engineering "
				return config
			}(),
		},
		{
			name: "read-only-storage",
			config: func() conjurapi.Config {
				config := supportedConjurConfig()
				config.Account = ""
				config.CredentialStorageMode = conjurapi.CredentialStorageModeReadOnly
				return config
			}(),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			service := newConjurCredentialLoginService(readyConjurSnapshot())
			service.loadConfig = func() (conjurapi.Config, error) { return tc.config, nil }
			_, _, capability, available := service.Capability()
			if available != tc.wantAvailable {
				t.Fatalf("available = %t, want %t", available, tc.wantAvailable)
			}
			if available && capability.SetupRequired != tc.wantSetup {
				t.Fatalf("setupRequired = %t, want %t", capability.SetupRequired, tc.wantSetup)
			}
		})
	}
}

func TestConjurCredentialLoginCapabilityRequiresReadyTool(t *testing.T) {
	service := newConjurCredentialLoginService(discovery.NewSnapshot(nil))
	service.loadConfig = func() (conjurapi.Config, error) { return supportedConjurConfig(), nil }
	if _, _, _, available := service.Capability(); available {
		t.Fatal("credential login advertised without a ready Conjur tool")
	}
	err := service.Login(context.Background(), server.CredentialLoginRequest{
		PackID: conjurCredentialPackID, ToolID: conjurCredentialToolID, Identity: "alice", Secret: "secret",
	})
	var loginErr *server.CredentialLoginError
	if !errors.As(err, &loginErr) || loginErr.Code != server.CredentialLoginUnsupported {
		t.Fatalf("error = %#v, want unsupported", err)
	}
}

func readyConjurSnapshotWithExecutable(t *testing.T) discovery.Snapshot {
	t.Helper()
	path := filepath.Join(t.TempDir(), "conjur")
	if err := os.WriteFile(path, []byte("reviewed-conjur-fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	identity, err := discovery.CaptureExecutableIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	return discovery.NewSnapshot([]discovery.ToolState{{
		PackID:             conjurCredentialPackID,
		PackVersion:        "0.2.0",
		ToolID:             conjurCredentialToolID,
		Status:             discovery.StatusReady,
		Path:               path,
		ExecutableName:     filepath.Base(path),
		Version:            "9.3.1",
		ExecutableIdentity: identity,
	}})
}

func TestConjurCredentialCapabilityOffersFirstRunSetupAndRefreshesAfterConfiguration(t *testing.T) {
	service := newConjurCredentialLoginService(readyConjurSnapshotWithExecutable(t))
	config := conjurapi.Config{}
	service.loadConfig = func() (conjurapi.Config, error) { return config, nil }

	packID, toolID, capability, available := service.Capability()
	if !available || packID != conjurCredentialPackID || toolID != conjurCredentialToolID {
		t.Fatalf("setup capability = %q/%q %#v available=%t", packID, toolID, capability, available)
	}
	if capability.Method != server.CredentialLoginMethodConjurPassword || !capability.SetupRequired {
		t.Fatalf("setup capability = %#v, want conjur password with setup required", capability)
	}

	config = supportedConjurConfig()
	_, _, capability, available = service.Capability()
	if !available || capability.SetupRequired {
		t.Fatalf("configured capability = %#v available=%t, want ready login", capability, available)
	}
}

func TestConjurCredentialConfigurationUsesReviewedVendorInitArgumentsOnly(t *testing.T) {
	service := newConjurCredentialLoginService(readyConjurSnapshotWithExecutable(t))
	config := conjurapi.Config{}
	service.loadConfig = func() (conjurapi.Config, error) { return config, nil }

	var executable string
	var args []string
	service.runInit = func(_ context.Context, gotExecutable string, gotArgs []string) error {
		executable = gotExecutable
		args = append([]string(nil), gotArgs...)
		config = supportedConjurConfig()
		return nil
	}

	err := service.Configure(context.Background(), server.CredentialConfigurationRequest{
		PackID:       conjurCredentialPackID,
		ToolID:       conjurCredentialToolID,
		ApplianceURL: "https://conjur.example.test",
		Account:      "engineering",
		AuthnType:    "authn",
	})
	if err != nil {
		t.Fatal(err)
	}
	if executable == "" {
		t.Fatal("vendor init executable was not invoked")
	}
	want := []string{"init", "self-hosted", "--url", "https://conjur.example.test", "--account", "engineering"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("vendor init args = %#v, want %#v", args, want)
	}
	for _, arg := range args {
		if arg == "super-secret" || arg == "--insecure" || arg == "--self-signed" || arg == "--force" {
			t.Fatalf("unsafe init argument exposed: %q", arg)
		}
	}
}

func TestConjurCredentialConfigurationReconcilesTimeoutAfterSuccessfulWrite(t *testing.T) {
	service := newConjurCredentialLoginService(readyConjurSnapshotWithExecutable(t))
	config := conjurapi.Config{}
	service.loadConfig = func() (conjurapi.Config, error) { return config, nil }
	service.runInit = func(_ context.Context, _ string, _ []string) error {
		config = supportedConjurConfig()
		config.AuthnType = ""
		return context.DeadlineExceeded
	}

	err := service.Configure(context.Background(), server.CredentialConfigurationRequest{
		PackID:       conjurCredentialPackID,
		ToolID:       conjurCredentialToolID,
		ApplianceURL: "https://conjur.example.test",
		Account:      "engineering",
		AuthnType:    "authn",
	})
	if err != nil {
		t.Fatalf("reconciled configuration returned error: %v", err)
	}
}

func TestConjurCredentialConfigurationRequiresRequestedStateAfterInit(t *testing.T) {
	service := newConjurCredentialLoginService(readyConjurSnapshotWithExecutable(t))
	config := conjurapi.Config{}
	service.loadConfig = func() (conjurapi.Config, error) { return config, nil }
	service.runInit = func(_ context.Context, _ string, _ []string) error {
		config = supportedConjurConfig()
		config.Account = "different-account"
		return nil
	}

	err := service.Configure(context.Background(), server.CredentialConfigurationRequest{
		PackID:       conjurCredentialPackID,
		ToolID:       conjurCredentialToolID,
		ApplianceURL: "https://conjur.example.test",
		Account:      "engineering",
		AuthnType:    "authn",
	})
	var loginErr *server.CredentialLoginError
	if !errors.As(err, &loginErr) || loginErr.Code != server.CredentialLoginUnavailable {
		t.Fatalf("error = %#v, want unavailable for mismatched authoritative config", err)
	}
}

func TestConjurCredentialConfigurationAddsOnlyReviewedLDAPFlags(t *testing.T) {
	service := newConjurCredentialLoginService(readyConjurSnapshotWithExecutable(t))
	config := conjurapi.Config{}
	service.loadConfig = func() (conjurapi.Config, error) { return config, nil }

	var args []string
	service.runInit = func(_ context.Context, _ string, gotArgs []string) error {
		args = append([]string(nil), gotArgs...)
		config = supportedConjurConfig()
		config.AuthnType = "ldap"
		config.ServiceID = "corp"
		return nil
	}

	err := service.Configure(context.Background(), server.CredentialConfigurationRequest{
		PackID:       conjurCredentialPackID,
		ToolID:       conjurCredentialToolID,
		ApplianceURL: "https://conjur.example.test",
		Account:      "engineering",
		AuthnType:    "ldap",
		ServiceID:    "corp",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"init", "self-hosted",
		"--url", "https://conjur.example.test",
		"--account", "engineering",
		"--authn-type", "ldap",
		"--service-id", "corp",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("vendor init args = %#v, want %#v", args, want)
	}
}
