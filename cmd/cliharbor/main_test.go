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
		{"doctor", "--no-auto-setup"},
		{"serve", "--export", "phase0.json"},
		{"inventory", "--web-dev-url", "http://127.0.0.1:5173"},
		{"inventory", "--no-auto-setup"},
		{"inventory", "--no-default-packs"},
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

func TestPackCommandShapeFailsClosed(t *testing.T) {
	for _, args := range [][]string{
		{"pack"},
		{"pack", "unknown"},
		{"pack", "init"},
		{"pack", "validate"},
		{"pack", "lint"},
		{"pack", "test"},
		{"pack", "test", "--cases", "cases.json"},
		{"pack", "generate-tests"},
		{"pack", "generate-tests", "--output", "cases.json"},
		{"pack", "init", "--id", "demo", "--name", "Demo", "--tool", "demo", "--executable", "demo"},
	} {
		if err := run(args); err == nil {
			t.Fatalf("run(%v) unexpectedly succeeded", args)
		}
	}
}

func TestPackInitAndValidateCommands(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "other-cli.yaml")
	if err := run([]string{
		"pack", "init",
		"--id", "other-cli",
		"--name", "Other CLI",
		"--tool", "other",
		"--executable", "other-cli",
		destination,
	}); err != nil {
		t.Fatalf("run(pack init) error = %v", err)
	}
	if _, err := os.Stat(destination); err != nil {
		t.Fatalf("generated pack missing: %v", err)
	}
	if err := run([]string{"pack", "validate", destination}); err != nil {
		t.Fatalf("run(pack validate) error = %v", err)
	}
}

func TestPackTestCommand(t *testing.T) {
	packPath := filepath.Join("..", "..", "packs", "example", "pack.yaml")
	casesPath := filepath.Join("..", "..", "packs", "example", "packtest.json")
	if err := run([]string{"pack", "test", "--cases", casesPath, packPath}); err != nil {
		t.Fatalf("run(pack test) error = %v", err)
	}
}

func TestPackGenerateTestsCommand(t *testing.T) {
	packPath := filepath.Join("..", "..", "packs", "example", "pack.yaml")
	casesPath := filepath.Join(t.TempDir(), "generated.packtest.json")
	if err := run([]string{"pack", "generate-tests", "--output", casesPath, packPath}); err != nil {
		t.Fatalf("run(pack generate-tests) error = %v", err)
	}
	if err := run([]string{"pack", "test", "--cases", casesPath, packPath}); err != nil {
		t.Fatalf("run(pack test generated fixture) error = %v", err)
	}
}

func TestPackLintCommand(t *testing.T) {
	packPath := filepath.Join("..", "..", "packs", "example", "pack.yaml")
	casesPath := filepath.Join("..", "..", "packs", "example", "packtest.json")
	if err := run([]string{"pack", "lint", "--cases", casesPath, packPath}); err != nil {
		t.Fatalf("run(pack lint) error = %v", err)
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


func TestHelpRequestRecognizesOperatorHelpAtUsefulPositions(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want []string
	}{
		{name: "top level long", args: []string{"--help"}, want: nil},
		{name: "top level short", args: []string{"-h"}, want: nil},
		{name: "help command", args: []string{"help"}, want: nil},
		{name: "help nested topic", args: []string{"help", "pack", "init"}, want: []string{"pack", "init"}},
		{name: "command", args: []string{"serve", "--help"}, want: []string{"serve"}},
		{name: "command after option", args: []string{"serve", "--no-auto-setup", "--help"}, want: []string{"serve"}},
		{name: "command with top-level option first", args: []string{"--no-auto-setup", "--help"}, want: nil},
		{name: "nested command", args: []string{"pack", "init", "--help"}, want: []string{"pack", "init"}},
		{name: "nested command after options", args: []string{"pack", "init", "--id", "demo", "--help"}, want: []string{"pack", "init"}},
		{name: "diagnostics nested", args: []string{"diagnostics", "export", "--pack-file", "demo.yaml", "--help"}, want: []string{"diagnostics", "export"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := helpRequest(tc.args)
			if !ok {
				t.Fatalf("helpRequest(%v) did not recognize help", tc.args)
			}
			if strings.Join(got, "/") != strings.Join(tc.want, "/") {
				t.Fatalf("helpRequest(%v) path = %v, want %v", tc.args, got, tc.want)
			}
		})
	}

	if _, ok := helpRequest([]string{"serve", "--no-auto-setup"}); ok {
		t.Fatal("ordinary command unexpectedly treated as help")
	}
}

func TestPrintHelpProvidesCommandMapAndSafetyBoundary(t *testing.T) {
	var output strings.Builder
	if err := printHelp(&output, nil); err != nil {
		t.Fatalf("printHelp(top-level): %v", err)
	}
	for _, want := range []string{
		"Usage:",
		"cliharbor [serve] [options]",
		"doctor",
		"inventory",
		"pack",
		"diagnostics",
		"evaluation",
		"does not provide an arbitrary shell",
	} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("top-level help missing %q:\n%s", want, output.String())
		}
	}
}

func TestPrintHelpProvidesNestedUsage(t *testing.T) {
	var output strings.Builder
	if err := printHelp(&output, []string{"pack", "init"}); err != nil {
		t.Fatalf("printHelp(pack init): %v", err)
	}
	if !strings.Contains(output.String(), "cliharbor pack init --id <id>") {
		t.Fatalf("nested help missing pack init usage:\n%s", output.String())
	}
	if !strings.Contains(output.String(), "discovery-only pack scaffold") {
		t.Fatalf("nested help missing safety scope:\n%s", output.String())
	}
}

func TestPrintHelpRejectsUnknownTopicActionably(t *testing.T) {
	var output strings.Builder
	err := printHelp(&output, []string{"pack", "unknown"})
	if err == nil {
		t.Fatal("unknown help topic unexpectedly succeeded")
	}
	if !strings.Contains(err.Error(), "cliharbor help") {
		t.Fatalf("unknown help topic error is not actionable: %v", err)
	}
}

func TestUnknownCommandsPointToHelp(t *testing.T) {
	cases := [][]string{
		{"serv"},
		{"pack", "innit"},
		{"evidence", "inspekt"},
		{"diagnostics", "inspect"},
		{"evaluation", "check"},
	}
	for _, args := range cases {
		err := run(args)
		if err == nil {
			t.Fatalf("run(%v) unexpectedly succeeded", args)
		}
		if !strings.Contains(err.Error(), "cliharbor help") {
			t.Fatalf("run(%v) error is not actionable: %v", args, err)
		}
	}
}
