package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestLintPackPathsCleanPackWithContractCoverage(t *testing.T) {
	t.Parallel()

	var out bytes.Buffer
	err := LintPackPaths(
		Options{Out: &out},
		[]string{filepath.Join("..", "..", "packs", "example", "pack.yaml")},
		filepath.Join("..", "..", "packs", "example", "packtest.json"),
	)
	if err != nil {
		t.Fatalf("LintPackPaths() error = %v; output = %q", err, out.String())
	}
	if !strings.Contains(out.String(), "Linted 1 pack(s): 0 error(s), 0 warning(s)") {
		t.Fatalf("clean lint output = %q", out.String())
	}
}

func TestLintPackPathsReportsGroundedWarningsInStableOrder(t *testing.T) {
	t.Parallel()

	packPath := writeLintFixture(t, "warnings.yaml", `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: warning-pack
  name: Warning pack
  version: 1.0.0
runtime:
  platforms: [windows]
  tools:
    fixture:
      executableNames: [fixture]
commands:
  alpha:
    name: Shared command
    tool: fixture
    risk: read
    inputs:
      - id: unused
        type: integer
        label: Unused
      - id: query
        type: string
        label: Query
        required: true
        validation:
          disallowLeadingDash: true
    argv:
      - literal: inspect
      - positional:
          valueFrom: query
    output:
      mode: raw
  beta:
    name: Shared command
    description: Intentionally future-gated command.
    tool: fixture
    risk: change
    argv:
      - literal: change
    output:
      mode: raw
      sensitivity:
        containsSecrets: true
    requirements:
      requiresAuth: true
`)

	var first bytes.Buffer
	if err := LintPackPaths(Options{Out: &first}, []string{packPath}, ""); err != nil {
		t.Fatalf("warnings should not fail lint: %v; output = %q", err, first.String())
	}
	var second bytes.Buffer
	if err := LintPackPaths(Options{Out: &second}, []string{packPath}, ""); err != nil {
		t.Fatalf("second lint error = %v", err)
	}
	if first.String() != second.String() {
		t.Fatalf("lint ordering is unstable:\nfirst=%q\nsecond=%q", first.String(), second.String())
	}

	for _, code := range []string{
		"PACK_COMMAND_DESCRIPTION_MISSING",
		"PACK_COMMAND_NAME_DUPLICATE",
		"PACK_INPUT_UNUSED",
		"PACK_INPUT_STRING_MAX_MISSING",
		"PACK_COMMAND_RISK_BLOCKED",
		"PACK_COMMAND_AUTH_BLOCKED",
		"PACK_COMMAND_SECRET_OUTPUT_BLOCKED",
	} {
		if !strings.Contains(first.String(), code) {
			t.Fatalf("lint output missing %s: %q", code, first.String())
		}
	}
	if !strings.Contains(first.String(), "0 error(s), 8 warning(s)") {
		t.Fatalf("unexpected warning count: %q", first.String())
	}
}

func TestLintPackPathsRejectsControlTextWithoutEchoingIt(t *testing.T) {
	t.Parallel()

	const secretMarker = "DO-NOT-ECHO-SECRET"
	packPath := writeLintFixture(t, "control.yaml", `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: control-pack
  name: Control pack
  version: 1.0.0
runtime:
  platforms: [windows]
  tools:
    fixture:
      executableNames: [fixture]
commands:
  inspect:
    name: Inspect
    description: "`+secretMarker+`\u001b[31m"
    tool: fixture
    risk: read
    argv:
      - literal: "inspect\u001b[0m"
    output:
      mode: raw
`)

	var out bytes.Buffer
	err := LintPackPaths(Options{Out: &out}, []string{packPath}, "")
	if err == nil {
		t.Fatal("control-bearing pack unexpectedly passed lint")
	}
	if strings.Count(out.String(), "PACK_TEXT_CONTROL") != 2 {
		t.Fatalf("control diagnostics = %q", out.String())
	}
	if strings.Contains(out.String(), secretMarker) {
		t.Fatalf("lint diagnostic echoed arbitrary trusted text: %q", out.String())
	}
}

