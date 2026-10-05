//go:build windows

package terminal

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"golang.org/x/sys/windows"
)

// Test-only entry points let the actual Windows console launcher run this test
// binary as both the console host and the vendor fixture, without real credentials.
func init() {
	evidence := os.Getenv("CLIHARBOR_TERMINAL_FIXTURE")
	if evidence == "" || len(os.Args) < 2 {
		return
	}
	switch os.Args[1] {
	case "_conjur-login-console":
		if os.Getenv("CLIHARBOR_TERMINAL_HOLD") == "1" {
			wait := waitForConsoleClose
			waitForConsoleClose = func() {
				_ = os.WriteFile(evidence+".host", []byte(strconv.Itoa(os.Getpid())), 0o600)
				wait()
			}
		} else {
			waitForConsoleClose = func() {}
		}
		if err := RunConjurLoginConsole(os.Args[2:]); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	case "login":
		for _, file := range []*os.File{os.Stdin, os.Stdout, os.Stderr} {
			var mode uint32
			if err := windows.GetConsoleMode(windows.Handle(file.Fd()), &mode); err != nil {
				_ = os.WriteFile(evidence, []byte("invalid console handles"), 0600)
				os.Exit(42)
			}
		}
		_ = os.WriteFile(evidence, []byte("login: real console handles"), 0600)
		os.Exit(0)
	}
}

func TestWindowsVendorLoginHasRealConsoleHandles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "space and Unicode \u754c")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(root, "conjur.exe")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(self)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	destination, err := os.Create(executable)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(destination, source)
	closeErr := destination.Close()
	if copyErr != nil || closeErr != nil {
		t.Fatalf("copy fixture: %v / %v", copyErr, closeErr)
	}
	identity, err := discovery.CaptureExecutableIdentity(executable)
	if err != nil {
		t.Fatal(err)
	}
	evidence := filepath.Join(root, "console.txt")
	t.Setenv("CLIHARBOR_TERMINAL_FIXTURE", evidence)
	t.Setenv("CLIHARBOR_TERMINAL_HOLD", "1")
	if err := Launch(executable, []string{"login"}, identity); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if output, err := os.ReadFile(evidence); err == nil {
			if string(output) != "login: real console handles" {
				t.Fatalf("console evidence: %s", output)
			}
			hostPID, err := os.ReadFile(evidence + ".host")
			if err != nil {
				time.Sleep(20 * time.Millisecond)
				continue
			}
			pid, err := strconv.ParseUint(string(hostPID), 10, 32)
			if err != nil {
				t.Fatal(err)
			}
			handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
			if err != nil {
				t.Fatal(err)
			}
			defer windows.CloseHandle(handle)
			defer func() {
				_ = windows.TerminateProcess(handle, 0)
				_, _ = windows.WaitForSingleObject(handle, 10000)
			}()
			wait, err := windows.WaitForSingleObject(handle, 100)
			if err != nil || wait != uint32(windows.WAIT_TIMEOUT) {
				t.Fatalf("console host did not retain the result: wait=%d, err=%v", wait, err)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("vendor login did not reach the fixture")
}

func TestWindowsConsoleHandoffRejectsChangedContent(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "conjur.exe")
	if err := os.WriteFile(executable, []byte("original"), 0700); err != nil {
		t.Fatal(err)
	}
	identity, err := discovery.CaptureExecutableIdentity(executable)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("modified"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := RunConjurLoginConsole([]string{executable, fmt.Sprintf("%x", identity.ContentSHA256())}); err == nil {
		t.Fatal("changed vendor executable was accepted")
	}
}

func TestWindowsHiddenLoginReportsImmediateFailure(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLIHARBOR_TERMINAL_FIXTURE", filepath.Join(t.TempDir(), "hidden.txt"))
	// The fixture requires a real console, so hidden launch exits non-zero.
	if err := LaunchHidden(self, []string{"login"}); err == nil {
		t.Fatal("immediately failed hidden login was reported as started")
	}
}
