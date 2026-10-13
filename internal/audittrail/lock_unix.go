//go:build !windows

package audittrail

import (
	"os"

	"golang.org/x/sys/unix"
)

// flock locks are released by the kernel on close or process termination.
func lockAuditFile(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
}
