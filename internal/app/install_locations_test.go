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

func TestManagedInstallLocationReadIsBoundedBeforeAllocating(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oversized.json")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	// A sparse corrupt registry must not cause a file-sized memory allocation.
	if err := file.Truncate(16 << 20); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := readManagedLocationFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) != maxManagedInstallLocationBytes+1 {
		t.Fatalf("bounded read = %d bytes", len(data))
	}
	store := newManagedInstallLocationStoreAt(path, t.TempDir())
	if got := store.Load(); len(got) != 0 {
		t.Fatalf("oversized registry was accepted: %#v", got)
	}
}

func TestManagedInstallLocationReplacementRetainsOtherTools(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(t.TempDir(), "locations.json")
	store := newManagedInstallLocationStoreAt(path, home)
	first := discovery.ToolRef{PackID: "first-pack", ToolID: "first"}
	second := discovery.ToolRef{PackID: "second-pack", ToolID: "second"}
	if err := store.Save(first, filepath.Join(home, "first")); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(second, filepath.Join(home, "second")); err != nil {
		t.Fatal(err)
	}
	loaded := store.Load()
	if len(loaded) != 2 || loaded[first] != filepath.Join(home, "first") || loaded[second] != filepath.Join(home, "second") {
		t.Fatalf("registry replacement lost an existing entry: %#v", loaded)
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
