//go:build windows

package diagnostics

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestActivateDiagnosticsBundleWindowsMovesWithoutReplacing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "diagnostics Ω")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	staging := filepath.Join(dir, "staging.tmp")
	destination := filepath.Join(dir, "bundle.json")
	if err := os.WriteFile(staging, []byte("diagnostics"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := activateDiagnosticsBundle(staging, destination); err != nil {
		t.Fatalf("activateDiagnosticsBundle() error = %v", err)
	}
	if _, err := os.Stat(staging); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("successful activation left staging path: %v", err)
	}
	got, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "diagnostics" {
		t.Fatalf("activated bytes = %q", got)
	}

	blocked := filepath.Join(dir, "blocked.tmp")
	if err := os.WriteFile(blocked, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := activateDiagnosticsBundle(blocked, destination); err == nil {
		t.Fatal("activation replaced existing diagnostics destination")
	}
	got, err = os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "diagnostics" {
		t.Fatalf("existing destination changed to %q", got)
	}
}
