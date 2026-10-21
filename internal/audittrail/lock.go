package audittrail

import (
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
)

// The marker distinguishes this OS-managed lock from the prior empty
// O_EXCL sentinel. Never assume an empty legacy lock is stale: an older
// CLIHarbor process may still own it without participating in OS locking.
const auditLockMarker = "CLIHarbor mutation audit lock v2\n"

// acquireAuditLock holds an OS lock on a permanent, private sibling file.
// Keeping the filename after Close avoids unlink/recreate races in which a
// third process could lock a new inode while another process holds the old one.
func acquireAuditLock(path string) (*os.File, error) {
	lock, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	created := err == nil
	if errors.Is(err, os.ErrExist) {
		lock, err = os.OpenFile(path, os.O_RDWR, 0)
	}
	if err != nil {
		return nil, err
	}
	fail := func(reason error) (*os.File, error) {
		_ = lock.Close()
		return nil, reason
	}

	// Check both the opened descriptor and the current path. This refuses
	// symlinks, reparse-point redirections and substitution during opening.
	verifyPath := func() error {
		opened, err := lock.Stat()
		if err != nil {
			return err
		}
		current, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !opened.Mode().IsRegular() || !current.Mode().IsRegular() ||
			current.Mode()&os.ModeSymlink != 0 || !os.SameFile(opened, current) {
			return errors.New("audit lock must be a regular unredirected file")
		}
		if runtime.GOOS != "windows" && opened.Mode().Perm()&0077 != 0 {
			return errors.New("audit lock must be private")
		}
		return nil
	}
	if err := verifyPath(); err != nil {
		return fail(err)
	}
	if err := lockAuditFile(lock); err != nil {
		return fail(fmt.Errorf("another process may hold the mutation audit lock: %w", err))
	}
	if err := verifyPath(); err != nil {
		return fail(err)
	}
	if created {
		if _, err := io.WriteString(lock, auditLockMarker); err != nil {
			return fail(fmt.Errorf("initialize mutation audit lock: %w", err))
		}
		if err := lock.Sync(); err != nil {
			return fail(fmt.Errorf("sync mutation audit lock: %w", err))
		}
	} else {
		content, err := io.ReadAll(io.LimitReader(lock, int64(len(auditLockMarker)+1)))
		if err != nil {
			return fail(fmt.Errorf("read mutation audit lock: %w", err))
		}
		if len(content) == 0 {
			return fail(errors.New("legacy mutation audit lock exists; verify no older CLIHarbor instance is running, then preserve/rename the legacy .lock file before restarting"))
		}
		if string(content) != auditLockMarker {
			return fail(errors.New("unrecognized mutation audit lock format; preserve the file for investigation"))
		}
	}
	// Also ensure the pathname has not been replaced while initializing.
	if err := verifyPath(); err != nil {
		return fail(err)
	}
	return lock, nil
}
