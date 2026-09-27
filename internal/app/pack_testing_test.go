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
		"PASS reject out-of-range limit",
		"Passed 2 pack contract case(s)",
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
