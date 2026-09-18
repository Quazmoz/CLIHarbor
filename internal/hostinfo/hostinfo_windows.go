//go:build windows

package hostinfo

import (
	"fmt"
	"syscall"
	"unsafe"
)

var rtlGetVersion = syscall.NewLazyDLL("ntdll.dll").NewProc("RtlGetVersion")

type rtlOSVersionInfoEx struct {
	Size             uint32
	MajorVersion     uint32
	MinorVersion     uint32
	BuildNumber      uint32
	PlatformID       uint32
	CSDVersion       [128]uint16
	ServicePackMajor uint16
	ServicePackMinor uint16
	SuiteMask        uint16
	ProductType      byte
	Reserved         byte
}

func platformVersion() string {
	info := rtlOSVersionInfoEx{}
	info.Size = uint32(unsafe.Sizeof(info))
	status, _, _ := rtlGetVersion.Call(uintptr(unsafe.Pointer(&info)))
	if status != 0 {
		return ""
	}
	return fmt.Sprintf("%d.%d.%d", info.MajorVersion, info.MinorVersion, info.BuildNumber)
}
