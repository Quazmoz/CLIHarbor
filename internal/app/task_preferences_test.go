package app

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestTaskPreferencesStoreIsPrivateAndRefusesSymlinks(t *testing.T) {
	dir := t.TempDir()
	store := &taskPreferencesStore{path: filepath.Join(dir, "CLIHarbor", "task-preferences.json")}
	if store.Load() != nil {
		t.Fatal("missing file must load as nil")
	}
	if err := store.Save([]byte(`{"v":1}`)); err != nil {
		t.Fatal(err)
	}
	if got := string(store.Load()); got != `{"v":1}` {
		t.Fatalf("Load = %q", got)
	}
	if info, err := os.Stat(store.path); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("stored file mode = %v, %v; want 0600", info.Mode(), err)
	}

	target := filepath.Join(dir, "elsewhere.json")
	if err := os.WriteFile(target, []byte(`{"v":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	linked := &taskPreferencesStore{path: filepath.Join(dir, "linked.json")}
	if err := os.Symlink(target, linked.path); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	if linked.Load() != nil || linked.Save([]byte(`{}`)) == nil {
		t.Fatal("a symlinked preference file must be neither read nor replaced")
	}
}
