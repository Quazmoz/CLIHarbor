//go:build windows

package evidence

import (
	"fmt"
	"syscall"
	"unsafe"
)

const moveFileWriteThrough = 0x00000008

var procMoveFileExW = syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")

// activateEvidenceBundle publishes a completed same-directory staging file
// without replacing an existing destination. MOVEFILE_REPLACE_EXISTING is
// deliberately omitted so an already-present evidence path fails closed.
func activateEvidenceBundle(stagingPath, destinationPath string) error {
	stagingUTF16, err := syscall.UTF16PtrFromString(stagingPath)
	if err != nil {
		return fmt.Errorf("encode evidence staging path: %w", err)
	}
	destinationUTF16, err := syscall.UTF16PtrFromString(destinationPath)
	if err != nil {
		return fmt.Errorf("encode evidence destination path: %w", err)
	}
	result, _, callErr := procMoveFileExW.Call(
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
