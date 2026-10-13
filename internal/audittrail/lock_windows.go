//go:build windows

package audittrail

import (
	"os"

	"golang.org/x/sys/windows"
)

// Windows releases byte-range locks when the handle closes or the process dies.
func lockAuditFile(file *os.File) error {
	return windows.LockFileEx(
		windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &windows.Overlapped{},
	)
}
