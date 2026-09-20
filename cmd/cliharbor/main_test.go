package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/diagnostics"
	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

func TestParseToolOverrides(t *testing.T) {
	path := filepath.Join(string(filepath.Separator), "tools", "fixture")
	overrides, err := parseToolOverrides([]string{"demo/fixture=" + path})
	if err != nil {
		t.Fatalf("parseToolOverrides() error = %v", err)
	}
	ref := discovery.ToolRef{PackID: "demo", ToolID: "fixture"}
	if overrides[ref] != path {
		t.Fatalf("override = %q, want %q", overrides[ref], path)
	}
}

func TestParseToolOverridesRejectsMalformedAndDuplicates(t *testing.T) {
	for _, values := range [][]string{
		{"missing-equals"},
		{"demo=/tmp/tool"},
		{"demo/fixture="},
		{"demo/fixture=/one", "demo/fixture=/two"},
	} {
		if _, err := parseToolOverrides(values); err == nil {
			t.Fatalf("parseToolOverrides(%v) unexpectedly succeeded", values)
		}
	}
}

func TestCommandSpecificFlagsFailClosed(t *testing.T) {
	cases := [][]string{
		{"version", "--pack-file", "pack.yaml"},
		{"self-test", "--tool-path", "demo/tool=/tmp/tool"},
		{"doctor", "--probe", "demo/tool/help"},
		{"serve", "--export", "phase0.json"},
		{"inventory", "--web-dev-url", "http://127.0.0.1:5173"},
	}
	for _, args := range cases {
		if err := run(args); err == nil {
			t.Fatalf("run(%v) unexpectedly succeeded", args)
		}
	}
}

func TestInventoryProbeFlagCannotSupplyExecutableOrArgv(t *testing.T) {
	for _, selector := range []string{
		"demo/tool/help/extra",
		"demo/tool",
		"demo/tool/",
		"demo/tool/--help",
	} {
		err := run([]string{"inventory", "--probe", selector})
		if err == nil {
			t.Fatalf("run(inventory --probe %q) unexpectedly succeeded", selector)
		}
		if strings.Contains(err.Error(), "exec") {
			t.Fatalf("invalid probe reached execution path: %v", err)
		}
	}
}

func TestEvidenceCommandShapeFailsClosed(t *testing.T) {
	for _, args := range [][]string{
		{"evidence"},
		{"evidence", "inspect"},
		{"evidence", "unknown", "phase0.json"},
		{"evidence", "inspect", "one.json", "two.json"},
		{"evidence", "checksum"},
		{"evidence", "checksum", "one.json", "two.json"},
		{"evidence", "inspect", "--sha256", "abc", "missing.json"},
	} {
		if err := run(args); err == nil {
			t.Fatalf("run(%v) unexpectedly succeeded", args)
		}
	}
}

func TestDiagnosticsCommandShapeFailsClosed(t *testing.T) {
	for _, args := range [][]string{
		{"diagnostics"},
		{"diagnostics", "inspect"},
		{"diagnostics", "export"},
		{"diagnostics", "export", "one.json", "two.json"},
		{"diagnostics", "export", "--probe", "demo/tool/help", "bundle.json"},
	} {
		if err := run(args); err == nil {
			t.Fatalf("run(%v) unexpectedly succeeded", args)
		}
	}
}

func TestDiagnosticsExportCommandCreatesBundle(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "diagnostics.json")
	if err := run([]string{"diagnostics", "export", destination}); err != nil {
		t.Fatalf("run(diagnostics export) error = %v", err)
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	var bundle diagnostics.Bundle
	if err := json.Unmarshal(data, &bundle); err != nil {
		t.Fatalf("decode diagnostics export: %v", err)
	}
	if bundle.SchemaVersion != diagnostics.SchemaVersion {
		t.Fatalf("schemaVersion = %q, want %q", bundle.SchemaVersion, diagnostics.SchemaVersion)
	}
	if len(bundle.Packs) != 0 || len(bundle.Tools) != 0 {
		t.Fatalf("empty-runtime diagnostics unexpectedly contained pack/tool state: %#v", bundle)
	}
}

func TestEvaluationPreflightCommandShapeFailsClosed(t *testing.T) {
	for _, args := range [][]string{
		{"evaluation"},
		{"evaluation", "unknown"},
		{"evaluation", "preflight", "unexpected"},
		{"evaluation", "preflight", "--bundle"},
	} {
		if err := run(args); err == nil {
			t.Fatalf("run(%v) unexpectedly succeeded", args)
		}
	}
}
