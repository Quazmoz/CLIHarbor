package packs

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestConjurV9PackParsesAndStaysReadOnly(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "packs", "conjur", "conjur-v9.yaml"))
	if err != nil {
		t.Fatalf("read Conjur pack: %v", err)
	}
	pack, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if pack.Metadata.ID != "cyberark-conjur-v9" {
		t.Fatalf("pack id = %q", pack.Metadata.ID)
	}
	if pack.Metadata.Version != "0.3.0" {
		t.Fatalf("pack version = %q", pack.Metadata.Version)
	}
	if !slices.Equal(pack.Runtime.Platforms, []string{"windows", "darwin"}) {
		t.Fatalf("platforms = %v", pack.Runtime.Platforms)
	}
	tool, ok := pack.Runtime.Tools["conjur"]
	if !ok {
		t.Fatal("conjur tool missing")
	}
	if tool.VersionProbe == nil || len(tool.VersionProbe.Args) != 1 || tool.VersionProbe.Args[0] != "--version" {
		t.Fatalf("version probe = %#v", tool.VersionProbe)
	}
	if tool.VersionConstraint != ">=9.3.1-0 <10.0.0-0" {
		t.Fatalf("version constraint = %q", tool.VersionConstraint)
	}
	if tool.SessionCheck == nil || tool.SessionCheck.CommandID != "whoami" || tool.SessionCheck.UnauthenticatedStderrContains != "please login again" {
		t.Fatalf("session check = %#v", tool.SessionCheck)
	}
	for _, probe := range []string{"root", "list", "resource", "role", "whoami"} {
		if _, ok := tool.HelpProbes[probe]; !ok {
			t.Fatalf("help probe %q missing", probe)
		}
	}

	wantCommands := []string{
		"list-resources",
		"resource-exists",
		"resource-permitted-roles",
		"resource-show",
		"role-exists",
		"role-members",
		"role-memberships",
		"role-show",
		"whoami",
	}
	if len(pack.Commands) != len(wantCommands) {
		t.Fatalf("command count = %d, want %d", len(pack.Commands), len(wantCommands))
	}
	for _, id := range wantCommands {
		command, ok := pack.Commands[id]
		if !ok {
			t.Fatalf("command %q missing", id)
		}
		if command.Risk != RiskRead {
			t.Fatalf("command %q risk = %q", id, command.Risk)
		}
		if command.Output.Sensitivity.ContainsSecrets {
			t.Fatalf("command %q unexpectedly secret-bearing", id)
		}
		if !command.Requirements.RequiresAuth || command.Requirements.AuthMode != AuthModeVendorSession {
			t.Fatalf("command %q auth = %#v", id, command.Requirements)
		}
	}
}

func TestPositionalArgumentRequiresLeadingDashGuard(t *testing.T) {
	data := []byte(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: positional-test
  name: Positional test
  version: 1.0.0
runtime:
  platforms: [windows]
  tools:
    fixture:
      executableNames: [fixture]
commands:
  show:
    name: Show
    tool: fixture
    risk: read
    inputs:
      - id: identifier
        type: string
        label: Identifier
        required: true
    argv:
      - literal: show
      - positional:
          valueFrom: identifier
    output:
      mode: raw
`)
	_, err := Parse(data)
	if err == nil {
		t.Fatal("Parse() succeeded without positional leading-dash guard")
	}
	validation, ok := err.(*ValidationError)
	if !ok || validation.Code != ErrSemantic || !strings.Contains(validation.Path, "positional.valueFrom") {
		t.Fatalf("error = %T %v", err, err)
	}
}
