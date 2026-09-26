package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestInitPackCreatesValidatedDiscoveryOnlyScaffold(t *testing.T) {
	t.Parallel()

	destination := filepath.Join(t.TempDir(), "acme.yaml")
	var out bytes.Buffer
	err := InitPack(Options{Out: &out}, PackInitConfig{
		ID:             "acme-cli",
		Name:           "Acme CLI",
		ToolID:         "acme",
		ExecutableName: "acme",
		Platforms:      []string{"linux", "windows"},
		OutputPath:     destination,
	})
	if err != nil {
		t.Fatalf("InitPack() error = %v", err)
	}

	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	pack, err := packs.Parse(data)
	if err != nil {
		t.Fatalf("generated scaffold did not validate: %v", err)
	}
	if pack.Metadata.ID != "acme-cli" || pack.Metadata.Name != "Acme CLI" {
		t.Fatalf("generated metadata = %#v", pack.Metadata)
	}
	if len(pack.Commands) != 0 {
		t.Fatalf("generated scaffold unexpectedly enabled commands: %#v", pack.Commands)
	}
	tool, ok := pack.Runtime.Tools["acme"]
	if !ok {
		t.Fatalf("generated tools = %#v", pack.Runtime.Tools)
	}
	if len(tool.ExecutableNames) != 1 || tool.ExecutableNames[0] != "acme" {
		t.Fatalf("generated executable names = %#v", tool.ExecutableNames)
	}
	if tool.VersionProbe != nil || len(tool.HelpProbes) != 0 || tool.VersionConstraint != "" {
		t.Fatalf("generated scaffold guessed probe/version behavior: %#v", tool)
	}
	if !strings.Contains(out.String(), "No command syntax was guessed or enabled") {
		t.Fatalf("init output did not explain discovery-only safety: %q", out.String())
	}
}

func TestInitPackDefaultsToWindowsAndDoesNotOverwrite(t *testing.T) {
	t.Parallel()

	destination := filepath.Join(t.TempDir(), "demo.yaml")
	config := PackInitConfig{
		ID:             "demo",
		Name:           "Demo",
		ToolID:         "demo",
		ExecutableName: "demo",
		OutputPath:     destination,
	}
	var out bytes.Buffer
	if err := InitPack(Options{Out: &out}, config); err != nil {
		t.Fatalf("InitPack() first error = %v", err)
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	pack, err := packs.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(pack.Runtime.Platforms) != 1 || pack.Runtime.Platforms[0] != "windows" {
		t.Fatalf("platforms = %#v, want [windows]", pack.Runtime.Platforms)
	}

	if err := InitPack(Options{Out: &out}, config); err == nil {
		t.Fatal("InitPack() unexpectedly overwrote an existing pack")
	}
}

func TestInitPackRejectsUnsafeOrAmbiguousConfiguration(t *testing.T) {
	t.Parallel()

	base := PackInitConfig{
		ID:             "demo",
		Name:           "Demo",
		ToolID:         "demo",
		ExecutableName: "demo",
		OutputPath:     filepath.Join(t.TempDir(), "demo.yaml"),
	}
	for _, mutate := range []func(*PackInitConfig){
		func(c *PackInitConfig) { c.ExecutableName = "powershell.exe" },
		func(c *PackInitConfig) { c.ID = "Bad_ID" },
		func(c *PackInitConfig) { c.Platforms = []string{"windows", "windows"} },
		func(c *PackInitConfig) { c.Platforms = []string{"plan9"} },
	} {
		config := base
		mutate(&config)
		if err := InitPack(Options{Out: &bytes.Buffer{}}, config); err == nil {
			t.Fatalf("InitPack() unexpectedly accepted %#v", config)
		}
	}
}

func TestValidatePackPathsCombinesFilesAndDirectoriesWithoutExecution(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	directory := filepath.Join(root, "packs")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	first := filepath.Join(directory, "first.yaml")
	second := filepath.Join(root, "second.yaml")
	if err := os.WriteFile(first, []byte(strings.Replace(minimalPackForAuthoring, "id: first", "id: alpha", 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte(strings.Replace(minimalPackForAuthoring, "id: first", "id: beta", 1)), 0o600); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	if err := ValidatePackPaths(Options{Out: &out}, []string{directory, second}); err != nil {
		t.Fatalf("ValidatePackPaths() error = %v", err)
	}
	text := out.String()
	for _, want := range []string{
		"Validated 2 pack(s)",
		"no executable, version probe, help probe, or task was run",
		"- alpha 0.1.0",
		"- beta 0.1.0",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("validation output %q missing %q", text, want)
		}
	}
}

const minimalPackForAuthoring = `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: first
  name: First
  version: 0.1.0
runtime:
  platforms: [windows, linux, darwin]
  tools:
    first:
      executableNames: [first-cli]
commands: {}
`
