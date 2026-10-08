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
	if pack.Metadata.Version != "0.7.0" {
		t.Fatalf("pack version = %q", pack.Metadata.Version)
	}
	if !strings.Contains(pack.Metadata.Name, "Conjur") {
		t.Fatalf("catalog name does not identify Conjur: %q", pack.Metadata.Name)
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
	if tool.Install == nil || tool.Install.Version != "9.3.1-7207d6a" {
		t.Fatalf("Conjur installation contract = %#v", tool.Install)
	}
	for _, platform := range []string{"windows-amd64", "darwin-amd64", "darwin-arm64"} {
		artifact, ok := tool.Install.Artifacts[platform]
		if !ok || artifact.Format != "executable" || artifact.SizeBytes <= 0 || len(artifact.SHA256) != 64 || !strings.Contains(artifact.URL, "/v9.3.1/conjur_") {
			t.Fatalf("Conjur %s installation contract = %#v", platform, artifact)
		}
	}
	if tool.SessionCheck == nil || tool.SessionCheck.CommandID != "whoami" || tool.SessionCheck.UnauthenticatedStderrContains != "please login again" {
		t.Fatalf("session check = %#v", tool.SessionCheck)
	}
	for _, probe := range []string{"root", "list", "resource", "role", "issuer", "authn-ldap", "policy-update", "variable-set", "whoami"} {
		if _, ok := tool.HelpProbes[probe]; !ok {
			t.Fatalf("help probe %q missing", probe)
		}
	}

	wantCommands := []string{
		"count-resources",
		"issuer-delete",
		"ldap-group-create",
		"ldap-group-delete",
		"ldap-group-list",
		"ldap-group-show",
		"ldap-user-create",
		"ldap-user-delete",
		"ldap-user-list",
		"ldap-user-show",
		"list-variables",
		"list-policies",
		"list-hosts",
		"list-groups",
		"list-resources",
		"resource-exists",
		"resource-permitted-roles",
		"resource-show",
		"role-exists",
		"role-members",
		"role-memberships",
		"role-show",
		"secret-create",
		"secret-delete",
		"secret-deny",
		"secret-permit",
		"secret-set-value",
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
		if command.Risk != RiskRead && command.Risk != RiskChange && command.Risk != RiskDestructive {
			t.Fatalf("command %q risk = %q", id, command.Risk)
		}
		if (command.Risk == RiskChange || command.Risk == RiskDestructive) && command.Impact == nil {
			t.Fatalf("mutation command %q missing impact", id)
		}
		if command.Output.Sensitivity.ContainsSecrets {
			t.Fatalf("command %q unexpectedly secret-bearing", id)
		}
		if !command.Requirements.RequiresAuth || command.Requirements.AuthMode != AuthModeVendorSession {
			t.Fatalf("command %q auth = %#v", id, command.Requirements)
		}
	}

	for _, id := range []string{"ldap-group-list", "ldap-user-list"} {
		cmd := pack.Commands[id]
		if cmd.Risk != RiskRead || len(cmd.Inputs) != 1 || cmd.Inputs[0].ID != "service-id" || !cmd.Inputs[0].Required || len(cmd.Argv) != 6 {
			t.Fatalf("%s must bind one required LDAP service ID to a fixed read-only argv", id)
		}
	}

	for _, id := range []string{"list-variables", "list-policies", "list-hosts", "list-groups"} {
		command := pack.Commands[id]
		if command.Risk != RiskRead || len(command.Inputs) != 2 || command.Inputs[0].ID != "limit" ||
			!command.Inputs[0].Required || !slices.Equal(command.Inputs[0].Validation.Enum, []string{"25", "50", "100"}) {
			t.Fatalf("inventory shortcut %s is not bounded: %+v", id, command)
		}
	}
	listCommand := pack.Commands["list-resources"]
	var listLimit *Input
	for i := range listCommand.Inputs {
		input := &listCommand.Inputs[i]
		if input.ID == "limit" {
			listLimit = input
		}
		if slices.Contains([]string{"members-of", "permitted-roles", "privilege", "count"}, input.ID) {
			t.Fatalf("list-resources still exposes unbounded/deprecated compatibility input %q", input.ID)
		}
	}
	if listLimit == nil {
		t.Fatal("list-resources limit input missing")
	}
	if listLimit.Type != InputEnum || !listLimit.Required || !slices.Equal(listLimit.Validation.Enum, []string{"25", "50", "100"}) {
		t.Fatalf("list-resources bounded page-size contract = %#v", *listLimit)
	}

	for id, command := range pack.Commands {
		takesSecret := command.Stdin != nil && command.Stdin.Input != ""
		if takesSecret != (id == "secret-set-value") {
			t.Fatalf("command %q secret stdin = %v; only secret-set-value may accept a secret", id, takesSecret)
		}
	}

	for _, id := range []string{"issuer-delete", "ldap-group-create", "ldap-group-delete", "ldap-user-create", "ldap-user-delete"} {
		command := pack.Commands[id]
		if command.Impact == nil || command.Impact.Scope != ImpactScopeMultiple {
			t.Fatalf("%s impact = %#v, want explicit multiple-record scope", id, command.Impact)
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