func TestLintPackPathsDoesNotExecuteOrProbeDeclaredTool(t *testing.T) {
	t.Parallel()

	packPath := writeLintFixture(t, "no-exec.yaml", `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: no-exec
  name: No execution
  version: 1.0.0
runtime:
  platforms: [windows]
  tools:
    absent:
      executableNames: [this-executable-does-not-exist]
      versionProbe:
        args: [--version]
        parser: semver-text
      helpProbes:
        root:
          args: [--help]
      versionConstraint: ">=1.0.0 <2.0.0"
commands:
  inspect:
    name: Inspect
    description: Static lint must not discover or launch the tool.
    tool: absent
    risk: read
    argv:
      - literal: inspect
    output:
      mode: raw
`)

	var out bytes.Buffer
	if err := LintPackPaths(Options{Out: &out}, []string{packPath}, ""); err != nil {
		t.Fatalf("static lint attempted runtime-dependent behavior or otherwise failed: %v; output=%q", err, out.String())
	}
	if !strings.Contains(out.String(), "no executable, discovery probe, version probe, help probe, task, or authentication/session state was accessed") {
		t.Fatalf("lint output did not state its inert boundary: %q", out.String())
	}
}

func TestLintPackPathsRejectsUnsafeAndMalformedSources(t *testing.T) {
	t.Parallel()

	t.Run("malformed", func(t *testing.T) {
		path := writeLintFixture(t, "bad.yaml", "apiVersion: [\n")
		if err := LintPackPaths(Options{Out: &bytes.Buffer{}}, []string{path}, ""); err == nil {
			t.Fatal("malformed YAML unexpectedly passed lint")
		}
	})

	t.Run("oversized", func(t *testing.T) {
		path := writeLintFixture(t, "large.yaml", strings.Repeat("x", packs.MaxPackBytes+1))
		if err := LintPackPaths(Options{Out: &bytes.Buffer{}}, []string{path}, ""); err == nil || !strings.Contains(err.Error(), "byte limit") {
			t.Fatalf("oversized pack lint error = %v", err)
		}
	})

	t.Run("pack symlink", func(t *testing.T) {
		target := writeLintFixture(t, "target.yaml", minimalPackForAuthoring)
		link := filepath.Join(t.TempDir(), "linked.yaml")
		if err := os.Symlink(target, link); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if err := LintPackPaths(Options{Out: &bytes.Buffer{}}, []string{link}, ""); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("symlinked pack lint error = %v", err)
		}
	})

	t.Run("cases symlink", func(t *testing.T) {
		packPath := writeLintFixture(t, "pack.yaml", minimalPackForAuthoring)
		cases := writeLintFixture(t, "cases.json", `{"schemaVersion":"cliharbor.packtest/v1","cases":[{"name":"unknown","packId":"ghost","commandId":"ghost","expectError":{"code":"unknown_pack","path":"packId"}}]}`)
		link := filepath.Join(t.TempDir(), "cases-link.json")
		if err := os.Symlink(cases, link); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if err := LintPackPaths(Options{Out: &bytes.Buffer{}}, []string{packPath}, link); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("symlinked cases lint error = %v", err)
		}
	})
}

func TestLintPackPathsFixtureReferenceErrorsDoNotEchoValues(t *testing.T) {
	t.Parallel()

	packPath := writeLintFixture(t, "pack.yaml", lintContractPack)
	casesPath := writeLintFixture(t, "cases.json", `{
  "schemaVersion": "cliharbor.packtest/v1",
  "cases": [
    {"name":"unknown pack","packId":"ghost","commandId":"inspect","expectArgs":[]},
    {"name":"unknown command","packId":"contract-pack","commandId":"ghost","expectArgs":[]},
    {"name":"unknown input","packId":"contract-pack","commandId":"inspect","values":{"extra":"TOP-SECRET-VALUE"},"expectArgs":["inspect"]}
  ]
}`)

	var out bytes.Buffer
	err := LintPackPaths(Options{Out: &out}, []string{packPath}, casesPath)
	if err == nil {
		t.Fatal("invalid fixture references unexpectedly passed lint")
	}
	for _, code := range []string{"PACK_TEST_UNKNOWN_PACK", "PACK_TEST_UNKNOWN_COMMAND", "PACK_TEST_UNKNOWN_INPUT"} {
		if !strings.Contains(out.String(), code) {
			t.Fatalf("lint output missing %s: %q", code, out.String())
		}
	}
	if strings.Contains(out.String(), "TOP-SECRET-VALUE") {
		t.Fatalf("lint echoed a contract input value: %q", out.String())
	}
}

