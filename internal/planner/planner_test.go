package planner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestBuildProducesExactArgvWithoutReparsingUserText(t *testing.T) {
	registry, snapshot := plannerFixture(t, packs.RiskRead, false, false)
	query := `雪 café & | ; > < $ ( ) % ! ^ "quoted"`

	plan, err := Build(registry, snapshot, Request{
		PackID:    "demo",
		CommandID: "inspect",
		Values: map[string]json.RawMessage{
			"query":   rawJSON(t, query),
			"limit":   rawJSON(t, int64(0)),
			"verbose": rawJSON(t, true),
			"mode":    rawJSON(t, "detailed"),
		},
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	want := []string{"inspect", "--query", query, "--limit", "0", "--verbose", "--detailed-mode"}
	if !reflect.DeepEqual(plan.Args, want) {
		t.Fatalf("args = %#v, want %#v", plan.Args, want)
	}
	if filepath.Base(plan.ExecutablePath) != "fixture" || !plan.ExecutableIdentity.Valid() || plan.Risk != packs.RiskRead {
		t.Fatalf("plan authority = %#v", plan)
	}
}

func TestBuildHostileStringCorpusCannotChangeExecutionAuthority(t *testing.T) {
	registry, snapshot := plannerFixture(t, packs.RiskRead, false, false)
	state, ok := snapshot.Find(discovery.ToolRef{PackID: "demo", ToolID: "fixture"})
	if !ok {
		t.Fatal("fixture discovery state missing")
	}

	metacharacters := []rune("&|;><$()%!^\"'`\\\\/*?[]{}=:,+ \t\n\r")
	for _, first := range metacharacters {
		for _, second := range metacharacters {
			query := "x" + string(first) + string(second) + " y"
			plan, err := Build(registry, snapshot, Request{
				PackID:    "demo",
				CommandID: "inspect",
				Values: map[string]json.RawMessage{
					"query": rawJSON(t, query),
					"mode":  rawJSON(t, "safe"),
				},
			})
			if err != nil {
				t.Fatalf("Build() rejected hostile data %q: %v", query, err)
			}

			wantArgs := []string{"inspect", "--query", query, "--safe-mode"}
			if !reflect.DeepEqual(plan.Args, wantArgs) {
				t.Fatalf("query %q args = %#v, want %#v", query, plan.Args, wantArgs)
			}
			if plan.PackID != "demo" || plan.CommandID != "inspect" || plan.ToolID != "fixture" ||
				plan.ExecutablePath != state.Path || plan.ExecutableName != state.ExecutableName ||
				!plan.ExecutableIdentity.Valid() {
				t.Fatalf("query %q changed execution authority: %#v", query, plan)
			}
		}
	}

	for _, query := range []string{
		"雪 café",
		"$(whoami)",
		"%COMSPEC% /c calc",
		"../..\\\\Windows\\\\System32",
		"{\"command\":\"other\"}",
		"line1\n--undeclared-flag=line2",
	} {
		plan, err := Build(registry, snapshot, Request{
			PackID:    "demo",
			CommandID: "inspect",
			Values: map[string]json.RawMessage{
				"query": rawJSON(t, query),
				"mode":  rawJSON(t, "detailed"),
			},
		})
		if err != nil {
			t.Fatalf("Build() rejected hostile data %q: %v", query, err)
		}
		wantArgs := []string{"inspect", "--query", query, "--detailed-mode"}
		if !reflect.DeepEqual(plan.Args, wantArgs) {
			t.Fatalf("query %q args = %#v, want %#v", query, plan.Args, wantArgs)
		}
	}
}
func TestBuildOmitsAbsentAndEmptyOptionalFlags(t *testing.T) {
	registry, snapshot := plannerFixture(t, packs.RiskRead, false, false)
	plan, err := Build(registry, snapshot, Request{
		PackID:    "demo",
		CommandID: "inspect",
		Values: map[string]json.RawMessage{
			"query": rawJSON(t, ""),
			"mode":  rawJSON(t, "safe"),
		},
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	want := []string{"inspect", "--safe-mode"}
	if !reflect.DeepEqual(plan.Args, want) {
		t.Fatalf("args = %#v, want %#v", plan.Args, want)
	}
}

func TestBuildRejectsUnknownMissingAndWrongTypedInputs(t *testing.T) {
	registry, snapshot := plannerFixture(t, packs.RiskRead, false, false)
	tests := []struct {
		name   string
		values map[string]json.RawMessage
		code   ErrorCode
	}{
		{
			name: "unknown",
			values: map[string]json.RawMessage{
				"mode":    rawJSON(t, "safe"),
				"unknown": rawJSON(t, "value"),
			},
			code: ErrUnknownInput,
		},
		{
			name:   "missing required enum",
			values: map[string]json.RawMessage{},
			code:   ErrMissingInput,
		},
		{
			name: "integer as string",
			values: map[string]json.RawMessage{
				"mode":  rawJSON(t, "safe"),
				"limit": rawJSON(t, "3"),
			},
			code: ErrInvalidInput,
		},
		{
			name: "float as integer",
			values: map[string]json.RawMessage{
				"mode":  rawJSON(t, "safe"),
				"limit": json.RawMessage(`3.5`),
			},
			code: ErrInvalidInput,
		},
		{
			name: "enum outside allowlist",
			values: map[string]json.RawMessage{
				"mode": rawJSON(t, "root"),
			},
			code: ErrInvalidInput,
		},
		{
			name: "null input",
			values: map[string]json.RawMessage{
				"mode": json.RawMessage(`null`),
			},
			code: ErrInvalidInput,
		},
		{
			name: "trailing json value",
			values: map[string]json.RawMessage{
				"mode": json.RawMessage(`"safe" "extra"`),
			},
			code: ErrInvalidInput,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Build(registry, snapshot, Request{PackID: "demo", CommandID: "inspect", Values: test.values})
			assertPlannerCode(t, err, test.code)
		})
	}
}

func TestBuildEnforcesRuntimeStringConstraints(t *testing.T) {
	registry, snapshot := plannerFixture(t, packs.RiskRead, false, false)
	for _, query := range []string{"-undeclared-flag", "contains\x00nul", strings.Repeat("x", 65)} {
		_, err := Build(registry, snapshot, Request{
			PackID:    "demo",
			CommandID: "inspect",
			Values: map[string]json.RawMessage{
				"mode":  rawJSON(t, "safe"),
				"query": rawJSON(t, query),
			},
		})
		assertPlannerCode(t, err, ErrInvalidInput)
	}
}

func TestBuildRequiresReadyCurrentDiscoveryState(t *testing.T) {
	registry, snapshot := plannerFixture(t, packs.RiskRead, false, false)
	state, _ := snapshot.Find(discovery.ToolRef{PackID: "demo", ToolID: "fixture"})

	state.Status = discovery.StatusAmbiguous
	_, err := Build(registry, discovery.NewSnapshot([]discovery.ToolState{state}), Request{
		PackID: "demo", CommandID: "inspect", Values: map[string]json.RawMessage{"mode": rawJSON(t, "safe")},
	})
	assertPlannerCode(t, err, ErrToolUnavailable)

	state.Status = discovery.StatusReady
	state.PackVersion = "9.9.9"
	_, err = Build(registry, discovery.NewSnapshot([]discovery.ToolState{state}), Request{
		PackID: "demo", CommandID: "inspect", Values: map[string]json.RawMessage{"mode": rawJSON(t, "safe")},
	})
	assertPlannerCode(t, err, ErrStaleDiscovery)

	state.PackVersion = "1.0.0"
	state.ExecutableIdentity = discovery.ExecutableIdentity{}
	_, err = Build(registry, discovery.NewSnapshot([]discovery.ToolState{state}), Request{
		PackID: "demo", CommandID: "inspect", Values: map[string]json.RawMessage{"mode": rawJSON(t, "safe")},
	})
	assertPlannerCode(t, err, ErrStaleDiscovery)
}

func TestBuildBlocksPoliciesNotImplementedYet(t *testing.T) {
	for _, test := range []struct {
		name         string
		risk         packs.Risk
		requiresAuth bool
		secret       bool
		code         ErrorCode
	}{
		{name: "change", risk: packs.RiskChange, code: ErrRiskPolicy},
		{name: "destructive", risk: packs.RiskDestructive, code: ErrRiskPolicy},
		{name: "interactive", risk: packs.RiskInteractive, code: ErrRiskPolicy},
		{name: "credential sensitive", risk: packs.RiskCredentialSensitive, code: ErrRiskPolicy},
		{name: "auth required", risk: packs.RiskRead, requiresAuth: true, code: ErrAuthPolicy},
		{name: "secret output", risk: packs.RiskRead, secret: true, code: ErrOutputPolicy},
	} {
		t.Run(test.name, func(t *testing.T) {
			registry, snapshot := plannerFixture(t, test.risk, test.requiresAuth, test.secret)
			_, err := Build(registry, snapshot, Request{
				PackID: "demo", CommandID: "inspect", Values: map[string]json.RawMessage{"mode": rawJSON(t, "safe")},
			})
			assertPlannerCode(t, err, test.code)
		})
	}
}

func TestPlanCloneDoesNotShareArgSlice(t *testing.T) {
	registry, snapshot := plannerFixture(t, packs.RiskRead, false, false)
	plan, err := Build(registry, snapshot, Request{
		PackID: "demo", CommandID: "inspect", Values: map[string]json.RawMessage{"mode": rawJSON(t, "safe")},
	})
	if err != nil {
		t.Fatal(err)
	}
	plan.Output.Structured = &packs.StructuredOutput{Fields: []packs.StructuredField{{Key: "name", Label: "Name", Type: packs.StructuredString}}}
	clone := plan.Clone()
	clone.Args[0] = "mutated"
	clone.Output.Structured.Fields[0].Key = "tampered"
	if plan.Args[0] != "inspect" {
		t.Fatalf("plan mutated through clone: %#v", plan.Args)
	}
	if plan.Output.Structured.Fields[0].Key != "name" {
		t.Fatal("structured output mutated through plan clone")
	}
}

func plannerFixture(t *testing.T, risk packs.Risk, requiresAuth, secret bool) (*packs.Registry, discovery.Snapshot) {
	t.Helper()
	min := int64(0)
	max := int64(100)
	maxLength := 64
	pack := packs.Pack{
		Metadata: packs.Metadata{ID: "demo", Name: "Demo", Version: "1.0.0"},
		Runtime: packs.Runtime{
			Platforms: []string{"linux"},
			Tools: map[string]packs.Tool{
				"fixture": {ExecutableNames: []string{"fixture"}},
			},
		},
		Commands: map[string]packs.Command{
			"inspect": {
				Name: "Inspect",
				Tool: "fixture",
				Risk: risk,
				Inputs: []packs.Input{
					{ID: "query", Type: packs.InputString, Label: "Query", Validation: packs.InputValidation{MaxLength: &maxLength, DisallowLeadingDash: true}},
					{ID: "limit", Type: packs.InputInteger, Label: "Limit", Validation: packs.InputValidation{Min: &min, Max: &max}},
					{ID: "verbose", Type: packs.InputBoolean, Label: "Verbose"},
					{ID: "mode", Type: packs.InputEnum, Label: "Mode", Required: true, Validation: packs.InputValidation{Enum: []string{"safe", "detailed"}, DisallowLeadingDash: true}},
				},
				Argv: []packs.Argument{
					{Literal: "inspect"},
					{Flag: &packs.FlagArgument{Name: "--query", ValueFrom: "query", OmitWhenEmpty: true}},
					{Flag: &packs.FlagArgument{Name: "--limit", ValueFrom: "limit", OmitWhenEmpty: true}},
					{Switch: &packs.SwitchArgument{Name: "--verbose", EnabledFrom: "verbose"}},
					{Map: &packs.MapArgument{ValueFrom: "mode", Values: map[string]string{"safe": "--safe-mode", "detailed": "--detailed-mode"}}},
				},
				Output:       packs.Output{Mode: packs.OutputRaw, Sensitivity: packs.Sensitivity{ContainsSecrets: secret}},
				Requirements: packs.Requirements{RequiresAuth: requiresAuth},
			},
		},
	}
	registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: pack}})
	if err != nil {
		t.Fatal(err)
	}
	executablePath := filepath.Join(t.TempDir(), "fixture")
	if err := os.WriteFile(executablePath, []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	identity, err := discovery.CaptureExecutableIdentity(executablePath)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := discovery.NewSnapshot([]discovery.ToolState{{
		PackID: "demo", PackVersion: "1.0.0", ToolID: "fixture", Status: discovery.StatusReady,
		Path: executablePath, ExecutableName: "fixture", Version: "1.2.3", ExecutableIdentity: identity,
	}})
	return registry, snapshot
}

func rawJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func assertPlannerCode(t *testing.T, err error, want ErrorCode) {
	t.Helper()
	plannerErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("error = %T %v, want planner.Error code %s", err, err, want)
	}
	if plannerErr.Code != want {
		t.Fatalf("code = %s, want %s (error %v)", plannerErr.Code, want, err)
	}
}
