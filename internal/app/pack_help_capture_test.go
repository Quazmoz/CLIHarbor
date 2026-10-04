package app

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestPackHelpCaptureHelperProcess(t *testing.T) {
	const helperArg = "-test.run=^TestPackHelpCaptureHelperProcess$"
	found := false
	for _, arg := range os.Args[1:] {
		if arg == helperArg {
			found = true
			break
		}
	}
	if !found {
		return
	}

	fmt.Fprintln(os.Stdout, "Acme CLI")
	fmt.Fprintln(os.Stdout, "")
	fmt.Fprintln(os.Stdout, "Available Commands:")
	fmt.Fprintln(os.Stdout, "  inspect     Inspect resources")
	fmt.Fprintln(os.Stdout, "  delete      Delete resources")
	os.Exit(0)
}

func TestCapturePackHelpUsesOnlyDeclaredProbeAndFeedsDiscoveryOnlyDraft(t *testing.T) {
	root := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		t.Fatal(err)
	}

	const helperArg = "-test.run=^TestPackHelpCaptureHelperProcess$"
	packPath := filepath.Join(root, "capture.yaml")
	packText := fmt.Sprintf(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: capture-test
  name: Capture Test
  version: 0.1.0
runtime:
  platforms: [%s]
  tools:
    helper:
      executableNames: [%s]
      helpProbes:
        root:
          args: [%s]
          timeoutMillis: 3000
commands: {}
`, runtime.GOOS, strconv.Quote(filepath.Base(executable)), strconv.Quote(helperArg))
	if err := os.WriteFile(packPath, []byte(packText), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := packs.Parse([]byte(packText)); err != nil {
		t.Fatalf("fixture pack invalid: %v", err)
	}

	ref := discovery.ToolRef{PackID: "capture-test", ToolID: "helper"}
	capturePath := filepath.Join(root, "captured-help.txt")
	var out bytes.Buffer
	err = CapturePackHelp(context.Background(), Options{
		Out:       &out,
		PackFiles: []string{packPath},
		ToolOverrides: map[discovery.ToolRef]string{
			ref: executable,
		},
	}, PackHelpCaptureConfig{
		ToolSelector: "capture-test/helper",
		ProbeID:      "root",
		OutputPath:   capturePath,
	})
	if err != nil {
		t.Fatalf("CapturePackHelp() error = %v", err)
	}

	captured, err := os.ReadFile(capturePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Available Commands:", "inspect", "delete"} {
		if !strings.Contains(string(captured), want) {
			t.Fatalf("captured help missing %q: %q", want, string(captured))
		}
	}
	if !strings.Contains(out.String(), "grants no executable, command, argv, or pack authority") {
		t.Fatalf("capture output missing authority boundary: %q", out.String())
	}

	draftPath := filepath.Join(root, "draft.yaml")
	if err := DraftPack(Options{Out: &bytes.Buffer{}}, PackDraftConfig{
		ID:             "acme-cli",
		Name:           "Acme CLI",
		ToolID:         "acme",
		ExecutableName: "acme",
		Platforms:      []string{runtime.GOOS},
		HelpPath:       capturePath,
		OutputPath:     draftPath,
	}); err != nil {
		t.Fatalf("DraftPack(captured help) error = %v", err)
	}
	draftBytes, err := os.ReadFile(draftPath)
	if err != nil {
		t.Fatal(err)
	}
	draft, err := packs.Parse(draftBytes)
	if err != nil {
		t.Fatalf("generated draft invalid: %v", err)
	}
	if len(draft.Commands) != 0 {
		t.Fatalf("captured help silently granted command authority: %#v", draft.Commands)
	}
	for _, want := range []string{"# - delete", "# - inspect"} {
		if !strings.Contains(string(draftBytes), want) {
			t.Fatalf("draft missing candidate %q:\n%s", want, draftBytes)
		}
	}

	if err := CapturePackHelp(context.Background(), Options{
		Out:       &bytes.Buffer{},
		PackFiles: []string{packPath},
		ToolOverrides: map[discovery.ToolRef]string{
			ref: executable,
		},
	}, PackHelpCaptureConfig{
		ToolSelector: "capture-test/helper",
		ProbeID:      "root",
		OutputPath:   capturePath,
	}); err == nil {
		t.Fatal("CapturePackHelp() unexpectedly overwrote an existing capture")
	}
}

func TestCapturePackHelpRejectsUnknownToolAndProbeBeforeExecution(t *testing.T) {
	var out bytes.Buffer
	err := CapturePackHelp(context.Background(), Options{Out: &out}, PackHelpCaptureConfig{
		ToolSelector: "missing/tool",
		ProbeID:      "root",
		OutputPath:   filepath.Join(t.TempDir(), "help.txt"),
	})
	if err == nil || !strings.Contains(err.Error(), "not present in the explicitly trusted pack set") {
		t.Fatalf("unknown tool error = %v", err)
	}

	root := t.TempDir()
	packPath := filepath.Join(root, "capture.yaml")
	packText := fmt.Sprintf(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: capture-test
  name: Capture Test
  version: 0.1.0
runtime:
  platforms: [%s]
  tools:
    helper:
      executableNames: [helper]
      helpProbes:
        root:
          args: [--help]
commands: {}
`, runtime.GOOS)
	if err := os.WriteFile(packPath, []byte(packText), 0o600); err != nil {
		t.Fatal(err)
	}
	err = CapturePackHelp(context.Background(), Options{
		Out:       &out,
		PackFiles: []string{packPath},
	}, PackHelpCaptureConfig{
		ToolSelector: "capture-test/helper",
		ProbeID:      "missing",
		OutputPath:   filepath.Join(root, "help.txt"),
	})
	if err == nil || !strings.Contains(err.Error(), "is not declared") {
		t.Fatalf("unknown probe error = %v", err)
	}
}

func TestParseCaptureToolSelectorRejectsAuthorityExpansion(t *testing.T) {
	for _, raw := range []string{"", "pack", "pack/tool/extra", "/tool", "pack/"} {
		if _, err := parseCaptureToolSelector(raw); err == nil {
			t.Fatalf("parseCaptureToolSelector(%q) unexpectedly succeeded", raw)
		}
	}
}
