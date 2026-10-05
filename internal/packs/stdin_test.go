package packs

import (
	"strings"
	"testing"
)

func TestStdinAndSecretInputContract(t *testing.T) {
	pack := func(risk, stdin, inputs, argv string) []byte {
		return []byte(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: stdin-test
  name: Stdin test
  version: 1.0.0
runtime:
  platforms: [windows]
  tools:
    fixture:
      executableNames: [fixture]
commands:
  mutate:
    name: Mutate
    tool: fixture
    risk: ` + risk + `
    impact:
      targetInput: target
      targetLabel: Target
      effect: Changes the target.
      scope: single
` + stdin + `    inputs:
      - id: target
        type: string
        label: Target
        required: true
        validation:
          maxLength: 64
          disallowLeadingDash: true
      - id: kind
        type: enum
        label: Kind
        required: true
        validation:
          enum: [host, group]
` + inputs + `    argv:
      - literal: mutate
` + argv + `    output:
      mode: raw
`)
	}
	secret := "      - id: value\n        type: secret\n        label: Value\n        required: true\n        validation:\n          maxLength: 64\n"
	template := "    stdin:\n      yamlTemplate: \"- !{{kind}} {{target}}\"\n"

	if _, err := Parse(pack("change", template, "", "")); err != nil {
		t.Fatalf("valid template rejected: %v", err)
	}
	if _, err := Parse(pack("change", "    stdin:\n      input: value\n", secret, "")); err != nil {
		t.Fatalf("valid secret stdin rejected: %v", err)
	}

	for _, tc := range []struct{ name, risk, stdin, inputs, argv string }{
		{name: "secret without stdin", risk: "change", inputs: secret},
		{name: "secret in argv", risk: "change", stdin: "    stdin:\n      input: value\n", inputs: secret, argv: "      - flag:\n          name: --value\n          valueFrom: value\n"},
		{name: "template beside secret", risk: "change", stdin: template, inputs: secret},
		{name: "template on unknown input", risk: "change", stdin: "    stdin:\n      yamlTemplate: \"{{missing}}\"\n"},
		{name: "malformed placeholder", risk: "change", stdin: "    stdin:\n      yamlTemplate: \"{{target}\"\n"},
		{name: "stdin input not secret", risk: "change", stdin: "    stdin:\n      input: target\n"},
		{name: "both stdin forms", risk: "change", stdin: "    stdin:\n      input: value\n      yamlTemplate: \"{{target}}\"\n", inputs: secret},
		{name: "unsafe raw enum", risk: "change", stdin: template, inputs: "      - id: extra\n        type: enum\n        label: Extra\n        required: true\n        validation:\n          enum: [\"a\\n- !user x\"]\n", argv: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := pack(tc.risk, tc.stdin, tc.inputs, tc.argv)
			if tc.name == "unsafe raw enum" {
				data = []byte(strings.Replace(string(data), "{{kind}} {{target}}", "{{extra}} {{target}}", 1))
			}
			_, err := Parse(data)
			if err == nil {
				t.Fatal("Parse() succeeded")
			}
			t.Log(err)
		})
	}
}
