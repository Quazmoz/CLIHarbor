package vault

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/executor"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

// Fixtures are trimmed from real `vault kv ... -format=json` output (Vault 2.2.2).
const (
	kv2Secret  = `{"request_id":"r","data":{"data":{"password":"p@ss","username":"app","port":5432},"metadata":{"created_time":"t","custom_metadata":null,"deletion_time":"","destroyed":false,"version":3}},"warnings":null,"mount_type":"kv"}`
	kv1Secret  = `{"request_id":"r","lease_duration":2764800,"data":{"a":"1"},"warnings":null,"mount_type":"kv"}`
	kv2Deleted = `{"request_id":"r","data":{"data":null,"metadata":{"deletion_time":"t","destroyed":false,"version":1}},"warnings":null}`
	badToken   = "Error making API request.\n\nURL: GET http://127.0.0.1:8200/v1/sys/internal/ui/mounts/secret/x\nCode: 403. Errors:\n\n* 2 errors occurred:\n\t* permission denied\n\t* invalid token\n"
)

type call struct{ args []string }

func newTestPlatform(t *testing.T, env map[string]string, result executor.ReadOnlyProbeResult) (*Platform, *[]call) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	identity, err := discovery.CaptureExecutableIdentity(exe)
	if err != nil {
		t.Fatal(err)
	}
	p := New(func(name string) string { return env[name] })
	p.ActivateTool(discovery.ToolState{PackID: PackID, ToolID: ToolID, Status: discovery.StatusReady, Path: exe, ExecutableIdentity: identity})
	calls := &[]call{}
	p.run = func(_ context.Context, executable string, args []string) (executor.ReadOnlyProbeResult, error) {
		if executable != exe {
			t.Fatalf("executable = %q", executable)
		}
		*calls = append(*calls, call{args: append([]string{}, args...)})
		out := result
		out.Stdout = append([]byte{}, result.Stdout...)
		return out, nil
	}
	return p, calls
}

func TestRevealParsesKVVersionsAndLogsMetadataOnly(t *testing.T) {
	for _, tc := range []struct {
		name, stdout, code string
		version            int
		fields             []server.VaultSecretField
	}{
		{"kv2", kv2Secret, "", 3, []server.VaultSecretField{{Key: "password", Value: "p@ss"}, {Key: "port", Value: "5432"}, {Key: "username", Value: "app"}}},
		{"kv1", kv1Secret, "", 0, []server.VaultSecretField{{Key: "a", Value: "1"}}},
		{"kv2 deleted", kv2Deleted, "not_found", 0, nil},
		{"garbage", "not json", "invalid_response", 0, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, calls := newTestPlatform(t, map[string]string{"VAULT_ADDR": "https://vault.example:8200/"}, executor.ReadOnlyProbeResult{Stdout: []byte(tc.stdout)})
			got, err := p.Reveal(context.Background(), server.VaultSecretRequest{Mount: "secret", Path: "apps/web/db"})
			if err != nil || got.FailureCode != tc.code || got.Version != tc.version || !reflect.DeepEqual(got.Fields, tc.fields) {
				t.Fatalf("Reveal() = %#v, %v", got, err)
			}
			if want := []string{"kv", "get", "-format=json", "secret/apps/web/db"}; !reflect.DeepEqual((*calls)[0].args, want) {
				t.Fatalf("argv = %q", (*calls)[0].args)
			}
			log := p.AccessLog()
			if len(log) != 1 || log[0].Address != "https://vault.example:8200" || log[0].Path != "apps/web/db" || strings.Contains(log[0].Outcome, "p@ss") {
				t.Fatalf("access log = %#v", log)
			}
		})
	}
}

func TestVendorFailuresAreClassifiedWithoutEcho(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result executor.ReadOnlyProbeResult
		want   string
	}{
		{"invalid token", executor.ReadOnlyProbeResult{ExitCode: 2, Stderr: []byte(badToken)}, "session_required"},
		{"empty folder", executor.ReadOnlyProbeResult{ExitCode: 2, Stdout: []byte("{}")}, "not_found"},
		{"unreachable", executor.ReadOnlyProbeResult{ExitCode: 2, Stderr: []byte(`Get "http://127.0.0.1:1/v1/x": dial tcp 127.0.0.1:1: connectex: refused`)}, "unreachable"},
		{"timeout", executor.ReadOnlyProbeResult{TimedOut: true}, "unavailable"},
		{"truncated", executor.ReadOnlyProbeResult{Truncated: true}, "output_limit_exceeded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, _ := newTestPlatform(t, nil, tc.result)
			got, err := p.List(context.Background(), server.VaultSecretRequest{Mount: "secret"})
			if err != nil || got.FailureCode != tc.want || len(got.Keys) != 0 {
				t.Fatalf("List() = %#v, %v", got, err)
			}
		})
	}
}

func TestListRootUsesMountAndSortsKeys(t *testing.T) {
	p, calls := newTestPlatform(t, nil, executor.ReadOnlyProbeResult{Stdout: []byte(`["top","apps/"]`)})
	got, err := p.List(context.Background(), server.VaultSecretRequest{Mount: "secret"})
	if err != nil || !reflect.DeepEqual(got.Keys, []string{"apps/", "top"}) || (*calls)[0].args[3] != "secret/" {
		t.Fatalf("List() = %#v, %v, calls %q", got, err, *calls)
	}
}

func TestUnsafeRequestsNeverReachTheCLI(t *testing.T) {
	p, calls := newTestPlatform(t, nil, executor.ReadOnlyProbeResult{Stdout: []byte(kv1Secret)})
	for _, request := range []server.VaultSecretRequest{
		{Mount: "-address=https://evil", Path: "x"}, {Mount: "secret", Path: "../sys/x"}, {Mount: "secret", Path: "a//b"},
		{Mount: "secret", Path: "a b"}, {Mount: "secret", Path: "/x"}, {Mount: "", Path: "x"}, {Mount: "secret", Path: ""},
	} {
		if _, err := p.Reveal(context.Background(), request); err != server.ErrVaultInvalidRequest {
			t.Fatalf("Reveal(%#v) error = %v", request, err)
		}
	}
	if len(*calls) != 0 || len(p.AccessLog()) != 0 {
		t.Fatalf("invalid requests executed: %q", *calls)
	}
}

func TestContextNeverEchoesCredentialBearingAddress(t *testing.T) {
	p, calls := newTestPlatform(t, map[string]string{"VAULT_ADDR": "https://user:hunter2@vault.example"}, executor.ReadOnlyProbeResult{})
	if got := p.Context(); got.Address != "" || got.Ready {
		t.Fatalf("Context() = %#v", got)
	}
	if got, _ := p.List(context.Background(), server.VaultSecretRequest{Mount: "secret"}); got.FailureCode != "not_configured" || len(*calls) != 0 {
		t.Fatalf("List() with unsafe address = %#v", got)
	}
	if got := New(func(string) string { return "" }).Context(); got.Address != defaultAddress || got.Ready {
		t.Fatalf("default Context() = %#v", got)
	}
}
