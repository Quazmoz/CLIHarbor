package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGeneratePackTestsCreatesPassingZeroCoverageFixture(t *testing.T) {
	t.Parallel()

	packPath := filepath.Join("..", "..", "packs", "example", "pack.yaml")
	destination := filepath.Join(t.TempDir(), "generated.packtest.json")
	var out bytes.Buffer

	if err := GeneratePackTests(Options{Out: &out}, packPath, destination); err != nil {
		t.Fatalf("GeneratePackTests() error = %v", err)
	}
	if !strings.Contains(out.String(), "no executable, discovery probe, version probe, help probe, task, or authentication/session state was accessed") {
		t.Fatalf("generation output did not preserve non-execution boundary: %q", out.String())
	}
	if !strings.Contains(out.String(), "Review expected argv against authoritative vendor evidence") {
		t.Fatalf("generation output did not require semantic review: %q", out.String())
	}

	document, err := readPackTestDocument(destination)
	if err != nil {
		t.Fatalf("read generated fixture: %v", err)
	}
	if err := validatePackTestDocument(document); err != nil {
		t.Fatalf("validate generated fixture: %v", err)
	}
	if len(document.Cases) != 5 {
		t.Fatalf("generated case count = %d, want 5", len(document.Cases))
	}

	var testOut bytes.Buffer
	if err := RunPackTests(Options{Out: &testOut}, packPath, destination); err != nil {
		t.Fatalf("RunPackTests(generated) error = %v\n%s", err, testOut.String())
	}

	var lintOut bytes.Buffer
	if err := LintPackPaths(Options{Out: &lintOut}, []string{packPath}, destination); err != nil {
		t.Fatalf("LintPackPaths(generated) error = %v\n%s", err, lintOut.String())
	}
	if !strings.Contains(lintOut.String(), "0 error(s), 0 warning(s)") {
		t.Fatalf("generated fixture did not close example coverage cleanly: %q", lintOut.String())
	}
}

func TestGeneratePackTestsConjurFixtureSelfVerifies(t *testing.T) {
	t.Parallel()

	packPath := filepath.Join("..", "..", "packs", "conjur", "conjur-v9.yaml")
	destination := filepath.Join(t.TempDir(), "conjur.packtest.json")

	if err := GeneratePackTests(Options{Out: &bytes.Buffer{}}, packPath, destination); err != nil {
		t.Fatalf("GeneratePackTests(conjur) error = %v", err)
	}

	var out bytes.Buffer
	if err := RunPackTests(Options{Out: &out}, packPath, destination); err != nil {
		t.Fatalf("RunPackTests(conjur generated) error = %v\n%s", err, out.String())
	}
}

func TestGeneratePackTestsDoesNotOverwriteOrEmitEmptyFixture(t *testing.T) {
	t.Parallel()

	t.Run("no overwrite", func(t *testing.T) {
		packPath := filepath.Join("..", "..", "packs", "example", "pack.yaml")
		destination := filepath.Join(t.TempDir(), "existing.json")
		const marker = "keep-me"
		if err := os.WriteFile(destination, []byte(marker), 0o600); err != nil {
			t.Fatal(err)
		}

		err := GeneratePackTests(Options{Out: &bytes.Buffer{}}, packPath, destination)
		if err == nil || !strings.Contains(err.Error(), "already exists") {
			t.Fatalf("GeneratePackTests() error = %v, want no-clobber rejection", err)
		}
		data, readErr := os.ReadFile(destination)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if string(data) != marker {
			t.Fatalf("existing fixture changed to %q", data)
		}
	})

	t.Run("discovery only pack", func(t *testing.T) {
		root := t.TempDir()
		packPath := filepath.Join(root, "discovery.yaml")
		destination := filepath.Join(root, "generated.json")
		if err := os.WriteFile(packPath, []byte(minimalPackForAuthoring), 0o600); err != nil {
			t.Fatal(err)
		}

		err := GeneratePackTests(Options{Out: &bytes.Buffer{}}, packPath, destination)
		if err == nil || !strings.Contains(err.Error(), "found no commands") {
			t.Fatalf("GeneratePackTests() error = %v, want no-command rejection", err)
		}
		if _, statErr := os.Stat(destination); !os.IsNotExist(statErr) {
			t.Fatalf("empty fixture unexpectedly created: %v", statErr)
		}
	})
}

func TestGeneratePackTestsFailsClosedWhenStringSampleCannotBeSynthesized(t *testing.T) {
	t.Parallel()

	input := testStringInput("^prefix-[A-Z]{2}$", 9, 9)
	if _, err := generatedStringSample(input); err == nil || !strings.Contains(err.Error(), "author this fixture value manually") {
		t.Fatalf("generatedStringSample() error = %v, want manual-authoring fallback", err)
	}
}

func testStringInput(pattern string, minLength, maxLength int) packs.Input {
	return packs.Input{
		ID:       "target",
		Type:     packs.InputString,
		Required: true,
		Validation: packs.InputValidation{
			Pattern:   pattern,
			MinLength: &minLength,
			MaxLength: &maxLength,
		},
	}
}
