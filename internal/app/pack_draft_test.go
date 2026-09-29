package app

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestDraftPackGeneratesValidDraft(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	helpPath := filepath.Join(root, "acme-help.txt")
	helpText := `Acme CLI controls the Acme service.

Usage:
  acme [command]

Available Commands:
  get         Display one or many resources
  list, ls    List resources in a namespace
  describe    Show details of a specific resource
  -h          not a real command
  Weird       uppercase names are rejected
  help        Help about any command

Flags:
  -v, --verbose   verbose output
  status          ignored because it is outside the commands section
`
	if err := os.WriteFile(helpPath, []byte(helpText), 0o600); err != nil {
		t.Fatal(err)
	}

	destination := filepath.Join(root, "acme.yaml")
	config := PackDraftConfig{
		ID:             "acme-cli",
		Name:           "Acme CLI",
		ToolID:         "acme",
		ExecutableName: "acme",
		Platforms:      []string{"linux", "windows"},
		HelpPath:       helpPath,
		OutputPath:     destination,
	}
	var out bytes.Buffer
	if err := DraftPack(Options{Out: &out}, config); err != nil {
		t.Fatalf("DraftPack() error = %v", err)
	}

	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	pack, err := packs.Parse(data)
	if err != nil {
		t.Fatalf("generated draft did not validate: %v", err)
	}

	if pack.Metadata.ID != "acme-cli" || pack.Metadata.Name != "Acme CLI" {
		t.Fatalf("generated metadata = %#v", pack.Metadata)
	}
	tool, ok := pack.Runtime.Tools["acme"]
	if !ok || len(tool.ExecutableNames) != 1 || tool.ExecutableNames[0] != "acme" {
		t.Fatalf("generated tools = %#v", pack.Runtime.Tools)
	}
	if tool.VersionProbe != nil || len(tool.HelpProbes) != 0 {
		t.Fatalf("draft guessed probe behavior: %#v", tool)
	}

	wantCommands := []string{"describe", "get", "help", "list"}
	if len(pack.Commands) != len(wantCommands) {
		t.Fatalf("generated commands = %v, want %v", draftCommandKeys(pack.Commands), wantCommands)
	}
	for _, name := range wantCommands {
		command, ok := pack.Commands[name]
		if !ok {
			t.Fatalf("draft missing command %q; got %v", name, draftCommandKeys(pack.Commands))
		}
		if command.Risk != packs.RiskRead {
			t.Fatalf("command %q risk = %q, want read", name, command.Risk)
		}
		if command.Tool != "acme" {
			t.Fatalf("command %q tool = %q, want acme", name, command.Tool)
		}
		if command.Output.Mode != packs.OutputRaw {
			t.Fatalf("command %q output mode = %q, want raw", name, command.Output.Mode)
		}
		if len(command.Inputs) != 1 {
			t.Fatalf("command %q inputs = %#v", name, command.Inputs)
		}
		input := command.Inputs[0]
		if input.ID != "args" || input.Type != packs.InputString || !input.Validation.DisallowLeadingDash {
			t.Fatalf("command %q input = %#v", name, input)
		}
		if len(command.Argv) != 2 {
			t.Fatalf("command %q argv = %#v", name, command.Argv)
		}
		if command.Argv[0].Literal != name {
			t.Fatalf("command %q first argv = %#v, want literal %q", name, command.Argv[0], name)
		}
		positional := command.Argv[1].Positional
		if positional == nil || positional.ValueFrom != "args" || !positional.OmitWhenEmpty {
			t.Fatalf("command %q positional = %#v", name, command.Argv[1])
		}
	}

	for _, rejected := range []string{"weird", "status", "usage", "acme"} {
		if _, ok := pack.Commands[rejected]; ok {
			t.Fatalf("draft unexpectedly captured %q outside the commands section", rejected)
		}
	}

	text := out.String()
	for _, want := range []string{
		"Generated draft pack acme.yaml",
		"4 unreviewed command(s)",
		"acme-cli/acme",
		"Review every command's risk",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("draft output %q missing %q", text, want)
		}
	}

	if err := DraftPack(Options{Out: &bytes.Buffer{}}, config); err == nil {
		t.Fatal("DraftPack() unexpectedly overwrote an existing draft")
	}
}

func draftCommandKeys(commands map[string]packs.Command) []string {
	keys := make([]string, 0, len(commands))
	for key := range commands {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
