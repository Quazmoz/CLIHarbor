//go:build windows

package evidence

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestActivateEvidenceBundleWindowsMovesWithoutReplacing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "evidence path Ω")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}

	staging := filepath.Join(dir, "staging.tmp")
	destination := filepath.Join(dir, "phase0.json")
	if err := os.WriteFile(staging, []byte("evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := activateEvidenceBundle(staging, destination); err != nil {
		t.Fatalf("activateEvidenceBundle() error = %v", err)
	}
	if _, err := os.Stat(staging); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("successful activation left staging path behind: %v", err)
	}
	got, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "evidence" {
		t.Fatalf("activated evidence = %q, want %q", got, "evidence")
	}

	blockedStaging := filepath.Join(dir, "blocked.tmp")
	blockedDestination := filepath.Join(dir, "existing.json")
	if err := os.WriteFile(blockedStaging, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blockedDestination, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := activateEvidenceBundle(blockedStaging, blockedDestination); err == nil {
		t.Fatal("activateEvidenceBundle() replaced an existing destination")
	}
	got, err = os.ReadFile(blockedDestination)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "existing" {
		t.Fatalf("existing destination changed to %q", got)
	}
	got, err = os.ReadFile(blockedStaging)
	if err != nil {
		t.Fatalf("failed activation removed staging file: %v", err)
	}
	if string(got) != "new" {
		t.Fatalf("failed activation changed staging file to %q", got)
	}
}