func TestLintPackPathsAllowsIntentionalUnknownPlannerCases(t *testing.T) {
	t.Parallel()

	packPath := writeLintFixture(t, "pack.yaml", lintContractPack)
	casesPath := writeLintFixture(t, "cases.json", `{
  "schemaVersion": "cliharbor.packtest/v1",
  "cases": [
    {"name":"unknown pack","packId":"ghost","commandId":"inspect","expectError":{"code":"unknown_pack","path":"packId"}},
    {"name":"unknown command","packId":"contract-pack","commandId":"ghost","expectError":{"code":"unknown_command","path":"commandId"}},
    {"name":"unknown input","packId":"contract-pack","commandId":"inspect","values":{"extra":"value"},"expectError":{"code":"unknown_input","path":"values.extra"}}
  ]
}`)

	var out bytes.Buffer
	if err := LintPackPaths(Options{Out: &out}, []string{packPath}, casesPath); err != nil {
		t.Fatalf("intentional planner rejection cases should not be lint errors: %v; output=%q", err, out.String())
	}
	if strings.Contains(out.String(), "error PACK_TEST_UNKNOWN") {
		t.Fatalf("intentional rejection was misclassified: %q", out.String())
	}
}

func TestLintPackPathsReportsContractCoverageGaps(t *testing.T) {
	t.Parallel()

	packPath := writeLintFixture(t, "coverage.yaml", `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: coverage
  name: Coverage
  version: 1.0.0
runtime:
  platforms: [windows]
  tools:
    fixture:
      executableNames: [fixture]
commands:
  inspect:
    name: Inspect
    description: Exercise coverage lint rules.
    tool: fixture
    risk: read
    inputs:
      - id: limit
        type: integer
        label: Limit
        validation:
          min: 1
          max: 10
      - id: verbose
        type: boolean
        label: Verbose
      - id: mode
        type: enum
        label: Mode
        required: true
        validation:
          enum: [safe, detailed]
          disallowLeadingDash: true
      - id: target
        type: string
        label: Target
        validation:
          maxLength: 64
          disallowLeadingDash: true
    argv:
      - literal: inspect
      - flag:
          name: --limit
          valueFrom: limit
          omitWhenEmpty: true
      - switch:
          name: --verbose
          enabledFrom: verbose
      - map:
          valueFrom: mode
          values:
            safe: --safe
            detailed: --detailed
      - positional:
          valueFrom: target
          omitWhenEmpty: true
    output:
      mode: raw
  other:
    name: Other
    description: No success case on purpose.
    tool: fixture
    risk: read
    argv:
      - literal: other
    output:
      mode: raw
`)
	casesPath := writeLintFixture(t, "cases.json", `{
  "schemaVersion": "cliharbor.packtest/v1",
  "cases": [
    {"name":"partial success","packId":"coverage","commandId":"inspect","values":{"verbose":false,"mode":"safe"},"expectArgs":["inspect","--safe"]}
  ]
}`)

	var out bytes.Buffer
	if err := LintPackPaths(Options{Out: &out}, []string{packPath}, casesPath); err != nil {
		t.Fatalf("coverage gaps are warnings, not lint failures: %v; output=%q", err, out.String())
	}
	for _, code := range []string{
		"PACK_TEST_SUCCESS_MISSING",
		"PACK_TEST_INPUT_SUCCESS_MISSING",
		"PACK_TEST_INTEGER_MIN_MISSING",
		"PACK_TEST_INTEGER_MAX_MISSING",
		"PACK_TEST_ENUM_REJECTION_MISSING",
		"PACK_TEST_MAP_BRANCH_MISSING",
	} {
		if !strings.Contains(out.String(), code) {
			t.Fatalf("coverage lint output missing %s: %q", code, out.String())
		}
	}
}

func TestPackLintDiagnosticAmplificationIsBounded(t *testing.T) {
	t.Parallel()

	collector := &packLintCollector{}
	for index := 0; index <= maxPackLintDiagnostics; index++ {
		collector.add(PackLintWarning, "PACK_TEST", "pack.yaml", "commands.test", "bounded")
	}
	if !collector.overflow {
		t.Fatal("diagnostic collector did not fail closed at its configured bound")
	}
	if len(collector.diagnostics) != maxPackLintDiagnostics {
		t.Fatalf("diagnostic count = %d, want %d", len(collector.diagnostics), maxPackLintDiagnostics)
	}
}

func writeLintFixture(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

const lintContractPack = `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: contract-pack
  name: Contract pack
  version: 1.0.0
runtime:
  platforms: [windows]
  tools:
    fixture:
      executableNames: [fixture]
commands:
  inspect:
    name: Inspect
    description: Contract fixture.
    tool: fixture
    risk: read
    argv:
      - literal: inspect
    output:
      mode: raw
`
