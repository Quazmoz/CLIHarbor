package app

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDoctorWithNoConfiguredPacksIsInformational(t *testing.T) {
	var out bytes.Buffer
	if err := Doctor(context.Background(), Options{Out: &out, Version: "test"}); err != nil {
		t.Fatalf("Doctor() error = %v", err)
	}
	if !strings.Contains(out.String(), "Configured packs: 0") || !strings.Contains(out.String(), "No packs configured") {
		t.Fatalf("doctor output = %q", out.String())
	}
}

func TestDoctorLoadsMixedExplicitPackSources(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "packs")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	pack := func(id, tool, executable string) []byte {
		return []byte("apiVersion: cliharbor.dev/v1\nkind: CliPack\nmetadata:\n  id: " + id +
			"\n  name: " + id + "\n  version: 0.1.0\nruntime:\n  platforms: [windows, linux, darwin]\n  tools:\n    " +
			tool + ":\n      executableNames: [" + executable + "]\ncommands: {}\n")
	}
	if err := os.WriteFile(filepath.Join(directory, "alpha.yaml"), pack("alpha-cli", "alpha", "alpha-cli"), 0o600); err != nil {
		t.Fatal(err)
	}
	beta := filepath.Join(root, "beta.yaml")
	if err := os.WriteFile(beta, pack("beta-cli", "beta", "beta-cli"), 0o600); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	if err := Doctor(context.Background(), Options{
		Out:           &out,
		Version:       "test",
		PackDirectory: directory,
		PackFiles:     []string{beta},
	}); err != nil {
		t.Fatalf("Doctor() error = %v", err)
	}
	if !strings.Contains(out.String(), "Configured packs: 2") {
		t.Fatalf("doctor output = %q, want two mixed-source packs", out.String())
	}
}
