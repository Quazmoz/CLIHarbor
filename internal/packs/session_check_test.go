package packs

import (
	"strings"
	"testing"
)

func TestSessionCheckRequiresSafeReviewedVendorSessionCommand(t *testing.T) {
	base := func(sessionCheck, commands string) []byte {
		return []byte(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: session-test
  name: Session test
  version: 1.0.0
runtime:
  platforms: [windows]
  tools:
    fixture:
      executableNames: [fixture]
` + sessionCheck + `commands:
` + commands)
	}

	validCommand := `  status:
    name: Status
    tool: fixture
    risk: read
    argv:
      - literal: status
    output:
      mode: raw
    requirements:
      requiresAuth: true
      authMode: vendor-session
`

	tests := []struct {
		name         string
		sessionCheck string
		commands     string
		path         string
	}{
		{
			name:         "unknown command",
			sessionCheck: "      sessionCheck:\n        commandId: missing\n",
			commands:     validCommand,
			path:         "sessionCheck.commandId",
		},
		{
			name:         "wrong tool",
			sessionCheck: "      sessionCheck:\n        commandId: status\n",
			commands: `  status:
    name: Status
    tool: other
    risk: read
    argv:
      - literal: status
    output:
      mode: raw
    requirements:
      requiresAuth: true
      authMode: vendor-session
`,
			path: "commands.status.tool",
		},
		{
			name:         "change risk",
			sessionCheck: "      sessionCheck:\n        commandId: status\n",
			commands: strings.Replace(validCommand, "risk: read", "risk: change", 1),
			path:     "sessionCheck.commandId",
		},
		{
			name:         "browser input",
			sessionCheck: "      sessionCheck:\n        commandId: status\n",
			commands: strings.Replace(validCommand, "    argv:\n", "    inputs:\n      - id: value\n        type: string\n        label: Value\n    argv:\n", 1),
			path:     "sessionCheck.commandId",
		},
		{
			name:         "secret output",
			sessionCheck: "      sessionCheck:\n        commandId: status\n",
			commands: strings.Replace(validCommand, "      mode: raw", "      mode: raw\n      sensitivity:\n        containsSecrets: true", 1),
			path:     "sessionCheck.commandId",
		},
		{
			name:         "missing vendor session mode",
			sessionCheck: "      sessionCheck:\n        commandId: status\n",
			commands: strings.Replace(validCommand, "      authMode: vendor-session\n", "", 1),
			path:     "sessionCheck.commandId",
		},
		{
			name:         "ambiguous whitespace evidence",
			sessionCheck: "      sessionCheck:\n        commandId: status\n        unauthenticatedStderrContains: \" please login \"\n",
			commands:     validCommand,
			path:         "unauthenticatedStderrContains",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse(base(test.sessionCheck, test.commands))
			if err == nil {
				t.Fatal("Parse() succeeded")
			}
			validation, ok := err.(*ValidationError)
			if !ok || validation.Code != ErrSemantic || !strings.Contains(validation.Path, test.path) {
				t.Fatalf("error = %T %v, want semantic path containing %q", err, err, test.path)
			}
		})
	}

	pack, err := Parse(base(
		"      sessionCheck:\n        commandId: status\n        unauthenticatedStderrContains: \"please login\"\n",
		validCommand,
	))
	if err != nil {
		t.Fatalf("valid session check: %v", err)
	}
	check := pack.Runtime.Tools["fixture"].SessionCheck
	if check == nil || check.CommandID != "status" || check.UnauthenticatedStderrContains != "please login" {
		t.Fatalf("session check = %#v", check)
	}
}
