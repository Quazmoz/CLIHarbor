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
	for _, rejected := range []string{"# - Weird", "# - status", "# - usage", "# - acme", "# - -h"} {
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
		"  escaped   \x1b[31mterminal control\n" +
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
