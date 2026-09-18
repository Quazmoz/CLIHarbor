package discovery

import (
	"os"
	"time"
)

// ExecutableIdentity is an in-memory discovery-time identity for a resolved executable.
// It is deliberately not serialized: callers must obtain it from the authoritative
// discovery snapshot created in this process.
type ExecutableIdentity struct {
	info    os.FileInfo
	size    int64
	modTime time.Time
}

func CaptureExecutableIdentity(path string) (ExecutableIdentity, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return ExecutableIdentity{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return ExecutableIdentity{}, os.ErrInvalid
	}
	return ExecutableIdentity{info: info, size: info.Size(), modTime: info.ModTime()}, nil
}

func (i ExecutableIdentity) Valid() bool {
	return i.info != nil
}

func (i ExecutableIdentity) Matches(path string) bool {
	if i.info == nil {
		return false
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return false
	}
	return os.SameFile(i.info, info) && i.size == info.Size() && i.modTime.Equal(info.ModTime())
}
