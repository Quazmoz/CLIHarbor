//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

const checksumMoveFileWriteThrough = 0x00000008

var procMoveChecksumFileExW = syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")

// activateChecksumFile publishes a completed same-directory staging file
// without replacing an existing destination.
func activateChecksumFile(stagingPath, destinationPath string) error {
	stagingUTF16, err := syscall.UTF16PtrFromString(stagingPath)
	if err != nil {
		return fmt.Errorf("encode checksum staging path: %w", err)
	}
	destinationUTF16, err := syscall.UTF16PtrFromString(destinationPath)
	if err != nil {
		return fmt.Errorf("encode checksum destination path: %w", err)
	}
	result, _, callErr := procMoveChecksumFileExW.Call(
		uintptr(unsafe.Pointer(stagingUTF16)),
		uintptr(unsafe.Pointer(destinationUTF16)),
		uintptr(checksumMoveFileWriteThrough),
	)
	if result != 0 {
		return nil
	}
	if callErr != syscall.Errno(0) {
		return callErr
	}
	return fmt.Errorf("MoveFileExW failed without a system error")
}
