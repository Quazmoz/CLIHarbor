//go:build windows

package diagnostics

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	moveFileWriteThrough      = 0x00000008
	fileAttributeReparsePoint = 0x00000400
	invalidFileAttributes     = 0xFFFFFFFF
)

var (
	kernel32Diagnostics          = syscall.NewLazyDLL("kernel32.dll")
	procDiagnosticsMoveFileExW   = kernel32Diagnostics.NewProc("MoveFileExW")
	procDiagnosticsGetFileAttrsW = kernel32Diagnostics.NewProc("GetFileAttributesW")
)

func validateExportParent(path string) error {
	pathUTF16, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return fmt.Errorf("encode diagnostics export directory: %w", err)
	}
	attributes, _, callErr := procDiagnosticsGetFileAttrsW.Call(uintptr(unsafe.Pointer(pathUTF16)))
	if uint32(attributes) == invalidFileAttributes {
		if callErr != syscall.Errno(0) {
			return fmt.Errorf("inspect diagnostics export directory attributes: %w", callErr)
		}
		return fmt.Errorf("inspect diagnostics export directory attributes")
	}
	if uint32(attributes)&fileAttributeReparsePoint != 0 {
		return fmt.Errorf("diagnostics export parent must not be a Windows reparse point")
	}
	return nil
}

func activateDiagnosticsBundle(stagingPath, destinationPath string) error {
	stagingUTF16, err := syscall.UTF16PtrFromString(stagingPath)
	if err != nil {
		return fmt.Errorf("encode diagnostics staging path: %w", err)
	}
	destinationUTF16, err := syscall.UTF16PtrFromString(destinationPath)
	if err != nil {
		return fmt.Errorf("encode diagnostics destination path: %w", err)
	}
	result, _, callErr := procDiagnosticsMoveFileExW.Call(
		uintptr(unsafe.Pointer(stagingUTF16)),
		uintptr(unsafe.Pointer(destinationUTF16)),
		uintptr(moveFileWriteThrough),
	)
	if result != 0 {
		return nil
	}
	if callErr != syscall.Errno(0) {
		return callErr
	}
	return fmt.Errorf("MoveFileExW failed without a system error")
}
