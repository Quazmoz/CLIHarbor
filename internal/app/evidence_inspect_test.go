package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/evidence"
)

func TestInspectEvidenceProducesInertDeterministicReview(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "phase0.json")
	exit := 0
	generated := time.Unix(100, 0).UTC()
	started := generated.Add(time.Second)
	ended := started.Add(time.Second)
	bundle := evidence.Bundle{
		SchemaVersion: evidence.SchemaVersion,
		GeneratedAt:   generated,
		CLIHarbor:     evidence.BuildInfo{Version: "0.0.0-eval", Commit: "abc123", BuildMode: "evaluation-unsigned"},
		Host:          evidence.HostInfo{OS: "windows", OSVersion: "10.0.1", Architecture: "amd64"},
		Tools: []evidence.ToolRecord{{
			PackID: "vendor", PackVersion: "1.0.0", ToolID: "cli", Status: "ready",
			Version: "2.3.4", VersionConstraint: ">= 2.0.0", VersionProbeConfigured: true,
			CandidateCount: 1, Diagnostic: "tool is ready", AvailableHelpProbes: []string{"root"},
			Probes: []evidence.ProbeRecord{
				{ID: "root", Kind: "help", Identity: "vendor/cli/root", Arguments: []string{"help"}, Status: "exited", StartedAt: &started, EndedAt: &ended, ExitCode: &exit, Stdout: "safe output\n"},
				{ID: "version", Kind: "version", Identity: "vendor/cli/version", Arguments: []string{"version"}, Status: "exited", StartedAt: &started, EndedAt: &ended, ExitCode: &exit, Stdout: "2.3.4\n"},
			},
		}},
	}
	if err := evidence.WriteBundle(nil, path, bundle); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := InspectEvidence(Options{Out: &out}, path); err != nil {
		t.Fatalf("InspectEvidence() error = %v", err)
	}
	got := out.String()
	for _, want := range []string{
		"CLIHarbor Phase 0 evidence review",
		"vendor/cli: ready",
		"version: 2.3.4",
		"probe vendor/cli/root [help]: exited",
		"fixed argv: [\"help\"]",
		"stdout: bytes=12 preview=",
		"safe output",
		"EVIDENCE GAPS:",
		"PROVES:",
		"UNKNOWN:",
		"schema validation is not a signature or attestation",
		"BLOCKED:",
		"evidence text never becomes executable pack or argv authority automatically",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("review missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, path) {
		t.Fatalf("review leaked input path: %s", got)
	}
}

func TestInspectEvidenceRejectsUntrustedJSONBeforeRendering(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(path, []byte("{\"schemaVersion\":\"cliharbor.phase0/v1\",\"schemaVersion\":\"other\"}"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := InspectEvidence(Options{Out: &out}, path); err == nil {
		t.Fatal("malformed evidence unexpectedly rendered")
	}
	if out.Len() != 0 {
		t.Fatalf("invalid evidence produced partial review: %q", out.String())
	}
}

func TestInspectEvidenceExpectedSHA256MustMatchBeforeRendering(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phase0.json")
	exit := 0
	generated := time.Unix(100, 0).UTC()
	started := generated.Add(time.Second)
	ended := started.Add(time.Second)
	bundle := evidence.Bundle{
		SchemaVersion: evidence.SchemaVersion,
		GeneratedAt:   generated,
		CLIHarbor:     evidence.BuildInfo{Version: "test", Commit: "abc123", BuildMode: "test"},
		Host:          evidence.HostInfo{OS: "windows", Architecture: "amd64"},
		Tools: []evidence.ToolRecord{{
			PackID: "demo", PackVersion: "1.0.0", ToolID: "tool", Status: "ready", CandidateCount: 1,
			AvailableHelpProbes: []string{"root"},
			Probes: []evidence.ProbeRecord{{
				ID: "root", Kind: "help", Identity: "demo/tool/root", Status: "exited",
				StartedAt: &started, EndedAt: &ended, ExitCode: &exit,
			}},
		}},
	}
	digest, err := evidence.WriteBundleWithSHA256(nil, path, bundle)
	if err != nil {
		t.Fatal(err)
	}

	var verified bytes.Buffer
	if err := InspectEvidenceWithConfig(Options{Out: &verified}, path, EvidenceInspectConfig{ExpectedSHA256: strings.ToUpper(digest)}); err != nil {
		t.Fatalf("verified inspect error = %v", err)
	}
	if !strings.Contains(verified.String(), "Transfer integrity: verified against independently supplied expected digest") {
		t.Fatalf("verified review missing integrity status: %s", verified.String())
	}

	var mismatch bytes.Buffer
	bad := strings.Repeat("0", 64)
	if bad == digest {
		bad = strings.Repeat("1", 64)
	}
	if err := InspectEvidenceWithConfig(Options{Out: &mismatch}, path, EvidenceInspectConfig{ExpectedSHA256: bad}); err == nil {
		t.Fatal("mismatched digest unexpectedly accepted")
	}
	if mismatch.Len() != 0 {
		t.Fatalf("checksum mismatch produced partial review: %q", mismatch.String())
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	tampered := bytes.Replace(data, []byte(`"commit": "abc123"`), []byte(`"commit": "abc124"`), 1)
	if bytes.Equal(data, tampered) {
		t.Fatal("tamper fixture did not modify evidence bytes")
	}
	if err := os.WriteFile(path, tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	var tamperedOut bytes.Buffer
	if err := InspectEvidenceWithConfig(Options{Out: &tamperedOut}, path, EvidenceInspectConfig{ExpectedSHA256: digest}); err == nil {
		t.Fatal("valid-but-tampered evidence unexpectedly matched original digest")
	}
	if tamperedOut.Len() != 0 {
		t.Fatalf("tampered evidence produced partial review: %q", tamperedOut.String())
	}
}

func TestPrintEvidenceChecksumValidatesEvidenceAndPrintsDigest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phase0.json")
	digest, err := evidence.WriteBundleWithSHA256(nil, path, testEvidenceBundleForChecksum())
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := PrintEvidenceChecksum(Options{Out: &out}, path); err != nil {
		t.Fatalf("PrintEvidenceChecksum() error = %v", err)
	}
	if got := strings.TrimSpace(out.String()); got != "Evidence SHA-256: "+digest {
		t.Fatalf("checksum output = %q", got)
	}
}

func testEvidenceBundleForChecksum() evidence.Bundle {
	return evidence.Bundle{
		SchemaVersion: evidence.SchemaVersion,
		GeneratedAt:   time.Unix(100, 0).UTC(),
		CLIHarbor:     evidence.BuildInfo{Version: "test", Commit: "abc123", BuildMode: "test"},
		Host:          evidence.HostInfo{OS: "windows", Architecture: "amd64"},
	}
}
