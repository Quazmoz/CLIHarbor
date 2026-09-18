package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

const (
	evaluationManifestName   = "EVALUATION_SHA256SUMS"
	evaluationExecutablePath = "bin/cliharbor-windows-x64-evaluation.exe"
	evaluationPackPath       = "packs/phase0/idira-cyberark-inventory.yaml"
	maxEvaluationManifest    = 16 << 10
)

var evaluationRequiredPaths = []string{
	evaluationExecutablePath,
	evaluationPackPath,
}

func removeGeneratedChecksum(filename string) error {
	info, err := os.Lstat(filename)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("inspect generated checksum %s: %w", filepath.Base(filename), err)
	}
	if info.IsDir() {
		return fmt.Errorf("generated checksum path %s is a directory", filepath.Base(filename))
	}
	if err := os.Remove(filename); err != nil {
		return fmt.Errorf("invalidate generated checksum %s: %w", filepath.Base(filename), err)
	}
	return nil
}

func verifyWindowsEvaluation(root string) error {
	compatibilityManifest := filepath.Join(root, "bin", "SHA256SUMS")
	if _, err := os.Lstat(compatibilityManifest); err == nil {
		return fmt.Errorf("evaluation bundle must not contain compatibility checksum bin/SHA256SUMS")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect compatibility checksum: %w", err)
	}

	manifestPath := filepath.Join(root, evaluationManifestName)
	content, err := readStableRegularFile(manifestPath, maxEvaluationManifest)
	if err != nil {
		return fmt.Errorf("read evaluation checksum manifest: %w", err)
	}
	entries, err := parseEvaluationManifest(content)
	if err != nil {
		return err
	}
	if len(entries) != len(evaluationRequiredPaths) {
		return fmt.Errorf("evaluation checksum manifest has %d entries, want %d", len(entries), len(evaluationRequiredPaths))
	}

	for _, name := range evaluationRequiredPaths {
		expected, ok := entries[name]
		if !ok {
			return fmt.Errorf("evaluation checksum manifest missing required path %s", name)
		}
		filename := filepath.Join(root, filepath.FromSlash(name))
		info, err := os.Lstat(filename)
		if err != nil {
			return fmt.Errorf("inspect evaluation artifact %s: %w", name, err)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("evaluation artifact %s must be a regular non-symlink file", name)
		}
		digest, err := sha256File(filename, info)
		if err != nil {
			return fmt.Errorf("verify evaluation artifact %s: %w", name, err)
		}
		actual := hex.EncodeToString(digest)
		if actual != expected {
			return fmt.Errorf("evaluation bundle checksum mismatch for %s", name)
		}
	}
	return nil
}

func parseEvaluationManifest(content []byte) (map[string]string, error) {
	if len(content) == 0 {
		return nil, fmt.Errorf("evaluation checksum manifest is empty")
	}
	text := string(content)
	if strings.ContainsRune(text, '\r') || !strings.HasSuffix(text, "\n") {
		return nil, fmt.Errorf("evaluation checksum manifest must use canonical LF-terminated lines")
	}

	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	entries := make(map[string]string, len(lines))
	seen := make(map[string]struct{}, len(lines))
	names := make([]string, 0, len(lines))
	for _, line := range lines {
		if len(line) < 67 || line[64:66] != "  " {
			return nil, fmt.Errorf("invalid evaluation checksum manifest line")
		}
		digest := line[:64]
		decoded, err := hex.DecodeString(digest)
		if err != nil || len(decoded) != sha256.Size || strings.ToLower(digest) != digest {
			return nil, fmt.Errorf("invalid evaluation checksum digest")
		}

		name := line[66:]
		if name == "" || strings.Contains(name, "\\") || strings.Contains(name, ":") ||
			path.IsAbs(name) || path.Clean(name) != name || name == "." ||
			name == ".." || strings.HasPrefix(name, "../") {
			return nil, fmt.Errorf("invalid evaluation checksum path")
		}
		key := strings.ToLower(name)
		if _, exists := seen[key]; exists {
			return nil, fmt.Errorf("duplicate evaluation checksum path %s", name)
		}
		seen[key] = struct{}{}
		entries[name] = digest
		names = append(names, name)
	}
	if !sort.StringsAreSorted(names) {
		return nil, fmt.Errorf("evaluation checksum manifest paths must be sorted")
	}
	return entries, nil
}

func readStableRegularFile(filename string, maxBytes int64) ([]byte, error) {
	expected, err := os.Lstat(filename)
	if err != nil {
		return nil, err
	}
	if expected.Mode()&os.ModeSymlink != 0 || !expected.Mode().IsRegular() {
		return nil, fmt.Errorf("file must be a regular non-symlink file")
	}
	if expected.Size() < 0 || expected.Size() > maxBytes {
		return nil, fmt.Errorf("file exceeds %d byte limit", maxBytes)
	}

	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if !opened.Mode().IsRegular() || !os.SameFile(expected, opened) ||
		expected.Size() != opened.Size() || !expected.ModTime().Equal(opened.ModTime()) {
		_ = file.Close()
		return nil, fmt.Errorf("file changed before read")
	}

	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	middle, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		_ = file.Close()
		return nil, fmt.Errorf("file exceeds %d byte limit", maxBytes)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return nil, err
	}
	second, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	finished, statErr := file.Stat()
	closeErr := file.Close()
	if statErr != nil {
		return nil, statErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if int64(len(second)) > maxBytes {
		return nil, fmt.Errorf("file exceeds %d byte limit", maxBytes)
	}

	current, err := os.Lstat(filename)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(data, second) ||
		current.Mode()&os.ModeSymlink != 0 || !current.Mode().IsRegular() ||
		!os.SameFile(opened, current) ||
		opened.Size() != middle.Size() || !opened.ModTime().Equal(middle.ModTime()) ||
		middle.Size() != finished.Size() || !middle.ModTime().Equal(finished.ModTime()) ||
		finished.Size() != current.Size() || !finished.ModTime().Equal(current.ModTime()) {
		return nil, fmt.Errorf("file changed while read")
	}
	return data, nil
}
