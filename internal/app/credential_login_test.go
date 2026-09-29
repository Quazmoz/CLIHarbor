package app

import (
	"context"
	"errors"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/cyberark/conjur-api-go/conjurapi"
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

func TestConjurCredentialLoginSanitizesVendorErrors(t *testing.T) {
	service := newConjurCredentialLoginService(readyConjurSnapshot())
	service.loadConfig = func() (conjurapi.Config, error) { return supportedConjurConfig(), nil }
	service.newClient = func(conjurapi.Config) (conjurLoginClient, error) {
		return &fakeConjurLoginClient{err: errors.New("server echoed password super-secret")}, nil
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
