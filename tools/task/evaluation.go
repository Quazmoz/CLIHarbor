package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
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
	maxEvaluationPack        = 256 << 10
)

var evaluationRequiredPaths = []string{
	evaluationExecutablePath,
	evaluationPackPath,
}

func evaluationGoEnvironment() map[string]string {
	return map[string]string{
		"CGO_ENABLED":  "0",
		"GODEBUG":      "",
		"GOENV":        "off",
		"GOEXPERIMENT": "",
		"GOFLAGS":      "",
		"GOFIPS140":    "off",
		"GOAMD64":      "v1",
		"GOROOT":       "",
		"GOTOOLCHAIN":  "local",
		"GOWORK":       "off",
	}
}

func evaluationBuildEnvironment(cacheDir, tempDir string) map[string]string {
	env := evaluationGoEnvironment()
	env["GOCACHE"] = cacheDir
	env["GOTMPDIR"] = tempDir
	return env
}

func mergeEnvironment(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return append([]string(nil), base...)
	}

	overridden := make(map[string]struct{}, len(overrides))
	keys := make([]string, 0, len(overrides))
	for key := range overrides {
		overridden[strings.ToUpper(key)] = struct{}{}
		keys = append(keys, key)
	}
	sort.Strings(keys)

	merged := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		key, _, ok := strings.Cut(entry, "=")
		if ok {
			if _, replace := overridden[strings.ToUpper(key)]; replace {
				continue
			}
		}
		merged = append(merged, entry)
	}
	for _, key := range keys {
		merged = append(merged, key+"="+overrides[key])
	}
	return merged
}

func requiredEvaluationGoVersion(root string) (string, error) {
	content, err := readStableRegularFile(filepath.Join(root, ".go-version"), 64)
	if err != nil {
		return "", fmt.Errorf("read pinned Go version: %w", err)
	}
	text := string(content)
	if strings.ContainsRune(text, '\r') {
		return "", fmt.Errorf(".go-version must use LF line endings")
	}
	text = strings.TrimSuffix(text, "\n")
	if text == "" || strings.ContainsRune(text, '\n') || strings.TrimSpace(text) != text {
		return "", fmt.Errorf(".go-version must contain exactly one version token")
	}
	parts := strings.Split(text, ".")
	if len(parts) != 3 {
		return "", fmt.Errorf(".go-version must pin an exact major.minor.patch Go version")
	}
	for _, part := range parts {
		if part == "" {
			return "", fmt.Errorf(".go-version must pin an exact major.minor.patch Go version")
		}
		for _, char := range part {
			if char < '0' || char > '9' {
				return "", fmt.Errorf(".go-version must pin an exact major.minor.patch Go version")
			}
		}
	}
	return text, nil
}

func validateEvaluationToolchain(root string) error {
	required, err := requiredEvaluationGoVersion(root)
	if err != nil {
		return err
	}
	cmd := exec.Command("go", "env", "GOVERSION")
	cmd.Dir = root
	cmd.Env = mergeEnvironment(os.Environ(), evaluationGoEnvironment())
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("query evaluation Go toolchain: %w", err)
	}
	actual := strings.TrimSpace(string(output))
	expected := "go" + required
	if actual != expected {
		return fmt.Errorf("evaluation build requires Go %s, found %s", required, actual)
	}
	return nil
}

func copyEvaluationPack(root, bundleRoot string) error {
	source := filepath.Join(root, filepath.FromSlash(evaluationPackPath))
	content, err := readStableRegularFile(source, maxEvaluationPack)
	if err != nil {
		return fmt.Errorf("read trusted evaluation pack: %w", err)
	}
	destination := filepath.Join(bundleRoot, filepath.FromSlash(evaluationPackPath))
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return fmt.Errorf("create evaluation pack directory: %w", err)
	}
	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("create evaluation pack copy: %w", err)
	}
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return fmt.Errorf("write evaluation pack copy: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync evaluation pack copy: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close evaluation pack copy: %w", err)
	}
	copied, err := readStableRegularFile(destination, maxEvaluationPack)
	if err != nil {
		return fmt.Errorf("verify evaluation pack copy: %w", err)
	}
	if !bytes.Equal(content, copied) {
		return fmt.Errorf("evaluation pack copy changed during staging")
	}
	return nil
}

func buildEvaluationBundleAt(root, bundleRoot string) error {
	if err := copyEvaluationPack(root, bundleRoot); err != nil {
		return err
	}
	buildCache := filepath.Join(bundleRoot, ".gocache")
	if err := os.MkdirAll(buildCache, 0o700); err != nil {
		return fmt.Errorf("create isolated reproduction build cache: %w", err)
	}
	buildTemp := filepath.Join(bundleRoot, ".gotmp")
	if err := os.MkdirAll(buildTemp, 0o700); err != nil {
		return fmt.Errorf("create isolated reproduction build temp: %w", err)
	}
	artifact := filepath.Join(bundleRoot, filepath.FromSlash(evaluationExecutablePath))
	if err := buildExecutableWithEnv(
		root,
		artifact,
		"windows",
		"amd64",
		"evaluation-unsigned",
		"0.0.0-eval",
		evaluationBuildEnvironment(buildCache, buildTemp),
	); err != nil {
		return err
	}
	if err := os.RemoveAll(buildCache); err != nil {
		return fmt.Errorf("remove isolated reproduction build cache: %w", err)
	}
	if err := os.RemoveAll(buildTemp); err != nil {
		return fmt.Errorf("remove isolated reproduction build temp: %w", err)
	}
	manifest := filepath.Join(bundleRoot, evaluationManifestName)
	if err := writeSHA256Manifest(bundleRoot, manifest, []string{
		artifact,
		filepath.Join(bundleRoot, filepath.FromSlash(evaluationPackPath)),
	}); err != nil {
		return err
	}
	return verifyWindowsEvaluation(bundleRoot)
}

func verifyWindowsEvaluationReproducible(root string) error {
	if err := validateEvaluationToolchain(root); err != nil {
		return err
	}

	first, err := os.MkdirTemp("", "cliharbor-eval-repro-a-")
	if err != nil {
		return fmt.Errorf("create first evaluation rebuild directory: %w", err)
	}
	defer os.RemoveAll(first)
	second, err := os.MkdirTemp("", "cliharbor-eval-repro-b-")
	if err != nil {
		return fmt.Errorf("create second evaluation rebuild directory: %w", err)
	}
	defer os.RemoveAll(second)

	if err := buildEvaluationBundleAt(root, first); err != nil {
		return fmt.Errorf("build first evaluation reproduction: %w", err)
	}
	if err := buildEvaluationBundleAt(root, second); err != nil {
		return fmt.Errorf("build second evaluation reproduction: %w", err)
	}

	firstManifest, err := readStableRegularFile(filepath.Join(first, evaluationManifestName), maxEvaluationManifest)
	if err != nil {
		return fmt.Errorf("read first evaluation reproduction manifest: %w", err)
	}
	secondManifest, err := readStableRegularFile(filepath.Join(second, evaluationManifestName), maxEvaluationManifest)
	if err != nil {
		return fmt.Errorf("read second evaluation reproduction manifest: %w", err)
	}
	if !bytes.Equal(firstManifest, secondManifest) {
		return fmt.Errorf("Windows evaluation rebuilds are not byte-deterministic")
	}
	return nil
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
