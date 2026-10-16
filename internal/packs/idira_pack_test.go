package packs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	packassets "github.com/Quazmoz/CLIHarbor/packs"
)

func TestIdiraPAMPackIsVerifiedReadOnly(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "packs", "idira", "idira-pam.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	pack, err := Parse(data)
	if err != nil {
		t.Fatalf("invalid first-party PAM pack: %v", err)
	}
	if pack.Metadata.ID != "cyberark-idira-pam" || len(pack.Commands) != 4 {
		t.Fatalf("unexpected PAM pack identity or commands: %s / %d", pack.Metadata.ID, len(pack.Commands))
	}
	tool := pack.Runtime.Tools["idsec"]
	if tool.VersionProbe == nil || strings.Join(tool.VersionProbe.Args, " ") != "version --silent" {
		t.Fatalf("unreviewed CLI version probe: %#v", tool.VersionProbe)
	}
	// Probe IDs are separate from command IDs; "version" is reserved for
	// the loader's version-discovery evidence, not for a help probe.
	if len(tool.HelpProbes) != 4 {
		t.Fatalf("expected four Idira help probes, got %d", len(tool.HelpProbes))
	}
	for id, expectedArgs := range map[string]string{
		"cli-version": "version --help",
		"session":     "status --help",
		"safes":       "pcloud safes list-by --help",
		"accounts":    "pcloud accounts list-by --help",
	} {
		probe, ok := tool.HelpProbes[id]
		if !ok || strings.Join(probe.Args, " ") != expectedArgs {
			t.Fatalf("Idira help probe %q = %#v, expected %q", id, probe, expectedArgs)
		}
	}
	if tool.VersionConstraint != ">=0.13.0-0 <0.14.0-0" ||
		tool.SessionCheck == nil || tool.SessionCheck.CommandID != "session-status" ||
		tool.Install != nil {
		t.Fatalf("PAM compatibility, auth or installation authority changed: %#v", tool)
	}
	for id, command := range pack.Commands {
		if command.Risk != RiskRead || command.Output.Sensitivity.ContainsSecrets ||
			command.Output.Sensitivity.PersistRawOutput || command.Stdin != nil {
			t.Fatalf("unsafe PAM command %q: %+v", id, command)
		}
		if id != "version" && (!command.Requirements.RequiresAuth || command.Requirements.AuthMode != AuthModeVendorSession) {
			t.Fatalf("PAM command %q does not require vendor session", id)
		}
	}
	for _, id := range []string{"list-safes", "list-accounts"} {
		command := pack.Commands[id]
		limit, offset := command.Inputs[0], command.Inputs[1]
		if !limit.Required || limit.Type != InputInteger || limit.Validation.Max == nil || *limit.Validation.Max != 50 ||
			!offset.Required || offset.Validation.Max == nil || *offset.Validation.Max != 100000 {
			t.Fatalf("PAM %s pagination not bounded", id)
		}
		if command.Output.Mode != OutputJSON {
			t.Fatalf("PAM inventory %s not machine-readable", id)
		}
	}
}

// Exercise the same embedded pack collection and loader used during normal
// CLIHarbor startup, so a broken first-party pack cannot go unnoticed.
func TestEmbeddedBuiltinsPassPackLoader(t *testing.T) {
	registry, err := NewLoader().LoadBuiltins(packassets.Builtins())
	if err != nil {
		t.Fatalf("embedded built-in packs failed to load: %v", err)
	}
	if _, ok := registry.FindPack("cyberark-idira-pam"); !ok {
		t.Fatal("embedded Idira PAM pack is missing")
	}
}
