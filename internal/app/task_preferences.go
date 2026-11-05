package app

import (
	"io"
	"os"
	"path/filepath"
	"sync"
)

const maxTaskPreferenceFileBytes = 16 << 10

// taskPreferencesStore keeps the browser's favorite/recent task identities in
// the per-user config directory. The server validates the document on both
// read and write; this store only bounds and places the bytes.
type taskPreferencesStore struct {
	path string
	mu   sync.Mutex
}

func newTaskPreferencesStore() *taskPreferencesStore {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return &taskPreferencesStore{}
	}
	return &taskPreferencesStore{path: filepath.Join(configDir, "CLIHarbor", "task-preferences.json")}
}

func (s *taskPreferencesStore) Load() []byte {
	if s.path == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Lstat(s.path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil
	}
	file, err := os.Open(s.path)
	if err != nil {
		return nil
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxTaskPreferenceFileBytes+1))
	if err != nil || len(data) > maxTaskPreferenceFileBytes {
		return nil
	}
	return data
}

func (s *taskPreferencesStore) Save(data []byte) error {
	if s.path == "" {
		return os.ErrNotExist
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return writePrivateFileAtomic(s.path, ".task-preferences-*.tmp", data)
}
