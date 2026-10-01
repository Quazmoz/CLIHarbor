//go:build windows

package terminal

import (
	"fmt"
	"os"
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
