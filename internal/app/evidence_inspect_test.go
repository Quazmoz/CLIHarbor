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
