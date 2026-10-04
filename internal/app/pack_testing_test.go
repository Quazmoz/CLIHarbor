package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunPackTestsExercisesProductionPlannerWithoutExecution(t *testing.T) {
	t.Parallel()

	var out bytes.Buffer
	err := RunPackTests(
		Options{Out: &out},
		filepath.Join("..", "..", "packs", "example", "pack.yaml"),
		filepath.Join("..", "..", "packs", "example", "packtest.json"),
	)
	if err != nil {
		t.Fatalf("RunPackTests() error = %v", err)
	}
	text := out.String()
	for _, want := range []string{
		"PASS safe detailed inspection",
		"PASS reject limit below minimum",
		"PASS reject limit above maximum",
		"PASS reject unknown mode",
		"Passed 10 pack contract case(s)",
		"no executable, version probe, help probe, or task was run",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("pack test output %q missing %q", text, want)
		}
	}
}

func TestRunPackTestsDoesNotEchoExpectedOrPlannedArgvOnMismatch(t *testing.T) {
	t.Parallel()

	cases := filepath.Join(t.TempDir(), "cases.json")
	data := []byte(`{
  "schemaVersion": "cliharbor.packtest/v1",
  "cases": [
    {
      "name": "redaction check",
      "packId": "example",
      "commandId": "inspect",
      "values": {"mode": "safe"},
      "expectArgs": ["do-not-echo-this-marker"]
    }
  ]
}`)
	if err := os.WriteFile(cases, data, 0o600); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	err := RunPackTests(
		Options{Out: &out},
		filepath.Join("..", "..", "packs", "example", "pack.yaml"),
		cases,
	)
	if err == nil {
		t.Fatal("RunPackTests() unexpectedly succeeded")
	}
	if strings.Contains(out.String(), "do-not-echo-this-marker") {
		t.Fatalf("pack test output leaked expected argv: %q", out.String())
	}
	if !strings.Contains(out.String(), "planned argv did not match expected argv") {
		t.Fatalf("pack test output did not explain mismatch: %q", out.String())
	}
}

func TestRunPackTestsRejectsDuplicateJSONKeys(t *testing.T) {
	t.Parallel()

	cases := filepath.Join(t.TempDir(), "cases.json")
	data := []byte(`{
  "schemaVersion": "cliharbor.packtest/v1",
  "schemaVersion": "cliharbor.packtest/v1",
  "cases": []
}`)
	if err := os.WriteFile(cases, data, 0o600); err != nil {
		t.Fatal(err)
	}

	err := RunPackTests(
		Options{Out: &bytes.Buffer{}},
		filepath.Join("..", "..", "packs", "example", "pack.yaml"),
		cases,
	)
	if err == nil || !strings.Contains(err.Error(), "duplicate object key") {
		t.Fatalf("RunPackTests() error = %v, want duplicate-key rejection", err)
	}
}

func TestRunPackTestsRejectsExcessiveJSONNesting(t *testing.T) {
	t.Parallel()

	depth := maxPackTestJSONDepth + 2
	deepValue := strings.Repeat("[", depth) + "0" + strings.Repeat("]", depth)
	data := []byte(`{
  "schemaVersion": "cliharbor.packtest/v1",
  "cases": [
    {
      "name": "deep input",
      "packId": "example",
      "commandId": "inspect",
      "values": {"mode": ` + deepValue + `},
      "expectArgs": []
    }
  ]
}`)
	cases := filepath.Join(t.TempDir(), "cases.json")
	if err := os.WriteFile(cases, data, 0o600); err != nil {
		t.Fatal(err)
	}

	err := RunPackTests(
		Options{Out: &bytes.Buffer{}},
		filepath.Join("..", "..", "packs", "example", "pack.yaml"),
		cases,
	)
	if err == nil || !strings.Contains(err.Error(), "JSON nesting exceeds") {
		t.Fatalf("RunPackTests() error = %v, want nesting-depth rejection", err)
	}
}

func TestRunPackTestsRejectsUnsafeInputIdentifiersBeforePlanning(t *testing.T) {
	t.Parallel()

	data := []byte(`{
  "schemaVersion": "cliharbor.packtest/v1",
  "cases": [
    {
      "name": "unsafe diagnostic key",
      "packId": "example",
      "commandId": "inspect",
      "values": {"bad\nkey": "value", "mode": "safe"},
      "expectError": {"code": "unknown_input"}
    }
  ]
}`)
	cases := filepath.Join(t.TempDir(), "cases.json")
	if err := os.WriteFile(cases, data, 0o600); err != nil {
		t.Fatal(err)
	}

	err := RunPackTests(
		Options{Out: &bytes.Buffer{}},
		filepath.Join("..", "..", "packs", "example", "pack.yaml"),
		cases,
	)
	if err == nil || !strings.Contains(err.Error(), "invalid input identifier") {
		t.Fatalf("RunPackTests() error = %v, want input-identifier rejection", err)
	}
}

func TestDockerPackPlannerContractsAndLint(t *testing.T) {
	t.Parallel()

	packPath := filepath.Join("..", "..", "packs", "docker", "docker.yaml")
	casesPath := filepath.Join("..", "..", "packs", "docker", "packtest.json")

	var testOut bytes.Buffer
	if err := RunPackTests(Options{Out: &testOut}, packPath, casesPath); err != nil {
		t.Fatalf("RunPackTests(docker) error = %v\n%s", err, testOut.String())
	}
	if !strings.Contains(testOut.String(), "Passed 8 pack contract case(s)") {
		t.Fatalf("docker pack test output = %q", testOut.String())
	}

	var lintOut bytes.Buffer
	if err := LintPackPaths(Options{Out: &lintOut}, []string{packPath}, casesPath); err != nil {
		t.Fatalf("LintPackPaths(docker) error = %v\n%s", err, lintOut.String())
	}
	if !strings.Contains(lintOut.String(), "0 error(s), 0 warning(s)") {
		t.Fatalf("docker pack lint output = %q", lintOut.String())
	}
}

func TestKubectlPackPlannerContractsAndLint(t *testing.T) {
	t.Parallel()

	packPath := filepath.Join("..", "..", "packs", "kubectl", "kubectl.yaml")
	casesPath := filepath.Join("..", "..", "packs", "kubectl", "packtest.json")

	var testOut bytes.Buffer
	if err := RunPackTests(Options{Out: &testOut}, packPath, casesPath); err != nil {
		t.Fatalf("RunPackTests(kubectl) error = %v\n%s", err, testOut.String())
	}
	if !strings.Contains(testOut.String(), "Passed 11 pack contract case(s)") {
		t.Fatalf("kubectl pack test output = %q", testOut.String())
	}

	var lintOut bytes.Buffer
	if err := LintPackPaths(Options{Out: &lintOut}, []string{packPath}, casesPath); err != nil {
		t.Fatalf("LintPackPaths(kubectl) error = %v\n%s", err, lintOut.String())
	}
	if !strings.Contains(lintOut.String(), "0 error(s), 0 warning(s)") {
		t.Fatalf("kubectl pack lint output = %q", lintOut.String())
	}
}
