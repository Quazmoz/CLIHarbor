package app

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

const managedInstallLocationSchemaVersion = 1

type managedInstallLocationFile struct {
	Version int               `json:"version"`
	Tools   map[string]string `json:"tools"`
}

type managedInstallLocationStore struct {
	path    string
	homeDir string
	mu      sync.Mutex
}

func newManagedInstallLocationStore() (*managedInstallLocationStore, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return &managedInstallLocationStore{
		path:    filepath.Join(configDir, "CLIHarbor", "managed-install-locations.json"),
		homeDir: homeDir,
	}, nil
}

func newManagedInstallLocationStoreAt(path, homeDir string) *managedInstallLocationStore {
	return &managedInstallLocationStore{path: path, homeDir: homeDir}
}

func (s *managedInstallLocationStore) Load() map[discovery.ToolRef]string {
	if s == nil || s.path == "" || s.homeDir == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	info, statErr := os.Lstat(s.path)
	if statErr != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil
	}
	data, err := os.ReadFile(s.path)
	if err != nil || len(data) == 0 || len(data) > 64<<10 {
		return nil
	}
	var file managedInstallLocationFile
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil || file.Version != managedInstallLocationSchemaVersion {
		return nil
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil
	}
	result := make(map[discovery.ToolRef]string)
	for key, rawRoot := range file.Tools {
		ref, ok := parseManagedInstallRef(key)
		if !ok {
			continue
		}
		root, ok := validateManagedInstallRoot(rawRoot, s.homeDir)
		if !ok {
			continue
		}
		result[ref] = root
	}
	return result
}

func (s *managedInstallLocationStore) Save(ref discovery.ToolRef, root string) error {
	if s == nil {
		return nil
	}
	root, ok := validateManagedInstallRoot(root, s.homeDir)
	if !ok {
		return os.ErrPermission
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	current := managedInstallLocationFile{
		Version: managedInstallLocationSchemaVersion,
		Tools:   map[string]string{},
	}
	if data, err := os.ReadFile(s.path); err == nil && len(data) <= 64<<10 {
		var existing managedInstallLocationFile
		decoder := json.NewDecoder(strings.NewReader(string(data)))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&existing) == nil && existing.Version == managedInstallLocationSchemaVersion {
			for key, value := range existing.Tools {
				if parsed, ok := parseManagedInstallRef(key); ok {
					if validated, valid := validateManagedInstallRoot(value, s.homeDir); valid {
						current.Tools[parsed.String()] = validated
					}
				}
			}
		}
	}
	current.Tools[ref.String()] = root

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	if info, err := os.Lstat(s.path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return os.ErrPermission
		}
	}
	keys := make([]string, 0, len(current.Tools))
	for key := range current.Tools {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	ordered := managedInstallLocationFile{Version: current.Version, Tools: make(map[string]string, len(keys))}
	for _, key := range keys {
		ordered.Tools[key] = current.Tools[key]
	}
	data, err := json.MarshalIndent(ordered, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	temp, err := os.CreateTemp(filepath.Dir(s.path), ".managed-install-locations-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	keep := false
	defer func() {
		_ = temp.Close()
		if !keep {
			_ = os.Remove(tempPath)
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temp.Write(data); err != nil {
		return err
	}
	if err := temp.Sync(); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, s.path); err != nil {
		if removeErr := os.Remove(s.path); removeErr != nil && !os.IsNotExist(removeErr) {
			return err
		}
		if err := os.Rename(tempPath, s.path); err != nil {
			return err
		}
	}
	keep = true
	return nil
}

func parseManagedInstallRef(value string) (discovery.ToolRef, bool) {
	parts := strings.Split(value, "/")
	if len(parts) != 2 || !validManagedInstallID(parts[0]) || !validManagedInstallID(parts[1]) {
		return discovery.ToolRef{}, false
	}
	return discovery.ToolRef{PackID: parts[0], ToolID: parts[1]}, true
}

func validManagedInstallID(value string) bool {
	if len(value) == 0 || len(value) > 63 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, r := range value[1:] {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return true
}

func validateManagedInstallRoot(value, homeDir string) (string, bool) {
	if value == "" || strings.ContainsRune(value, '\x00') || !filepath.IsAbs(value) {
		return "", false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return "", false
		}
	}
	root, err := filepath.Abs(filepath.Clean(value))
	if err != nil {
		return "", false
	}
	home, err := filepath.Abs(filepath.Clean(homeDir))
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(home, root)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}

	resolvedHome := home
	if resolved, resolveErr := filepath.EvalSymlinks(home); resolveErr == nil {
		resolvedHome = filepath.Clean(resolved)
	}
	ancestor := root
	for {
		info, statErr := os.Lstat(ancestor)
		if statErr == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				resolved, resolveErr := filepath.EvalSymlinks(ancestor)
				if resolveErr != nil {
					return "", false
				}
				ancestor = filepath.Clean(resolved)
			} else if !info.IsDir() {
				return "", false
			}
			break
		}
		if !os.IsNotExist(statErr) {
			return "", false
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", false
		}
		ancestor = parent
	}
	resolvedAncestor, resolveErr := filepath.EvalSymlinks(ancestor)
	if resolveErr != nil {
		return "", false
	}
	relResolved, err := filepath.Rel(resolvedHome, filepath.Clean(resolvedAncestor))
	if err != nil || relResolved == ".." || strings.HasPrefix(relResolved, ".."+string(filepath.Separator)) {
		return "", false
	}
	return root, true
}
