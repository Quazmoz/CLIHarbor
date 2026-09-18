package packs

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
)

func TestInventoryOnlyPackWithHelpProbesParses(t *testing.T) {
	pack, err := Parse([]byte(fmt.Sprintf(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: inventory
  name: Inventory
  version: 1.0.0
runtime:
  platforms: [%s]
  tools:
    vendor:
      executableNames: [vendor]
      versionProbe:
        args: [--version]
        parser: semver-text
        timeoutMillis: 1000
      helpProbes:
        root:
          args: [--help]
          timeoutMillis: 1000
commands: {}
`, runtime.GOOS)))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	tool := pack.Runtime.Tools["vendor"]
	if len(pack.Commands) != 0 || tool.VersionProbe == nil || len(tool.HelpProbes) != 1 {
		t.Fatalf("parsed pack = %#v", pack)
	}
	if got := tool.HelpProbes["root"].Args; len(got) != 1 || got[0] != "--help" {
		t.Fatalf("help probe args = %#v", got)
	}
}

func TestHelpProbeVersionIDIsReserved(t *testing.T) {
	_, err := Parse([]byte(fmt.Sprintf(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: inventory
  name: Inventory
  version: 1.0.0
runtime:
  platforms: [%s]
  tools:
    vendor:
      executableNames: [vendor]
      helpProbes:
        version:
          args: [--help]
commands: {}
`, runtime.GOOS)))
	if err == nil {
		t.Fatal("reserved help probe id unexpectedly accepted")
	}
}

func TestHelpProbeRejectsNULArgument(t *testing.T) {
	_, err := Parse([]byte(fmt.Sprintf(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: inventory
  name: Inventory
  version: 1.0.0
runtime:
  platforms: [%s]
  tools:
    vendor:
      executableNames: [vendor]
      helpProbes:
        root:
          args: ["--he\u0000lp"]
commands: {}
`, runtime.GOOS)))
	if err == nil {
		t.Fatal("NUL help probe argument unexpectedly accepted")
	}
}

func TestRegistryHelpProbesAreDefensiveCopies(t *testing.T) {
	registry, err := NewRegistry([]LoadedPack{{Pack: Pack{
		Metadata: Metadata{ID: "inventory", Version: "1.0.0"},
		Runtime: Runtime{
			Platforms: []string{runtime.GOOS},
			Tools: map[string]Tool{"vendor": {
				ExecutableNames: []string{"vendor"},
				HelpProbes:      map[string]HelpProbe{"root": {Args: []string{"--help"}}},
			}},
		},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	first, ok := registry.FindTool("inventory", "vendor")
	if !ok {
		t.Fatal("tool missing")
	}
	first.HelpProbes["root"] = HelpProbe{Args: []string{"mutated"}}
	first.HelpProbes["new"] = HelpProbe{Args: []string{"bad"}}

	second, _ := registry.FindTool("inventory", "vendor")
	if _, exists := second.HelpProbes["new"]; exists {
		t.Fatal("registry help probe map mutated through accessor")
	}
	if got := strings.Join(second.HelpProbes["root"].Args, ","); got != "--help" {
		t.Fatalf("registry help probe args mutated: %q", got)
	}
}
