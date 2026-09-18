package app

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/evidence"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestInventoryWithoutPacksIsSafeAndInformational(t *testing.T) {
	var out bytes.Buffer
	err := Inventory(context.Background(), Options{
		Out: &out, Version: "test", Commit: "abc", BuildMode: "test",
	}, InventoryConfig{})
	if err != nil {
		t.Fatalf("Inventory() error = %v", err)
	}
	got := out.String()
	if !strings.Contains(got, "Configured tools: 0") || !strings.Contains(got, "never guesses vendor executable names") {
		t.Fatalf("inventory output = %q", got)
	}
}

func TestParseProbeSelectorsIsBoundedDeterministicAndRejectsDuplicates(t *testing.T) {
	selectors, err := parseProbeSelectors([]string{"z/tool/help", "a/tool/version"})
	if err != nil {
		t.Fatal(err)
	}
	if len(selectors) != 2 || selectors[0].raw != "a/tool/version" || selectors[1].raw != "z/tool/help" {
		t.Fatalf("selectors = %#v", selectors)
	}
	for _, values := range [][]string{
		{"missing"},
		{"a/b"},
		{"a/b/c/d"},
		{"a/b/help", "a/b/help"},
	} {
		if _, err := parseProbeSelectors(values); err == nil {
			t.Fatalf("parseProbeSelectors(%v) unexpectedly succeeded", values)
		}
	}
	tooMany := make([]string, maxInventoryProbeSelections+1)
	for i := range tooMany {
		tooMany[i] = "a/b/p" + strings.Repeat("x", i+1)
	}
	if _, err := parseProbeSelectors(tooMany); err == nil {
		t.Fatal("oversized probe selector set unexpectedly accepted")
	}
}

func TestSanitizeProbeOutputRemovesExecutablePathAndSecretLikeMaterial(t *testing.T) {
	const executable = "C:\\Program Files\\Vendor Tool\\vendor.exe"
	raw := []byte(executable + "\npassword=hunter2\nAuthorization: Bearer token-value\n")
	got := sanitizeProbeOutput(raw, executable)
	for _, forbidden := range []string{executable, "hunter2", "token-value"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("sanitized probe output contains %q: %q", forbidden, got)
		}
	}
	if !strings.Contains(got, "[EXECUTABLE]") {
		t.Fatalf("sanitized probe output = %q", got)
	}
}

func TestInventoryDiagnosticDoesNotIncludeDiscoveryPathsOrRawErrors(t *testing.T) {
	for _, status := range []discovery.Status{
		discovery.StatusReady,
		discovery.StatusMissing,
		discovery.StatusAmbiguous,
		discovery.StatusIncompatible,
		discovery.StatusProbeFailed,
		discovery.StatusInvalidOverride,
		discovery.StatusIdentityFailed,
		discovery.StatusUnsupportedPlatform,
	} {
		got := inventoryDiagnostic(status)
		if got == "" || strings.Contains(got, "C:\\") || strings.Contains(got, "/home/") {
			t.Fatalf("diagnostic for %s = %q", status, got)
		}
	}
}

func TestPrintInventoryContainsOnlySanitizedEvidenceFields(t *testing.T) {
	exit := 0
	bundle := evidence.Bundle{
		SchemaVersion: evidence.SchemaVersion,
		GeneratedAt:   time.Unix(1, 0).UTC(),
		CLIHarbor:     evidence.BuildInfo{Version: "test", Commit: "abc", BuildMode: "evaluation-unsigned"},
		Host:          evidence.HostInfo{OS: "windows", OSVersion: "10.0.26100", Architecture: "amd64"},
		Tools: []evidence.ToolRecord{{
			PackID: "demo", PackVersion: "1.0.0", ToolID: "vendor", Status: "ambiguous",
			CandidateCount: 2, Diagnostic: "multiple matching executables found; use CLI --tool-path to disambiguate",
			Probes: []evidence.ProbeRecord{{
				ID: "root", Kind: "help", Identity: "demo/vendor/root", Status: "exited", ExitCode: &exit,
				Stdout: "safe help text",
			}},
		}},
	}
	var out bytes.Buffer
	if err := printInventory(Options{Out: &out}, bundle, true); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	if !strings.Contains(got, "candidates: 2") || !strings.Contains(got, "safe help text") {
		t.Fatalf("inventory output = %q", got)
	}
	for _, forbidden := range []string{"executableName", "candidate:", "PATH=", "csrf", "bootstrap"} {
		if strings.Contains(strings.ToLower(got), strings.ToLower(forbidden)) {
			t.Fatalf("inventory output contains forbidden authority marker %q: %q", forbidden, got)
		}
	}
}

func TestInventoryRejectsUnknownProbeWithoutExecutingAnything(t *testing.T) {
	var out bytes.Buffer
	err := Inventory(context.Background(), Options{Out: &out, Version: "test"}, InventoryConfig{
		ProbeSelectors: []string{"unknown/tool/root"},
	})
	if err == nil || !strings.Contains(err.Error(), "unknown configured tool") {
		t.Fatalf("Inventory() error = %v", err)
	}
}

func TestRunInventoryProbeIncludesSanitizedDeclaredArgumentsWhenUnavailable(t *testing.T) {
	selector := probeSelector{
		raw: "demo/vendor/root", packID: "demo", toolID: "vendor", probeID: "root",
	}
	tool := packs.Tool{
		ExecutableNames: []string{"vendor"},
		HelpProbes: map[string]packs.HelpProbe{
			"root": {Args: []string{"--help", "token=supersecret"}},
		},
	}
	record, err := runInventoryProbe(context.Background(), discovery.ToolState{
		PackID: "demo", ToolID: "vendor", Status: discovery.StatusMissing,
	}, tool, selector)
	if err != nil {
		t.Fatalf("runInventoryProbe() error = %v", err)
	}
	if record.Status != "unavailable" {
		t.Fatalf("status = %q, want unavailable", record.Status)
	}
	if len(record.Arguments) != 2 || record.Arguments[0] != "--help" {
		t.Fatalf("arguments = %#v", record.Arguments)
	}
	if strings.Contains(record.Arguments[1], "supersecret") || !strings.Contains(record.Arguments[1], "[REDACTED]") {
		t.Fatalf("secret-like argument not sanitized: %#v", record.Arguments)
	}
}

func TestInventoryExportPrintsExactEvidenceSHA256(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phase0.json")
	var out bytes.Buffer
	err := Inventory(context.Background(), Options{
		Out: &out, Version: "test", Commit: "abc123", BuildMode: "test",
	}, InventoryConfig{ExportPath: path})
	if err != nil {
		t.Fatalf("Inventory() export error = %v", err)
	}
	_, digest, err := evidence.ReadBundleWithSHA256(path)
	if err != nil {
		t.Fatalf("ReadBundleWithSHA256() error = %v", err)
	}
	got := out.String()
	if !strings.Contains(got, "Evidence SHA-256: "+digest) {
		t.Fatalf("inventory export output missing exact digest: %q", got)
	}
	if !strings.Contains(got, "not a signature or attestation") {
		t.Fatalf("inventory export output missing integrity limitation: %q", got)
	}
}
