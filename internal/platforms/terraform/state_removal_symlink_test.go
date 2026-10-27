//go:build !windows

package terraform

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

func TestStateRemovalHarnessResolvesExecutableSymlink(t *testing.T) {
	h := newRemovalHarness(t, "")
	link := filepath.Join(h.root, "terraform-link")
	executable := h.p.tool.Path
	if err := os.Symlink(executable, link); err != nil {
		t.Fatal(err)
	}
	activateExecutable(t, h.p, link)
	if h.p.tool.Path != executable || !h.p.tool.ExecutableIdentity.Matches(executable) {
		t.Fatal("harness did not activate the resolved regular executable")
	}
	if _, err := discovery.CaptureExecutableIdentity(link); err == nil {
		t.Fatal("production identity capture must still reject symlinks")
	}
}
