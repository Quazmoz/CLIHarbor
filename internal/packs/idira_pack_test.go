package packs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
