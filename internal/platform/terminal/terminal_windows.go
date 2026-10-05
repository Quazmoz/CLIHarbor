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

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"golang.org/x/sys/windows"
)

func platformSupported() bool {
	return true
}

func launchPlatform(executable string, args []string, identity discovery.ExecutableIdentity) error {
	if len(args) != 1 || args[0] != "login" {
		return fmt.Errorf("unsupported vendor console command")
	}
	host, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve vendor console host: %w", err)
	}
	applicationName, err := windows.UTF16PtrFromString(host)
	if err != nil {
		return fmt.Errorf("encode vendor executable path: %w", err)
	}
	commandLine := windows.ComposeCommandLine([]string{host, "_conjur-login-console", executable, fmt.Sprintf("%x", identity.ContentSHA256())})
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
	// The host owns only console setup and dismissal. The vendor owns every
	// credential interaction; none is redirected through the browser/backend.
	_ = windows.CloseHandle(processInfo.Thread)
	defer windows.CloseHandle(processInfo.Process)
	// Catch a broken handoff without holding the HTTP request open for login.
	wait, err := windows.WaitForSingleObject(processInfo.Process, 500)
	if err != nil {
		return nil // The process already started; do not suggest a duplicate launch.
	}
	if wait == windows.WAIT_OBJECT_0 {
		var code uint32
		if windows.GetExitCodeProcess(processInfo.Process, &code) == nil && code != 0 {
			return fmt.Errorf("vendor console host exited before login")
		}
	}
	return nil
}

func runConjurLoginConsolePlatform(executable string, identity discovery.ExecutableIdentity) error {
	// Explicit console devices prevent GUI-launcher/null standard handles from
	// making vendor password/MFA prompts fail as non-interactive input.
	input, err := os.OpenFile("CONIN$", os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open vendor console input: %w", err)
	}
	defer input.Close()
	output, err := os.OpenFile("CONOUT$", os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open vendor console output: %w", err)
	}
	defer output.Close()
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return fmt.Errorf("resolve vendor console working directory")
	}
	if !identity.Matches(executable) {
		return fmt.Errorf("vendor executable identity changed")
	}
	cmd := exec.Command(executable, "login")
	cmd.Dir = home
	cmd.Stdin, cmd.Stdout, cmd.Stderr = input, output, output
	// The vendor attaches to this real console. No shell, pipes, credential
	// buffering, or keystroke injection are involved.
	err = cmd.Run()
	if err != nil {
		fmt.Fprintln(output, "\nConjur sign-in did not complete. Review the vendor message above.")
	} else {
		fmt.Fprintln(output, "\nConjur login finished. Return to CLIHarbor and check your session.")
	}
	fmt.Fprintln(output, "Close this window when you are ready to return to CLIHarbor.")
	waitForConsoleClose()
	return err
}

var waitForConsoleClose = func() {
	// Native window close terminates the host. Never read console input here,
	// including any credential keystrokes left buffered after the vendor exits.
	_, _ = windows.WaitForSingleObject(windows.CurrentProcess(), windows.INFINITE)
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
	// Report a fast non-zero exit, without capturing vendor output or waiting
	// for the browser interaction. A live flow is acknowledged only once.
	done := make(chan struct{})
	var waitErr error
	hiddenLogin.process = cmd.Process
	hiddenLogin.done = done
	go func() {
		timer := time.AfterFunc(hiddenLoginTimeout, func() { _ = cmd.Process.Kill() })
		waitErr = cmd.Wait()
		timer.Stop()
		close(done)
		hiddenLogin.Lock()
		if hiddenLogin.process == cmd.Process {
			hiddenLogin.process = nil
		}
		hiddenLogin.Unlock()
	}()
	select {
	case <-done:
		if waitErr != nil {
			return fmt.Errorf("vendor login exited before authentication")
		}
	case <-time.After(500 * time.Millisecond):
	}
	return nil
}
