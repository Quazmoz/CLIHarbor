package discovery

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExecutableIdentityMatchesUnchangedFileAndRejectsReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fixture")
	if err := os.WriteFile(path, []byte("first"), 0o755); err != nil {
		t.Fatal(err)
	}
	identity, err := CaptureExecutableIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if !identity.Valid() || !identity.Matches(path) {
		t.Fatal("identity did not match the unchanged executable")
	}

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("other"), 0o755); err != nil {
		t.Fatal(err)
	}
	if identity.Matches(path) {
		t.Fatal("identity matched a replacement at the same path")
	}
}

func TestExecutableIdentityRejectsSameFileContentMutationWithRestoredMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fixture")
	if err := os.WriteFile(path, []byte("first"), 0o755); err != nil {
		t.Fatal(err)
	}
	identity, err := CaptureExecutableIdentity(path)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(path, []byte("other"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, identity.modTime, identity.modTime); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != identity.size || !info.ModTime().Equal(identity.modTime) {
		t.Fatalf("test fixture metadata was not restored: size=%d modTime=%v", info.Size(), info.ModTime())
	}
	if identity.Matches(path) {
		t.Fatal("identity matched mutated content with restored size and modification time")
	}
}

func TestExecutableIdentityRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	link := filepath.Join(dir, "link")
	if err := os.WriteFile(target, []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if _, err := CaptureExecutableIdentity(link); err == nil {
		t.Fatal("CaptureExecutableIdentity() unexpectedly accepted a symlink")
	}
}
