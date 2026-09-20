package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	evalbundle "github.com/Quazmoz/CLIHarbor/internal/evaluation"
)

const (
	evaluationManifestName   = evalbundle.ManifestName
	evaluationExecutablePath = evalbundle.ExecutablePath
	evaluationPackPath       = evalbundle.PackPath
	maxEvaluationManifest    = evalbundle.MaxManifestBytes
	maxEvaluationPack        = evalbundle.MaxPackBytes
)

var evaluationRequiredPaths = evalbundle.RequiredPaths()

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
	if err := verifyWindowsEvaluation(root); err != nil {
		return fmt.Errorf("verify evaluation candidate before reproduction: %w", err)
	}
	candidateManifest, err := readStableRegularFile(filepath.Join(root, evaluationManifestName), maxEvaluationManifest)
	if err != nil {
		return fmt.Errorf("read evaluation candidate manifest: %w", err)
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
	return verifyEvaluationReproductionManifests(candidateManifest, firstManifest, secondManifest)
}

func verifyEvaluationReproductionManifests(candidate, first, second []byte) error {
	if !bytes.Equal(first, second) {
		return fmt.Errorf("Windows evaluation rebuilds are not byte-deterministic")
	}
	if !bytes.Equal(candidate, first) {
		return fmt.Errorf("Windows evaluation candidate does not match deterministic rebuilds")
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
	return evalbundle.VerifyBundle(root)
}

func parseEvaluationManifest(content []byte) (map[string]string, error) {
	return evalbundle.ParseManifest(content)
}

func readStableRegularFile(filename string, maxBytes int64) ([]byte, error) {
	return evalbundle.ReadStableRegularFile(filename, maxBytes)
}
