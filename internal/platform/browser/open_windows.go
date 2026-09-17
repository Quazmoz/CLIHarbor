//go:build windows

package browser

import (
	"fmt"
	"syscall"
	"unsafe"
)

var shellExecuteW = syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")

func openSystemBrowser(rawURL string) error {
	operation, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return fmt.Errorf("prepare browser launch operation: %w", err)
	}
	target, err := syscall.UTF16PtrFromString(rawURL)
	if err != nil {
		return fmt.Errorf("prepare browser launch target: %w", err)
	}

	result, _, _ := shellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(operation)),
		uintptr(unsafe.Pointer(target)),
		0,
		0,
		1, // SW_SHOWNORMAL
	)
	if result <= 32 {
		return fmt.Errorf("Windows default-browser launch failed with ShellExecute code %d", result)
	}
	return nil
}
