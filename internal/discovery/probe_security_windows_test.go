//go:build windows

package discovery

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/processenv"
)

const (
	versionProbeWindowsParentMarker = "--cliharbor-version-probe-windows-parent"
	versionProbeWindowsChildMarker  = "--cliharbor-version-probe-windows-child"
	versionProbeSynchronizeAccess   = 0x00100000
)

func TestExecProbeRunnerWindowsTimeoutTerminatesDescendant(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(t.TempDir(), "child.pid")

	_, err = (ExecProbeRunner{}).Run(context.Background(), executable, packs.VersionProbe{
		Args: []string{
			"-test.run=^TestVersionProbeWindowsParentProcess$",
			"--",
			versionProbeWindowsParentMarker,
			pidFile,
		},
		Parser:        packs.VersionParserSemverText,
		TimeoutMillis: 1000,
	})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("Run() error = %v, want timeout", err)
	}

	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("read child pid: %v", err)
	}
	pid64, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 32)
	if err != nil {
		t.Fatalf("parse child pid %q: %v", data, err)
	}
	assertWindowsProbeProcessExited(t, uint32(pid64))
}

func TestVersionProbeWindowsParentProcess(t *testing.T) {
	index := -1
	for i, arg := range os.Args {
		if arg == versionProbeWindowsParentMarker {
			index = i
			break
		}
	}
	if index < 0 {
		return
	}
	if index+1 >= len(os.Args) {
		os.Exit(91)
	}

	child := exec.Command(os.Args[0],
		"-test.run=^TestVersionProbeWindowsChildProcess$",
		"--",
		versionProbeWindowsChildMarker,
	)
	child.Env = processenv.Minimal()
	if err := child.Start(); err != nil {
		os.Exit(92)
	}
	if err := os.WriteFile(os.Args[index+1], []byte(strconv.Itoa(child.Process.Pid)), 0o600); err != nil {
		_ = child.Process.Kill()
		os.Exit(93)
	}
	fmt.Fprintln(os.Stdout, "1.2.3")
	time.Sleep(30 * time.Second)
	os.Exit(0)
}

func TestVersionProbeWindowsChildProcess(t *testing.T) {
	found := false
	for _, arg := range os.Args {
		if arg == versionProbeWindowsChildMarker {
			found = true
			break
		}
	}
	if !found {
		return
	}
	time.Sleep(30 * time.Second)
	os.Exit(0)
}

func assertWindowsProbeProcessExited(t *testing.T, pid uint32) {
	t.Helper()
	handle, err := syscall.OpenProcess(versionProbeSynchronizeAccess, false, pid)
	if err != nil {
		if errno, ok := err.(syscall.Errno); ok && errno == syscall.ERROR_INVALID_PARAMETER {
			return
		}
		t.Fatalf("OpenProcess(%d) error = %v", pid, err)
	}
	defer syscall.CloseHandle(handle)

	status, err := syscall.WaitForSingleObject(handle, 2_000)
	if err != nil {
		t.Fatalf("WaitForSingleObject(%d) error = %v", pid, err)
	}
	if status != syscall.WAIT_OBJECT_0 {
		t.Fatalf("descendant wait status = %d, want WAIT_OBJECT_0", status)
	}
}
