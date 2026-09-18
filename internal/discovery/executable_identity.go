package discovery

import (
	"crypto/sha256"
	"io"
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
	digest  [sha256.Size]byte
}

func CaptureExecutableIdentity(path string) (ExecutableIdentity, error) {
	info, digest, err := inspectExecutableIdentity(path)
	if err != nil {
		return ExecutableIdentity{}, err
	}
	return ExecutableIdentity{
		info:    info,
		size:    info.Size(),
		modTime: info.ModTime(),
		digest:  digest,
	}, nil
}

func (i ExecutableIdentity) Valid() bool {
	return i.info != nil
}

func (i ExecutableIdentity) Matches(path string) bool {
	if i.info == nil {
		return false
	}
	info, digest, err := inspectExecutableIdentity(path)
	if err != nil {
		return false
	}
	return os.SameFile(i.info, info) &&
		i.size == info.Size() &&
		i.modTime.Equal(info.ModTime()) &&
		i.digest == digest
}

func inspectExecutableIdentity(path string) (os.FileInfo, [sha256.Size]byte, error) {
	var digest [sha256.Size]byte

	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, digest, err
	}
	if pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() {
		return nil, digest, os.ErrInvalid
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, digest, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, digest, err
	}
	if !info.Mode().IsRegular() || !os.SameFile(pathInfo, info) {
		return nil, digest, os.ErrInvalid
	}

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return nil, digest, err
	}
	copy(digest[:], hasher.Sum(nil))
	return info, digest, nil
}
