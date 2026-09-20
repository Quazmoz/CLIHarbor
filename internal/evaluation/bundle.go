package evaluation

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

const (
	ManifestName        = "EVALUATION_SHA256SUMS"
	ExecutablePath      = "bin/cliharbor-windows-x64-evaluation.exe"
	PackPath            = "packs/phase0/idira-cyberark-inventory.yaml"
	MaxManifestBytes    = 16 << 10
	MaxPackBytes        = packs.MaxPackBytes
	ExpectedVersion     = "0.0.0-eval"
	ExpectedBuildMode   = "evaluation-unsigned"
	ExpectedPackID      = "idira-cyberark-phase0"
	ExpectedPackVersion = "0.1.0"
)

var requiredPaths = []string{ExecutablePath, PackPath}

func RequiredPaths() []string { return append([]string(nil), requiredPaths...) }

func VerifyBundle(root string) error {
	entries, err := readVerifiedManifest(root)
	if err != nil {
		return err
	}
	if err := verifyFileDigest(root, ExecutablePath, entries[ExecutablePath]); err != nil {
		return err
	}
	content, err := readVerifiedFileBytes(root, PackPath, entries[PackPath], MaxPackBytes)
	if err != nil {
		return err
	}
	return VerifyPhase0PackBytes(content)
}

func VerifyIntegrity(root string) error {
	entries, err := readVerifiedManifest(root)
	if err != nil {
		return err
	}
	for _, name := range requiredPaths {
		if err := verifyFileDigest(root, name, entries[name]); err != nil {
			return err
		}
	}
	return nil
}

func readVerifiedManifest(root string) (map[string]string, error) {
	compatibilityManifest := filepath.Join(root, "bin", "SHA256SUMS")
	if _, err := os.Lstat(compatibilityManifest); err == nil {
		return nil, fmt.Errorf("evaluation bundle must not contain compatibility checksum bin/SHA256SUMS")
	} else if !os.IsNotExist(err) {
		return nil, safeIOError("inspect compatibility checksum", err)
	}

	manifestPath := filepath.Join(root, ManifestName)
	content, err := ReadStableRegularFile(manifestPath, MaxManifestBytes)
	if err != nil {
		return nil, safeIOError("read evaluation checksum manifest", err)
	}
	entries, err := ParseManifest(content)
	if err != nil {
		return nil, err
	}
	if len(entries) != len(requiredPaths) {
		return nil, fmt.Errorf("evaluation checksum manifest has %d entries, want %d", len(entries), len(requiredPaths))
	}
	for _, name := range requiredPaths {
		if _, ok := entries[name]; !ok {
			return nil, fmt.Errorf("evaluation checksum manifest missing required path %s", name)
		}
	}
	return entries, nil
}

func verifyFileDigest(root, name, expected string) error {
	filename := filepath.Join(root, filepath.FromSlash(name))
	info, err := os.Lstat(filename)
	if err != nil {
		return safeIOError("inspect evaluation artifact "+name, err)
	}
	if err := validateRegularPath(filename, info); err != nil {
		return fmt.Errorf("evaluation artifact %s: %w", name, err)
	}
	digest, err := SHA256StableFile(filename, info)
	if err != nil {
		return safeIOError("verify evaluation artifact "+name, err)
	}
	if !digestMatches(digest, expected) {
		return fmt.Errorf("evaluation bundle checksum mismatch for %s", name)
	}
	return nil
}

func readVerifiedFileBytes(root, name, expected string, maxBytes int64) ([]byte, error) {
	filename := filepath.Join(root, filepath.FromSlash(name))
	content, err := ReadStableRegularFile(filename, maxBytes)
	if err != nil {
		return nil, safeIOError("read evaluation artifact "+name, err)
	}
	digest := sha256.Sum256(content)
	if !digestMatches(digest[:], expected) {
		return nil, fmt.Errorf("evaluation bundle checksum mismatch for %s", name)
	}
	return content, nil
}

