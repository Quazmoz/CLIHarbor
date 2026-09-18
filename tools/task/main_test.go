package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHasExpectedModuleLineAcceptsCommonLineEndings(t *testing.T) {
	t.Parallel()

	for _, content := range []string{
		moduleLine + "\n\ngo 1.27.0\n",
		moduleLine + "\r\n\r\ngo 1.27.0\r\n",
		"  " + moduleLine + "  \n",
	} {
		if !hasExpectedModuleLine([]byte(content)) {
			t.Fatalf("expected module line was not recognized in %q", content)
		}
	}
}

func TestHasExpectedModuleLineRejectsDifferentModule(t *testing.T) {
	t.Parallel()

	if hasExpectedModuleLine([]byte("module example.invalid/other\n")) {
		t.Fatal("unexpected module line accepted")
	}
}

func TestWriteSHA256SumsWritesDeterministicArtifactEntry(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	artifact := filepath.Join(dir, "cliharbor-test")
	if err := os.WriteFile(artifact, []byte("hello"), 0o755); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(dir, "SHA256SUMS")
	if err := writeSHA256Sums(artifact, destination); err != nil {
		t.Fatalf("writeSHA256Sums() error = %v", err)
	}

	got, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	const want = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  cliharbor-test\n"
	if string(got) != want {
		t.Fatalf("checksum file = %q, want %q", got, want)
	}

	if err := os.WriteFile(artifact, []byte("hello again"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeSHA256Sums(artifact, destination); err == nil {
		t.Fatal("second writeSHA256Sums() unexpectedly replaced an existing manifest")
	}
	if err := removeGeneratedChecksum(destination); err != nil {
		t.Fatalf("invalidate checksum before regeneration: %v", err)
	}
	if err := writeSHA256Sums(artifact, destination); err != nil {
		t.Fatalf("writeSHA256Sums() after invalidation error = %v", err)
	}
	second, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(second) == want {
		t.Fatal("checksum file was not regenerated after artifact changed")
	}
}

func TestWriteSHA256ManifestCoversBundleDeterministically(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	binary := filepath.Join(root, "bin", "cliharbor.exe")
	pack := filepath.Join(root, "packs", "phase0", "pack.yaml")
	if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(pack), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("hello"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pack, []byte("pack"), 0o644); err != nil {
		t.Fatal(err)
	}

	destination := filepath.Join(root, "EVALUATION_SHA256SUMS")
	if err := writeSHA256Manifest(root, destination, []string{pack, binary}); err != nil {
		t.Fatalf("writeSHA256Manifest() error = %v", err)
	}
	got, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	const want = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  bin/cliharbor.exe\n4862f447f2c7f272fa2f4aaf89dadb3b1ac09105bd5864f8d1a0c9452bb0a226  packs/phase0/pack.yaml\n"
	if string(got) != want {
		t.Fatalf("bundle checksum manifest = %q, want %q", got, want)
	}
}

func TestWriteSHA256ManifestRejectsArtifactsOutsideRootAndSymlinks(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	outsideDir := t.TempDir()
	outside := filepath.Join(outsideDir, "outside.bin")
	if err := os.WriteFile(outside, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeSHA256Manifest(root, filepath.Join(root, "SUMS"), []string{outside}); err == nil {
		t.Fatal("artifact outside manifest root unexpectedly accepted")
	}

	target := filepath.Join(root, "target.bin")
	if err := os.WriteFile(target, []byte("target"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.bin")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := writeSHA256Manifest(root, filepath.Join(root, "SUMS"), []string{link}); err == nil {
		t.Fatal("symlink artifact unexpectedly accepted")
	}
}

func TestSHA256FileRejectsSamePathReplacement(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "artifact.bin")
	if err := os.WriteFile(path, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	expected, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := sha256File(path, expected); err == nil {
		t.Fatal("same-path replacement unexpectedly accepted for checksum")
	}
}

func TestValidateBuildVersion(t *testing.T) {
	t.Parallel()

	for _, version := range []string{"dev", "v1.2.3", "1.2.3-rc.1+build_7"} {
		if err := validateBuildVersion(version); err != nil {
			t.Fatalf("validateBuildVersion(%q) error = %v", version, err)
		}
	}
	for _, version := range []string{"release candidate", "-Xmain.other=value", "v1.2.3\nnext", "版本"} {
		if err := validateBuildVersion(version); err == nil {
			t.Fatalf("validateBuildVersion(%q) succeeded, want error", version)
		}
	}
}

func TestValidateBuildMetadataToken(t *testing.T) {
	t.Parallel()

	for _, value := range []string{"unknown", "abcdef0123456789", "evaluation-unsigned"} {
		if err := validateBuildMetadataToken("metadata", value); err != nil {
			t.Fatalf("validateBuildMetadataToken(%q) error = %v", value, err)
		}
	}
	for _, value := range []string{"", "contains space", "value\nnext", "-X main.other=bad"} {
		if err := validateBuildMetadataToken("metadata", value); err == nil {
			t.Fatalf("validateBuildMetadataToken(%q) succeeded, want error", value)
		}
	}
}
