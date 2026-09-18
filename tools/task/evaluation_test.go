package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestVerifyWindowsEvaluationAcceptsExactAuthoritativeBundle(t *testing.T) {
	t.Parallel()

	root := makeEvaluationBundle(t)
	if err := verifyWindowsEvaluation(root); err != nil {
		t.Fatalf("verifyWindowsEvaluation() error = %v", err)
	}
}

func TestVerifyWindowsEvaluationRejectsCompatibilityManifest(t *testing.T) {
	t.Parallel()

	root := makeEvaluationBundle(t)
	compatibility := filepath.Join(root, "bin", "SHA256SUMS")
	if err := os.WriteFile(compatibility, []byte("legacy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyWindowsEvaluation(root); err == nil ||
		!strings.Contains(err.Error(), "must not contain compatibility checksum") {
		t.Fatalf("verifyWindowsEvaluation() error = %v, want compatibility-manifest rejection", err)
	}
}

func TestVerifyWindowsEvaluationDetectsChangedArtifactAndAcceptsRegeneration(t *testing.T) {
	t.Parallel()

	root := makeEvaluationBundle(t)
	executable := filepath.Join(root, filepath.FromSlash(evaluationExecutablePath))
	if err := os.WriteFile(executable, []byte("changed executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := verifyWindowsEvaluation(root); err == nil ||
		!strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("verifyWindowsEvaluation() error = %v, want checksum mismatch", err)
	}

	manifest := filepath.Join(root, evaluationManifestName)
	if err := removeGeneratedChecksum(manifest); err != nil {
		t.Fatalf("invalidate manifest before regeneration: %v", err)
	}
	if err := writeSHA256Manifest(root, manifest, []string{
		executable,
		filepath.Join(root, filepath.FromSlash(evaluationPackPath)),
	}); err != nil {
		t.Fatalf("regenerate manifest: %v", err)
	}
	if err := verifyWindowsEvaluation(root); err != nil {
		t.Fatalf("verifyWindowsEvaluation() after regeneration error = %v", err)
	}
}

func TestVerifyWindowsEvaluationRejectsSymlinkedPrivilegedFile(t *testing.T) {
	t.Parallel()

	root := makeEvaluationBundle(t)
	pack := filepath.Join(root, filepath.FromSlash(evaluationPackPath))
	target := filepath.Join(root, "real-pack.yaml")
	if err := os.WriteFile(target, []byte("pack"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(pack); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, pack); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := verifyWindowsEvaluation(root); err == nil ||
		!strings.Contains(err.Error(), "regular non-symlink") {
		t.Fatalf("verifyWindowsEvaluation() error = %v, want symlink rejection", err)
	}
}

func TestParseEvaluationManifestRejectsAliasesDuplicatesAndNondeterminism(t *testing.T) {
	t.Parallel()

	const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	tests := map[string]string{
		"case-insensitive duplicate": digest + "  bin/cliharbor.exe\n" + digest + "  BIN/CLIHARBOR.EXE\n",
		"backslash path":             digest + "  bin\\cliharbor.exe\n",
		"traversal path":             digest + "  ../cliharbor.exe\n",
		"noncanonical path":          digest + "  bin/../cliharbor.exe\n",
		"drive-like path":            digest + "  C:/cliharbor.exe\n",
		"uppercase digest":           strings.ToUpper(digest) + "  bin/cliharbor.exe\n",
		"unsorted paths":             digest + "  packs/z.yaml\n" + digest + "  bin/a.exe\n",
		"missing final newline":      digest + "  bin/cliharbor.exe",
	}
	for name, manifest := range tests {
		name, manifest := name, manifest
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := parseEvaluationManifest([]byte(manifest)); err == nil {
				t.Fatalf("parseEvaluationManifest(%q) unexpectedly succeeded", manifest)
			}
		})
	}
}

func TestWriteSHA256ManifestRejectsDuplicatePathAliases(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	artifact := filepath.Join(root, "bin", "artifact.exe")
	if err := os.MkdirAll(filepath.Dir(artifact), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(artifact, []byte("artifact"), 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "bin", ".", "artifact.exe")
	if err := writeSHA256Manifest(root, filepath.Join(root, "SUMS"), []string{artifact, alias}); err == nil {
		t.Fatal("duplicate normalized artifact path unexpectedly accepted")
	}
}

func TestWriteChecksumFileConcurrentPublishIsNoClobber(t *testing.T) {
	t.Parallel()

	destination := filepath.Join(t.TempDir(), "EVALUATION_SHA256SUMS")
	results := make(chan error, 2)
	start := make(chan struct{})
	for _, content := range []string{"first\n", "second\n"} {
		content := content
		go func() {
			<-start
			results <- writeChecksumFile(destination, content)
		}()
	}
	close(start)

	successes := 0
	for range 2 {
		if err := <-results; err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent checksum publications succeeded %d times, want exactly 1", successes)
	}
	got, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "first\n" && string(got) != "second\n" {
		t.Fatalf("published checksum content = %q, want one complete writer payload", got)
	}
}

func TestRemoveGeneratedChecksumInvalidatesStaleManifest(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "SHA256SUMS")
	if err := os.WriteFile(path, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := removeGeneratedChecksum(path); err != nil {
		t.Fatalf("removeGeneratedChecksum() error = %v", err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("generated checksum still exists: %v", err)
	}
	if err := removeGeneratedChecksum(path); err != nil {
		t.Fatalf("second removeGeneratedChecksum() error = %v", err)
	}
}

func TestMergeEnvironmentOverridesBuildInputsCaseInsensitively(t *testing.T) {
	t.Parallel()

	base := []string{
		"Path=C:\\Tools",
		"GOFLAGS=-race",
		"goenv=C:\\Users\\test\\go-env",
		"KEEP=value",
	}
	merged := mergeEnvironment(base, map[string]string{
		"GOENV":   "off",
		"GOFLAGS": "",
	})

	var goenvCount, goflagsCount int
	for _, entry := range merged {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		switch {
		case strings.EqualFold(key, "GOENV"):
			goenvCount++
			if value != "off" {
				t.Fatalf("GOENV = %q, want off", value)
			}
		case strings.EqualFold(key, "GOFLAGS"):
			goflagsCount++
			if value != "" {
				t.Fatalf("GOFLAGS = %q, want empty", value)
			}
		}
	}
	if goenvCount != 1 || goflagsCount != 1 {
		t.Fatalf("override counts = GOENV:%d GOFLAGS:%d, want exactly one each", goenvCount, goflagsCount)
	}
	if !slices.Contains(merged, "KEEP=value") {
		t.Fatalf("unrelated environment entry was lost: %v", merged)
	}
}

func TestEvaluationGoEnvironmentPinsBuildAffectingInputs(t *testing.T) {
	t.Parallel()

	env := evaluationGoEnvironment()
	want := map[string]string{
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
	for key, value := range want {
		if got, ok := env[key]; !ok || got != value {
			t.Fatalf("evaluation build env %s = %q, present=%v, want %q", key, got, ok, value)
		}
	}
	if _, ok := env["GOCACHE"]; ok {
		t.Fatal("base evaluation environment unexpectedly pins a shared GOCACHE")
	}

	buildEnv := evaluationBuildEnvironment(
		filepath.Join("tmp", "isolated-cache"),
		filepath.Join("tmp", "isolated-work"),
	)
	if got := buildEnv["GOCACHE"]; got != filepath.Join("tmp", "isolated-cache") {
		t.Fatalf("evaluation GOCACHE = %q, want isolated cache path", got)
	}
	if got := buildEnv["GOTMPDIR"]; got != filepath.Join("tmp", "isolated-work") {
		t.Fatalf("evaluation GOTMPDIR = %q, want isolated temp path", got)
	}
	if _, ok := env["GOCACHE"]; ok {
		t.Fatal("evaluationBuildEnvironment mutated the base environment map")
	}
	if _, ok := env["GOTMPDIR"]; ok {
		t.Fatal("evaluationBuildEnvironment mutated the base environment map")
	}
}

func TestRequiredEvaluationGoVersionRequiresExactPatchVersion(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		content string
		want    string
		ok      bool
	}{
		"valid":            {content: "1.27.1\n", want: "1.27.1", ok: true},
		"no final newline": {content: "1.27.1", want: "1.27.1", ok: true},
		"minor only":       {content: "1.27\n"},
		"extra line":       {content: "1.27.1\n1.27.2\n"},
		"leading space":    {content: " 1.27.1\n"},
		"release suffix":   {content: "1.28.0-rc.1\n"},
		"crlf":             {content: "1.27.1\r\n"},
	}

	for name, tc := range tests {
		name, tc := name, tc
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, ".go-version"), []byte(tc.content), 0o644); err != nil {
				t.Fatal(err)
			}
			got, err := requiredEvaluationGoVersion(root)
			if tc.ok {
				if err != nil {
					t.Fatalf("requiredEvaluationGoVersion() error = %v", err)
				}
				if got != tc.want {
					t.Fatalf("requiredEvaluationGoVersion() = %q, want %q", got, tc.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("requiredEvaluationGoVersion() = %q, want error", got)
			}
		})
	}
}

func TestCopyEvaluationPackPreservesExactBytes(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	source := filepath.Join(root, filepath.FromSlash(evaluationPackPath))
	if err := os.MkdirAll(filepath.Dir(source), 0o755); err != nil {
		t.Fatal(err)
	}
	want := []byte("apiVersion: cliharbor.dev/v1\nkind: CliPack\n")
	if err := os.WriteFile(source, want, 0o644); err != nil {
		t.Fatal(err)
	}
	bundleRoot := t.TempDir()
	if err := copyEvaluationPack(root, bundleRoot); err != nil {
		t.Fatalf("copyEvaluationPack() error = %v", err)
	}
	got, err := os.ReadFile(filepath.Join(bundleRoot, filepath.FromSlash(evaluationPackPath)))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("copied pack = %q, want %q", got, want)
	}
}

func makeEvaluationBundle(t *testing.T) string {
	t.Helper()

	root := t.TempDir()
	executable := filepath.Join(root, filepath.FromSlash(evaluationExecutablePath))
	pack := filepath.Join(root, filepath.FromSlash(evaluationPackPath))
	if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(pack), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("evaluation executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pack, []byte("phase0 pack"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeSHA256Manifest(root, filepath.Join(root, evaluationManifestName), []string{executable, pack}); err != nil {
		t.Fatalf("writeSHA256Manifest() error = %v", err)
	}
	return root
}
