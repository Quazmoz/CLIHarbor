package main

import (
	"path/filepath"
	"strings"
	"testing"

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
