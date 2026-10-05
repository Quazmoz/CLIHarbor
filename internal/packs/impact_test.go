package packs

import (
	"errors"
	"testing"
)

func TestMutationImpactContractRequiresExplicitTargetAndScope(t *testing.T) {
	base := func(risk, impact string) []byte {
		return []byte(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: impact-test
  name: Impact test
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
    risk: ` + risk + "
" + impact + `
    inputs:
      - id: target
        type: string
        label: Target
        required: true
        validation:
          maxLength: 64
          disallowLeadingDash: true
    argv:
      - literal: mutate
      - positional:
          valueFrom: target
    output:
      mode: raw
`)
	}

	validImpact := `    impact:
      targetInput: target
      targetLabel: Target
      effect: Changes the declared target.
      scope: multiple
`
	if _, err := Parse(base("change", validImpact)); err != nil {
		t.Fatalf("valid change impact rejected: %v", err)
	}

	for _, tc := range []struct {
		name   string
		risk   string
		impact string
	}{
		{name: "change missing impact", risk: "change"},
		{name: "destructive missing impact", risk: "destructive"},
		{name: "read cannot claim mutation impact", risk: "read", impact: validImpact},
		{name: "target must exist", risk: "change", impact: `    impact:
      targetInput: other
      targetLabel: Target
      effect: Changes the target.
      scope: single
`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse(base(tc.risk, tc.impact))
			if err == nil {
				t.Fatal("Parse() succeeded, want semantic rejection")
			}
			var validation *ValidationError
			if !errors.As(err, &validation) || validation.Code != ErrSemantic {
				t.Fatalf("error = %T %v, want semantic validation", err, err)
			}
		})
	}
}

func TestMutationImpactTargetMustBeRequiredScalar(t *testing.T) {
	for _, tc := range []struct {
		name      string
		inputType string
		required  string
	}{
		{name: "optional", inputType: "string"},
		{name: "boolean", inputType: "boolean", required: "        required: true\n"},
		{name: "multiselect", inputType: "multiselect", required: "        required: true\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			extraValidation := ""
			if tc.inputType == "multiselect" {
				extraValidation = "          enum: [one, two]\n"
			}
			data := []byte(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: impact-test
  name: Impact test
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
    risk: destructive
    impact:
      targetInput: target
      targetLabel: Target
      effect: Deletes the target.
      scope: single
    inputs:
      - id: target
        type: ` + tc.inputType + "
" + tc.required + `        label: Target
` + func() string {
				if extraValidation == "" {
					return ""
				}
				return "        validation:\n" + extraValidation
			}() + `    argv:
      - literal: mutate
      - positional:
          valueFrom: target
    output:
      mode: raw
`)
			_, err := Parse(data)
			if err == nil {
				t.Fatal("Parse() succeeded, want mutation target rejection")
			}
		})
	}
}
