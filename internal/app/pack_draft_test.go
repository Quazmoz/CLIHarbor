package app

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestDraftPackGeneratesDiscoveryOnlyDraft(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	helpPath := filepath.Join(root, "acme-help.txt")
	helpText := "Acme CLI controls the Acme service.\n\n" +
		"Usage:\n" +
		"  acme [command]\n\n" +
		"Available Commands:\n" +
		"  get         Display one or many resources\n" +
		"  list, ls    List resources in a namespace\n" +
		"  describe    Show details of a specific resource\n" +
		"  delete      Delete a resource\n" +
		"  -h          not a real command\n" +
		"  Weird       uppercase names are rejected\n" +
		"  help        Help about any command\n\n" +
		"Flags:\n" +
		"  -v, --verbose   verbose output\n" +
		"  status          ignored because it is outside the commands section\n"
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
	if len(pack.Commands) != 0 {
		t.Fatalf("draft granted executable command authority: %#v", pack.Commands)
	}

	text := string(data)
	for _, want := range []string{
		"# Candidate subcommands parsed from captured help.",
		"# These comments are non-authoritative and are never executable.",
		"# - delete — Delete a resource",
		"# - describe — Show details of a specific resource",
		"# - get — Display one or many resources",
		"# - help — Help about any command",
		"# - list — List resources in a namespace",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("draft file missing %q:\n%s", want, text)
		}
	}
	for _, rejected := range []string{"# - Weird", "# - ls", "# - status", "# - usage", "# - acme", "# - -h"} {
		if strings.Contains(text, rejected) {
			t.Fatalf("draft unexpectedly captured rejected candidate %q:\n%s", rejected, text)
		}
	}

	output := out.String()
	for _, want := range []string{
		"Generated discovery-only draft pack acme.yaml",
		"5 candidate subcommand(s)",
		"acme-cli/acme",
		"No executable, help probe, version probe, or runnable command was generated",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("draft output %q missing %q", output, want)
		}
	}

	if err := DraftPack(Options{Out: &bytes.Buffer{}}, config); err == nil {
		t.Fatal("DraftPack() unexpectedly overwrote an existing draft")
	}
}

func TestParseSubcommandCandidatesDropsUnsafeOrOversizedSummaries(t *testing.T) {
	helpText := "Commands:\n" +
		"  safe      Short safe summary\n" +
		"  escaped   \x1b]0;title\aterminal control\n" + // OSC is not stripped like colour

		"  huge      " + strings.Repeat("x", maxDraftSummaryRunes+1) + "\n"

	candidates := parseSubcommandCandidates(helpText)
	if len(candidates) != 3 {
		t.Fatalf("candidate count = %d, want 3: %#v", len(candidates), candidates)
	}
	got := make(map[string]string, len(candidates))
	for _, candidate := range candidates {
		got[candidate.Name] = candidate.Summary
	}
	if got["safe"] != "Short safe summary" {
		t.Fatalf("safe summary = %q", got["safe"])
	}
	if got["escaped"] != "" {
		t.Fatalf("control-bearing summary was retained: %q", got["escaped"])
	}
	if got["huge"] != "" {
		t.Fatalf("oversized summary was retained: %q", got["huge"])
	}
}

func TestParseSubcommandCandidatesAcceptsCommonHelpLayouts(t *testing.T) {
	helpText := "CORE COMMANDS\n" + // gh
		"  auth:          Authenticate gh\n" +
		"\n" +
		"Basic Commands (Beginner):\n" + // kubectl
		"  create          Create a resource\n" +
		"\n" +
		"Main commands:\n" + // terraform
		"  init          Prepare your working directory\n" +
		"\n" +
		"Use \"x options\" for a list of global command-line options (applies to all commands).\n" +
		"  ignored       Not under a header\n"

	got := parseSubcommands(helpText)
	if want := []string{"auth", "create", "init"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("subcommands = %v, want %v", got, want)
	}

	// Coloured help, raw or after capture-help turned ESC into U+FFFD, behind a BOM.
	colored := "\ufeff\x1b[1mCOMMANDS\x1b[0m\n  \x1b[32mget\x1b[0m:   Get things\n  \uFFFD[32mlist\uFFFD[0m    List things\n"
	candidates := parseSubcommandCandidates(colored)
	if len(candidates) != 2 || candidates[0] != (draftSubcommandCandidate{Name: "get", Summary: "Get things"}) || candidates[1].Name != "list" {
		t.Fatalf("colored candidates = %#v", candidates)
	}
}

func TestReadDraftHelpFileUsesBoundedRegularFileSnapshot(t *testing.T) {
	root := t.TempDir()
	for _, test := range []struct {
		name    string
		content []byte
		wantErr string
	}{
		{name: "valid", content: []byte("Commands:\n  inspect  Read resources\n")},
		{name: "exact limit", content: []byte(strings.Repeat("a", maxDraftHelpBytes))},
		{name: "oversized", content: []byte(strings.Repeat("b", maxDraftHelpBytes+1)), wantErr: "byte limit"},
		{name: "invalid UTF-8", content: []byte{0xff}, wantErr: "UTF-8"},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(root, test.name+".txt")
			if err := os.WriteFile(path, test.content, 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := readDraftHelpFile(path)
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("readDraftHelpFile() error = %v, want %q", err, test.wantErr)
				}
				return
			}
			if err != nil || got != string(test.content) {
				t.Fatalf("readDraftHelpFile() len = %d, error = %v", len(got), err)
			}
		})
	}
	t.Run("non-regular", func(t *testing.T) {
		if _, err := readDraftHelpFile(root); err == nil || !strings.Contains(err.Error(), "regular file") {
			t.Fatalf("readDraftHelpFile(directory) error = %v", err)
		}
	})
	t.Run("symlink", func(t *testing.T) {
		link := filepath.Join(root, "link.txt")
		if err := os.Symlink(filepath.Join(root, "valid.txt"), link); err != nil {
			t.Skipf("creating a symlink is unavailable: %v", err)
		}
		if _, err := readDraftHelpFile(link); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("readDraftHelpFile(symlink) error = %v", err)
		}
	})
}
