package app

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/platforms/conjur"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

// Runs the real Conjur pack's secret tasks end to end (planner, Conjur context
// resolver, approval, executor) against a stand-in conjur that records argv and stdin.
func TestConjurSecretTasksExecuteApprovedPolicyAndSecretOnStdin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("stand-in conjur is a POSIX shell script")
	}
	tempDir := t.TempDir()
	logPath := filepath.Join(tempDir, "conjur.log")
	conjurPath := filepath.Join(tempDir, "conjur")
	script := `#!/bin/sh
set -eu
case "${1:-}" in
  --version) printf '9.3.1\n'; exit 0 ;;
esac
{ printf 'ARGS:%s\n' "$*"; printf 'STDIN:'; cat; printf '\nEND\n'; } >> "$CLIHARBOR_TEST_CONJUR_LOG"
if [ "$1" = "variable" ]; then printf 'Value added\n'; else printf '{"created_roles":{},"version":2}\n'; fi
`
	if err := os.WriteFile(conjurPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	conjurrc := filepath.Join(tempDir, ".conjurrc")
	if err := os.WriteFile(conjurrc, []byte("account: engineering\nappliance_url: https://conjur.example.test\nenvironment: self-hosted\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CONJURRC", conjurrc)
	t.Setenv("CLIHARBOR_TEST_CONJUR_LOG", logPath)

	source, err := os.ReadFile(filepath.Join("..", "..", "packs", "conjur", "conjur-v9.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	packPath := filepath.Join(tempDir, "conjur-v9.yaml")
	// The shipped pack targets windows/darwin; widen only this copy so CI can run it.
	widened := strings.Replace(string(source), "platforms: [windows, darwin]", "platforms: [windows, darwin, linux]", 1)
	if err := os.WriteFile(packPath, []byte(widened), 0o600); err != nil {
		t.Fatal(err)
	}

	state, err := prepareRuntime(t.Context(), Options{
		Out:           io.Discard,
		PackFiles:     []string{packPath},
		ToolOverrides: map[discovery.ToolRef]string{{PackID: conjur.PackID, ToolID: conjur.ToolID}: conjurPath},
	})
	if err != nil {
		t.Fatalf("prepareRuntime() error = %v", err)
	}
	manager, err := runs.NewManager(t.Context(), state.Registry, state.Discovery, runs.Config{
		ResolveExecutionContext: conjur.ResolveExecutionContext,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.Shutdown(shutdownCtx)
	})

	approveAndRun := func(commandID string, values map[string]any, confirm func(runs.Preview) string) runs.Preview {
		t.Helper()
		raw := make(map[string]json.RawMessage, len(values))
		for id, value := range values {
			raw[id] = integrationRawJSON(t, value)
		}
		request := runs.Request{PackID: conjur.PackID, CommandID: commandID, Values: raw}
		preview, err := manager.Preview(request)
		if err != nil {
			t.Fatalf("Preview(%s) error = %v", commandID, err)
		}
		if preview.Context == nil || preview.Context.Fields[0].Value != "engineering" || preview.Approval == nil {
			t.Fatalf("Preview(%s) context/approval = %#v / %#v", commandID, preview.Context, preview.Approval)
		}
		request.Approval = &runs.ApprovalSubmission{ID: preview.Approval.ID, Confirmation: confirm(preview)}
		started, err := manager.Start(request)
		if err != nil {
			t.Fatalf("Start(%s) error = %v", commandID, err)
		}
		waitCtx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		finished, err := manager.Wait(waitCtx, started.RunID)
		if err != nil || finished.Status != runs.StatusExited || finished.ExitCode == nil || *finished.ExitCode != 0 {
			t.Fatalf("%s finished = %#v, err = %v", commandID, finished, err)
		}
		return preview
	}
	explicit := func(runs.Preview) string { return "" }

	permit := approveAndRun("secret-permit", map[string]any{
		"policy-branch": "apps/myapp", "variable-id": "db/password",
		"role-kind": "host", "role-id": "web", "privileges": "read, execute",
	}, explicit)
	wantPolicy := "- !permit\n  role: !host \"web\"\n  privileges: [ read, execute ]\n  resource: !variable \"db/password\"\n"
	if permit.Stdin != wantPolicy {
		t.Fatalf("permit preview stdin = %q", permit.Stdin)
	}
	approveAndRun("secret-delete", map[string]any{"policy-branch": "apps/myapp", "variable-id": "db/password"},
		func(preview runs.Preview) string { return preview.Approval.RequiredText })

	secret := "correct horse battery staple"
	setValue := approveAndRun("secret-set-value", map[string]any{"variable-id": "apps/myapp/db/password", "value": secret}, explicit)
	if setValue.Stdin != "" || strings.Contains(strings.Join(setValue.Args, " "), secret) {
		t.Fatalf("set-value preview exposed the secret: %#v", setValue)
	}

	logged, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	want := "ARGS:policy update --branch apps/myapp --file -\nSTDIN:" + wantPolicy + "\nEND\n" +
		"ARGS:policy update --branch apps/myapp --file -\nSTDIN:- !delete\n  record: !variable \"db/password\"\n\nEND\n" +
		"ARGS:variable set --id apps/myapp/db/password --file -\nSTDIN:" + secret + "\nEND\n"
	if string(logged) != want {
		t.Fatalf("conjur saw:\n%s\nwant:\n%s", logged, want)
	}
}
