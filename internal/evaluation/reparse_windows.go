//go:build windows

package evaluation

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	fileAttributeReparsePoint = 0x00000400
	invalidFileAttributes     = 0xffffffff
)

var procGetFileAttributesW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFileAttributesW")

func pathIsReparsePoint(filename string) (bool, error) {
	pathUTF16, err := syscall.UTF16PtrFromString(filename)
	if err != nil {
		return false, fmt.Errorf("encode filesystem path: %w", err)
	}
	attributes, _, callErr := procGetFileAttributesW.Call(uintptr(unsafe.Pointer(pathUTF16)))
	if uint32(attributes) == invalidFileAttributes {
		if callErr != syscall.Errno(0) {
			return false, callErr
		}
		return false, fmt.Errorf("GetFileAttributesW failed without a system error")
	}
	return uint32(attributes)&fileAttributeReparsePoint != 0, nil
}
