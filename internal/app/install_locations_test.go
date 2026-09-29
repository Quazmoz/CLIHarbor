package app

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

func TestManagedInstallLocationStoreRoundTripsValidUserHomeRoot(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(t.TempDir(), "locations.json")
	store := newManagedInstallLocationStoreAt(path, home)
	ref := discovery.ToolRef{PackID: "fixture-pack", ToolID: "fixture"}
	root := filepath.Join(home, "CLI Tools")

	if err := store.Save(ref, root); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded := store.Load()
	if got := loaded[ref]; got != root {
		t.Fatalf("loaded root = %q, want %q", got, root)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		t.Fatalf("location registry is not a regular file: %v", info.Mode())
	}
}

func TestManagedInstallLocationStoreIgnoresCorruptAndUnsafeEntries(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(t.TempDir(), "locations.json")
	store := newManagedInstallLocationStoreAt(path, home)

	data := []byte(`{
  "version": 1,
  "tools": {
    "fixture-pack/fixture": "` + filepath.ToSlash(filepath.Dir(home)) + `",
    "bad key": "` + filepath.ToSlash(filepath.Join(home, "safe")) + `"
  }
}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if loaded := store.Load(); len(loaded) != 0 {
		t.Fatalf("unsafe entries unexpectedly loaded: %#v", loaded)
	}

	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if loaded := store.Load(); len(loaded) != 0 {
		t.Fatalf("corrupt registry unexpectedly loaded: %#v", loaded)
	}
}

func TestValidateManagedInstallRootRejectsHomeItselfAndEscapes(t *testing.T) {
	home := t.TempDir()
	cases := []string{
		home,
		filepath.Dir(home),
		filepath.Join(home, "..", "escape"),
		"relative-path",
	}
	for _, candidate := range cases {
		if _, ok := validateManagedInstallRoot(candidate, home); ok {
			t.Fatalf("candidate %q unexpectedly accepted", candidate)
		}
	}
	if root, ok := validateManagedInstallRoot(filepath.Join(home, "tools"), home); !ok || root == "" {
		t.Fatalf("valid child root rejected: %q %t", root, ok)
	}
}

func TestValidateManagedInstallRootRejectsExistingSymlinkEscape(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("symlink creation may require Windows developer mode or elevation")
	}
	home := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(home, "linked")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if _, ok := validateManagedInstallRoot(filepath.Join(link, "tools"), home); ok {
		t.Fatal("symlink escape unexpectedly accepted")
	}
}
