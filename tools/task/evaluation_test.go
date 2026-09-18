package main

import (
	"os"
	"path/filepath"
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
