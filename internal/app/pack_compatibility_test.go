package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const compatibilityPackA = `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: alpha
  name: Alpha
  version: 1.0.0
runtime:
  platforms: [windows, linux]
  tools:
    alpha:
      executableNames: [alpha]
      versionProbe:
        args: [--version]
        parser: semver-text
      versionConstraint: ">=1.2.0 <2.0.0"
      install:
        version: 1.4.0
        artifacts:
          windows-amd64:
            url: https://downloads.example.com/alpha.exe
            sha256: 0000000000000000000000000000000000000000000000000000000000000000
            sizeBytes: 1234
            format: executable
            executableName: alpha.exe
commands: {}
`

const compatibilityPackB = `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: beta
  name: Beta
  version: 1.0.0
runtime:
  platforms: [darwin]
  tools:
    beta:
      executableNames: [beta]
commands: {}
`

func TestReportPackCompatibilityIsDeterministicAndStatic(t *testing.T) {
	dir := t.TempDir()
	alphaPath := filepath.Join(dir, "alpha.yaml")
	betaPath := filepath.Join(dir, "beta.yaml")
	if err := os.WriteFile(alphaPath, []byte(compatibilityPackA), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(betaPath, []byte(compatibilityPackB), 0o600); err != nil {
		t.Fatal(err)
	}

	var first bytes.Buffer
	if err := ReportPackCompatibility(Options{Out: &first}, []string{betaPath, alphaPath}); err != nil {
		t.Fatalf("ReportPackCompatibility() error = %v", err)
	}
	var second bytes.Buffer
	if err := ReportPackCompatibility(Options{Out: &second}, []string{alphaPath, betaPath}); err != nil {
		t.Fatalf("ReportPackCompatibility() reversed error = %v", err)
	}
	if first.String() != second.String() {
		t.Fatalf("compatibility output changed with source order:\nFIRST:\n%s\nSECOND:\n%s", first.String(), second.String())
	}

	output := first.String()
	for _, want := range []string{
		"SOURCE\tPACK\tPACK_VERSION\tTOOL\tPLATFORM\tVERSION_CONSTRAINT\tMANAGED_VERSION\tMANAGED_ARTIFACTS",
		"\"alpha.yaml\"\talpha\t1.0.0\talpha\tlinux\t\">=1.2.0 <2.0.0\"\t<none>\tnone",
		"\"alpha.yaml\"\talpha\t1.0.0\talpha\twindows\t\">=1.2.0 <2.0.0\"\t1.4.0\twindows-amd64",
		"\"beta.yaml\"\tbeta\t1.0.0\tbeta\tdarwin\t<none>\t<none>\tnone",
		"Static pack metadata only; no executable, discovery, probe, task, network, install, or authentication/session state was accessed.",
		"does not imply CPU-architecture support",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("compatibility output missing %q:\n%s", want, output)
		}
	}
}

func TestReportPackCompatibilityRequiresOutputAndSources(t *testing.T) {
	if err := ReportPackCompatibility(Options{}, []string{"pack.yaml"}); err == nil {
		t.Fatal("ReportPackCompatibility() unexpectedly accepted nil output")
	}
	var output bytes.Buffer
	if err := ReportPackCompatibility(Options{Out: &output}, nil); err == nil {
		t.Fatal("ReportPackCompatibility() unexpectedly accepted no pack sources")
	}
}
