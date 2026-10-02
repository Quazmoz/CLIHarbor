//go:build windows

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func platformSupported() bool {
	return true
}

func launchPlatform(executable string, args []string) error {
	applicationName, err := windows.UTF16PtrFromString(executable)
	if err != nil {
		return fmt.Errorf("encode vendor executable path: %w", err)
	}
	commandLine := windows.ComposeCommandLine(append([]string{executable}, args...))
	commandLinePtr, err := windows.UTF16PtrFromString(commandLine)
	if err != nil {
		return fmt.Errorf("encode vendor command line: %w", err)
	}

	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return fmt.Errorf("resolve current-user home for vendor terminal")
	}
	currentDirectory, err := windows.UTF16PtrFromString(home)
	if err != nil {
		return fmt.Errorf("encode vendor terminal working directory: %w", err)
	}

	startupInfo := &windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{}))}
	processInfo := &windows.ProcessInformation{}
	if err := windows.CreateProcess(
		applicationName,
		commandLinePtr,
		nil,
		nil,
		false,
		windows.CREATE_NEW_CONSOLE,
		nil,
		currentDirectory,
		startupInfo,
		processInfo,
	); err != nil {
		return fmt.Errorf("launch vendor terminal: %w", err)
	}
	// The external terminal/process is intentionally vendor/operator owned after
	// launch. Closing our handles prevents CLIHarbor from retaining process
	// authority while the vendor CLI owns prompts, browser handoff, and session storage.
	_ = windows.CloseHandle(processInfo.Thread)
	_ = windows.CloseHandle(processInfo.Process)
	return nil
}

// hiddenLoginTimeout bounds an abandoned hidden login (for example an OIDC
// browser flow the operator never finished) so it cannot hold the vendor's
// callback listener or linger invisibly.
const hiddenLoginTimeout = 10 * time.Minute

// hiddenLogin tracks the single in-flight hidden vendor login. A retry
// supersedes it; otherwise the stale process would keep the OIDC callback port.
// ponytail: not tied to a job object, so a hidden login still running when
// CLIHarbor exits is no longer bounded by the timeout; assign it to a job with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE if that matters.
var hiddenLogin struct {
	sync.Mutex
	process *os.Process
	done    chan struct{}
}

func launchHiddenPlatform(executable string, args []string) error {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return fmt.Errorf("resolve current-user home for vendor login")
	}

	cmd := exec.Command(executable, args...)
	cmd.Dir = home
	// Nil stdin/stdout/stderr are connected to the null device by os/exec.
	// CREATE_NO_WINDOW prevents the transient console flash while leaving OIDC
	// browser handoff and JWT authentication fully owned by the vendor process.
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW,
	}

	hiddenLogin.Lock()
	defer hiddenLogin.Unlock()
	if hiddenLogin.process != nil {
		_ = hiddenLogin.process.Kill()
		select {
		case <-hiddenLogin.done:
		case <-time.After(2 * time.Second):
		}
		hiddenLogin.process = nil
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("launch hidden vendor login: %w", err)
	}
	// Start succeeding is the authoritative launch event. Supervision below only
	// reaps or bounds the vendor-owned process; it never reports back as a launch
	// failure because that could duplicate an already-running authentication flow.
	done := make(chan struct{})
	hiddenLogin.process = cmd.Process
	hiddenLogin.done = done
	go func() {
		timer := time.AfterFunc(hiddenLoginTimeout, func() { _ = cmd.Process.Kill() })
		_ = cmd.Wait()
		timer.Stop()
		close(done)
		hiddenLogin.Lock()
		if hiddenLogin.process == cmd.Process {
			hiddenLogin.process = nil
		}
		hiddenLogin.Unlock()
	}()
	return nil
}