func digestMatches(actual []byte, expectedHex string) bool {
	expected, err := hex.DecodeString(expectedHex)
	if err != nil || len(expected) != sha256.Size || len(actual) != sha256.Size {
		return false
	}
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func VerifyPhase0Pack(root string) error {
	filename := filepath.Join(root, filepath.FromSlash(PackPath))
	content, err := ReadStableRegularFile(filename, MaxPackBytes)
	if err != nil {
		return safeIOError("read packaged Phase 0 pack", err)
	}
	return VerifyPhase0PackBytes(content)
}

func VerifyPhase0PackBytes(content []byte) error {
	pack, err := packs.Parse(content)
	if err != nil {
		return fmt.Errorf("packaged Phase 0 pack is invalid: %w", err)
	}
	if pack.Metadata.ID != ExpectedPackID {
		return fmt.Errorf("packaged Phase 0 pack id is %q, want %q", pack.Metadata.ID, ExpectedPackID)
	}
	if pack.Metadata.Version != ExpectedPackVersion {
		return fmt.Errorf("packaged Phase 0 pack version is %q, want %q", pack.Metadata.Version, ExpectedPackVersion)
	}
	if len(pack.Runtime.Platforms) != 1 || pack.Runtime.Platforms[0] != "windows" {
		return fmt.Errorf("packaged Phase 0 pack must target only windows")
	}
	if len(pack.Commands) != 0 {
		return fmt.Errorf("packaged Phase 0 pack must grant zero command execution authority")
	}

	expectedTools := map[string]string{"conjur": "conjur", "idsec": "idsec"}
	if len(pack.Runtime.Tools) != len(expectedTools) {
		return fmt.Errorf("packaged Phase 0 pack must declare exactly conjur and idsec")
	}
	for id, executable := range expectedTools {
		tool, ok := pack.Runtime.Tools[id]
		if !ok {
			return fmt.Errorf("packaged Phase 0 pack is missing tool %s", id)
		}
		if len(tool.ExecutableNames) != 1 || tool.ExecutableNames[0] != executable {
			return fmt.Errorf("packaged Phase 0 tool %s must declare only executable basename %s", id, executable)
		}
		if tool.VersionProbe != nil || len(tool.HelpProbes) != 0 || tool.VersionConstraint != "" {
			return fmt.Errorf("packaged Phase 0 tool %s must grant discovery-only authority with no probes or version constraint", id)
		}
	}
	return nil
}

func VerifyExtractedLayout(root string) error {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return safeIOError("inspect evaluation bundle directory", err)
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("evaluation bundle root must be a real directory")
	}
	rootReparse, err := pathIsReparsePoint(root)
	if err != nil {
		return safeIOError("inspect evaluation bundle directory", err)
	}
	if rootReparse {
		return fmt.Errorf("evaluation bundle root must not be a reparse point")
	}

	expected := map[string]bool{
		ManifestName:   false,
		"bin":          true,
		ExecutablePath: false,
		"packs":        true,
		"packs/phase0": true,
		PackPath:       false,
	}
	seen := make(map[string]string, len(expected))

	err = filepath.WalkDir(root, func(filename string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return safeIOError("walk evaluation bundle", walkErr)
		}
		relative, err := filepath.Rel(root, filename)
		if err != nil {
			return fmt.Errorf("resolve evaluation bundle entry: %w", err)
		}
		if relative == "." {
			return nil
		}
		name := filepath.ToSlash(relative)
		wantDir, ok := expected[name]
		if !ok {
			return fmt.Errorf("unexpected evaluation bundle entry %s", name)
		}
		folded := strings.ToLower(name)
		if previous, exists := seen[folded]; exists {
			return fmt.Errorf("duplicate or case-conflicting evaluation bundle entries %s and %s", previous, name)
		}
		seen[folded] = name

		info, err := entry.Info()
		if err != nil {
			return safeIOError("inspect evaluation bundle entry "+name, err)
		}
		if wantDir {
			if !info.IsDir() {
				return fmt.Errorf("evaluation bundle entry %s must be a directory", name)
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("evaluation bundle directory %s must not be a symlink", name)
			}
			reparse, err := pathIsReparsePoint(filename)
			if err != nil {
				return safeIOError("inspect evaluation bundle directory "+name, err)
			}
			if reparse {
				return fmt.Errorf("evaluation bundle directory %s must not be a reparse point", name)
			}
			return nil
		}
		if err := validateRegularPath(filename, info); err != nil {
			return fmt.Errorf("evaluation bundle file %s: %w", name, err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for name := range expected {
		if _, ok := seen[strings.ToLower(name)]; !ok {
			return fmt.Errorf("evaluation bundle is missing required entry %s", name)
		}
	}
	return nil
}

func ParseManifest(content []byte) (map[string]string, error) {
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

func ReadStableRegularFile(filename string, maxBytes int64) ([]byte, error) {
	expected, err := os.Lstat(filename)
	if err != nil {
		return nil, err
	}
	if err := validateRegularPath(filename, expected); err != nil {
		return nil, err
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
	if err := validateRegularPath(filename, current); err != nil {
		return nil, err
	}
	if !bytes.Equal(data, second) || !os.SameFile(opened, current) ||
		opened.Size() != middle.Size() || !opened.ModTime().Equal(middle.ModTime()) ||
		middle.Size() != finished.Size() || !middle.ModTime().Equal(finished.ModTime()) ||
		finished.Size() != current.Size() || !finished.ModTime().Equal(current.ModTime()) {
		return nil, fmt.Errorf("file changed while read")
	}
	return data, nil
}

func SHA256StableFile(filename string, expected os.FileInfo) ([]byte, error) {
	if err := validateRegularPath(filename, expected); err != nil {
		return nil, err
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
		return nil, fmt.Errorf("file changed before checksum")
	}

	firstHasher := sha256.New()
	if _, err := io.Copy(firstHasher, file); err != nil {
		_ = file.Close()
		return nil, err
	}
	middle, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return nil, err
	}
	secondHasher := sha256.New()
	if _, err := io.Copy(secondHasher, file); err != nil {
		_ = file.Close()
		return nil, err
	}
	finished, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	current, err := os.Lstat(filename)
	if err != nil {
		return nil, err
	}
	if err := validateRegularPath(filename, current); err != nil {
		return nil, err
	}
	firstDigest := firstHasher.Sum(nil)
	secondDigest := secondHasher.Sum(nil)
	if !bytes.Equal(firstDigest, secondDigest) || !os.SameFile(opened, current) ||
		opened.Size() != middle.Size() || !opened.ModTime().Equal(middle.ModTime()) ||
		middle.Size() != finished.Size() || !middle.ModTime().Equal(finished.ModTime()) ||
		finished.Size() != current.Size() || !finished.ModTime().Equal(current.ModTime()) {
		return nil, fmt.Errorf("file changed while checksum was calculated")
	}
	return firstDigest, nil
}

func validateRegularPath(filename string, info os.FileInfo) error {
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("file must be a regular non-symlink file")
	}
	reparse, err := pathIsReparsePoint(filename)
	if err != nil {
		return err
	}
	if reparse {
		return fmt.Errorf("file must not be a reparse point")
	}
	return nil
}

func safeIOError(operation string, err error) error {
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return fmt.Errorf("%s: %w", operation, pathErr.Err)
	}
	return fmt.Errorf("%s: %w", operation, err)
}
