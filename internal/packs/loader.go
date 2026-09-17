package packs

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Loader struct {
	maxBytes int64
}

func NewLoader() *Loader {
	return &Loader{maxBytes: MaxPackBytes}
}

func (l *Loader) LoadBuiltins(files map[string][]byte) (*Registry, error) {
	if l == nil {
		l = NewLoader()
	}
	names := sortedKeys(files)
	loaded := make([]LoadedPack, 0, len(names))
	for _, name := range names {
		data := files[name]
		if int64(len(data)) > l.maxBytes {
			return nil, &LoadError{Source: Source{Kind: SourceBuiltin, Name: name}, Err: validationError(ErrInputTooLarge, "", fmt.Sprintf("pack exceeds %d-byte limit", l.maxBytes))}
		}
		pack, err := Parse(data)
		if err != nil {
			return nil, &LoadError{Source: Source{Kind: SourceBuiltin, Name: name}, Err: err}
		}
		loaded = append(loaded, LoadedPack{Source: Source{Kind: SourceBuiltin, Name: name}, Pack: pack})
	}
	return NewRegistry(loaded)
}

func (l *Loader) LoadFiles(paths []string) (*Registry, error) {
	if l == nil {
		l = NewLoader()
	}
	canonical, err := canonicalizePaths(paths)
	if err != nil {
		return nil, err
	}
	loaded := make([]LoadedPack, 0, len(canonical))
	for _, path := range canonical {
		pack, err := l.loadLocalFile(path)
		if err != nil {
			return nil, err
		}
		loaded = append(loaded, pack)
	}
	return NewRegistry(loaded)
}

func (l *Loader) LoadDirectory(directory string) (*Registry, error) {
	if l == nil {
		l = NewLoader()
	}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return nil, fmt.Errorf("resolve explicit pack directory: %w", err)
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return nil, safeLocalIOError(fmt.Sprintf("inspect explicit pack directory %q", filepath.Base(absolute)), err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, validationError(ErrUnsupportedLocalEntry, filepath.Base(absolute), "explicit pack directory must be a real directory, not a symlink")
	}
	entries, err := os.ReadDir(absolute)
	if err != nil {
		return nil, safeLocalIOError(fmt.Sprintf("read explicit pack directory %q", filepath.Base(absolute)), err)
	}
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		extension := strings.ToLower(filepath.Ext(entry.Name()))
		if extension != ".yaml" && extension != ".yml" {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() || !entry.Type().IsRegular() {
			return nil, validationError(ErrUnsupportedLocalEntry, entry.Name(), "pack directory may contain only regular YAML pack files")
		}
		paths = append(paths, filepath.Join(absolute, entry.Name()))
	}
	sort.Strings(paths)
	return l.LoadFiles(paths)
}

func (l *Loader) loadLocalFile(path string) (LoadedPack, error) {
	source := Source{Kind: SourceExplicitLocal, Name: path}
	before, err := os.Lstat(path)
	if err != nil {
		return LoadedPack{}, &LoadError{Source: source, Err: safeLocalIOError("inspect local pack", err)}
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() {
		return LoadedPack{}, &LoadError{Source: source, Err: validationError(ErrUnsupportedLocalEntry, filepath.Base(path), "explicit local pack must be a regular file, not a symlink")}
	}

	file, err := os.Open(path)
	if err != nil {
		return LoadedPack{}, &LoadError{Source: source, Err: safeLocalIOError("open local pack", err)}
	}
	defer file.Close()

	afterOpen, err := file.Stat()
	if err != nil {
		return LoadedPack{}, &LoadError{Source: source, Err: safeLocalIOError("inspect opened local pack", err)}
	}
	if !os.SameFile(before, afterOpen) {
		return LoadedPack{}, &LoadError{Source: source, Err: validationError(ErrUnsupportedLocalEntry, filepath.Base(path), "local pack changed while opening")}
	}
	if afterOpen.Size() > l.maxBytes {
		return LoadedPack{}, &LoadError{Source: source, Err: validationError(ErrInputTooLarge, "", fmt.Sprintf("pack exceeds %d-byte limit", l.maxBytes))}
	}

	data, err := io.ReadAll(io.LimitReader(file, l.maxBytes+1))
	if err != nil {
		return LoadedPack{}, &LoadError{Source: source, Err: safeLocalIOError("read local pack", err)}
	}
	if int64(len(data)) > l.maxBytes {
		return LoadedPack{}, &LoadError{Source: source, Err: validationError(ErrInputTooLarge, "", fmt.Sprintf("pack exceeds %d-byte limit", l.maxBytes))}
	}
	afterRead, err := file.Stat()
	if err != nil {
		return LoadedPack{}, &LoadError{Source: source, Err: safeLocalIOError("reinspect local pack", err)}
	}
	if !os.SameFile(afterOpen, afterRead) || afterRead.Size() != int64(len(data)) || !afterOpen.ModTime().Equal(afterRead.ModTime()) {
		return LoadedPack{}, &LoadError{Source: source, Err: validationError(ErrUnsupportedLocalEntry, filepath.Base(path), "local pack changed while reading")}
	}

	pack, err := Parse(data)
	if err != nil {
		return LoadedPack{}, &LoadError{Source: source, Err: err}
	}
	return LoadedPack{Source: source, Pack: pack}, nil
}

func canonicalizePaths(paths []string) ([]string, error) {
	canonical := make([]string, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, fmt.Errorf("resolve explicit local pack path: %w", err)
		}
		absolute = filepath.Clean(absolute)
		key := absolute
		if runtimeCaseInsensitivePaths() {
			key = strings.ToLower(key)
		}
		if _, exists := seen[key]; exists {
			return nil, validationError(ErrDuplicatePack, filepath.Base(absolute), "same explicit local pack path was provided more than once")
		}
		seen[key] = struct{}{}
		canonical = append(canonical, absolute)
	}
	sort.Strings(canonical)
	return canonical, nil
}

func safeLocalIOError(operation string, err error) error {
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return fmt.Errorf("%s: %w", operation, pathErr.Err)
	}
	return fmt.Errorf("%s: %w", operation, err)
}
