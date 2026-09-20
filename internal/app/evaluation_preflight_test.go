package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	evalbundle "github.com/Quazmoz/CLIHarbor/internal/evaluation"
)

const preflightTestCommit = "0123456789abcdef0123456789abcdef01234567"
const preflightTestPack = `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: idira-cyberark-phase0
  name: Idira/CyberArk Phase 0 Inventory
  version: 0.1.0
runtime:
  platforms: [windows]
  tools:
    idsec:
      executableNames: [idsec]
    conjur:
      executableNames: [conjur]
commands: {}
`

func TestEvaluationPreflightQualifiedBundlePassesDeterministically(t *testing.T) {
	root, executable := makePreflightBundle(t)
	deps := passingPreflightDependencies(executable)

	var first bytes.Buffer
	if err := evaluationPreflight(context.Background(), evaluationOptions(&first), EvaluationPreflightConfig{BundleRoot: root}, deps); err != nil {
		t.Fatalf("evaluationPreflight() error = %v\n%s", err, first.String())
	}
	var second bytes.Buffer
	if err := evaluationPreflight(context.Background(), evaluationOptions(&second), EvaluationPreflightConfig{BundleRoot: root}, deps); err != nil {
		t.Fatalf("second evaluationPreflight() error = %v", err)
	}
	if first.String() != second.String() {
		t.Fatalf("preflight output was not deterministic\nfirst:\n%s\nsecond:\n%s", first.String(), second.String())
	}
	for _, expected := range []string{
		"[PASS] build identity",
		"[PASS] authoritative bundle integrity",
		"[PASS] Phase 0 pack authority",
		"[PASS] writable temporary storage",
		"[PASS] embedded frontend and IPv4 loopback",
		"[PASS] direct self-process execution",
		"[PASS] final bundle revalidation",
		"[WARNING] default-browser launch was not attempted",
		"READY FOR PHASE 0 INVENTORY",
	} {
		if !strings.Contains(first.String(), expected) {
			t.Fatalf("preflight output missing %q:\n%s", expected, first.String())
		}
	}
}

func TestEvaluationPreflightBlocksWrongBuildIdentityAndArchitecture(t *testing.T) {
	root, executable := makePreflightBundle(t)
	tests := []struct {
		name    string
		options Options
		deps    evaluationPreflightDependencies
	}{
		{name: "build mode", options: Options{Version: evalbundle.ExpectedVersion, Commit: preflightTestCommit, BuildMode: "development"}, deps: passingPreflightDependencies(executable)},
		{name: "architecture", options: Options{Version: evalbundle.ExpectedVersion, Commit: preflightTestCommit, BuildMode: evalbundle.ExpectedBuildMode}, deps: func() evaluationPreflightDependencies {
			d := passingPreflightDependencies(executable)
			d.goarch = "arm64"
			return d
		}()},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			tc.options.Out = &out
			err := evaluationPreflight(context.Background(), tc.options, EvaluationPreflightConfig{BundleRoot: root}, tc.deps)
			if !errors.Is(err, errEvaluationPreflightBlocked) {
				t.Fatalf("evaluationPreflight() error = %v, want blocked", err)
			}
			if !strings.Contains(out.String(), "[BLOCKED] build identity") || !strings.Contains(out.String(), "NOT READY FOR PHASE 0 INVENTORY") {
				t.Fatalf("blocked output = %q", out.String())
			}
		})
	}
}

func TestEvaluationPreflightBlocksUnwritableTemporaryStorage(t *testing.T) {
	root, executable := makePreflightBundle(t)
	deps := passingPreflightDependencies(executable)
	deps.temporary = func(context.Context) error { return errors.New("denied") }
	var out bytes.Buffer
	err := evaluationPreflight(context.Background(), evaluationOptions(&out), EvaluationPreflightConfig{BundleRoot: root}, deps)
	if !errors.Is(err, errEvaluationPreflightBlocked) {
		t.Fatalf("evaluationPreflight() error = %v, want blocked", err)
	}
	if !strings.Contains(out.String(), "[BLOCKED] writable temporary storage") {
		t.Fatalf("output = %q", out.String())
	}
}

func TestEvaluationPreflightDoesNotLaunchVendorExecutable(t *testing.T) {
	root, executable := makePreflightBundle(t)
	vendorDir := t.TempDir()
	for _, name := range []string{"idsec", "idsec.exe", "conjur", "conjur.exe"} {
		if err := os.WriteFile(filepath.Join(vendorDir, name), []byte("deliberately invalid vendor sentinel"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", vendorDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	deps := passingPreflightDependencies(executable)
	var out bytes.Buffer
	if err := evaluationPreflight(context.Background(), evaluationOptions(&out), EvaluationPreflightConfig{BundleRoot: root}, deps); err != nil {
		t.Fatalf("evaluationPreflight() error = %v", err)
	}
	if !strings.Contains(out.String(), "Vendor discovery and vendor executables were intentionally not invoked.") {
		t.Fatalf("output = %q", out.String())
	}
}

func TestEvaluationPreflightRejectsRunningExecutableOutsideBundle(t *testing.T) {
	root, _ := makePreflightBundle(t)
	other := filepath.Join(t.TempDir(), "cliharbor.exe")
	if err := os.WriteFile(other, []byte("other"), 0o755); err != nil {
		t.Fatal(err)
	}
	deps := passingPreflightDependencies(other)
	var out bytes.Buffer
	err := evaluationPreflight(context.Background(), evaluationOptions(&out), EvaluationPreflightConfig{BundleRoot: root}, deps)
	if !errors.Is(err, errEvaluationPreflightBlocked) || !strings.Contains(out.String(), "[BLOCKED] running executable identity") {
		t.Fatalf("error=%v output=%q", err, out.String())
	}
}

func evaluationOptions(out *bytes.Buffer) Options {
	return Options{Out: out, Version: evalbundle.ExpectedVersion, Commit: preflightTestCommit, BuildMode: evalbundle.ExpectedBuildMode}
}

func passingPreflightDependencies(executable string) evaluationPreflightDependencies {
	return evaluationPreflightDependencies{
		executablePath: func() (string, error) { return executable, nil },
		goos:           "windows", goarch: "amd64",
		temporary: func(context.Context) error { return nil },
		loopback:  func(context.Context) error { return nil },
		process:   func(context.Context) error { return nil },
	}
}

func makePreflightBundle(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	executable := filepath.Join(root, filepath.FromSlash(evalbundle.ExecutablePath))
	pack := filepath.Join(root, filepath.FromSlash(evalbundle.PackPath))
	if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(pack), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("evaluation executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pack, []byte(preflightTestPack), 0o644); err != nil {
		t.Fatal(err)
	}

	var lines []string
	for _, name := range evalbundle.RequiredPaths() {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		lines = append(lines, hex.EncodeToString(digest[:])+"  "+name)
	}
	if err := os.WriteFile(filepath.Join(root, evalbundle.ManifestName), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, executable
}
