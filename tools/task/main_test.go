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
	if err := writeSHA256Sums(artifact, destination); err != nil {
		t.Fatalf("second writeSHA256Sums() error = %v", err)
	}
	second, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(second) == want {
		t.Fatal("checksum file was not replaced after artifact changed")
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
