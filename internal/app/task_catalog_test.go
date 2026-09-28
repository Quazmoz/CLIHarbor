package app

import (
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

func TestTaskCatalogExposesOnlyRunnableReadOnlyNonSecretMetadata(t *testing.T) {
	maxLength := 64
	registry, err := packs.NewRegistry([]packs.LoadedPack{{
		Pack: packs.Pack{
			Metadata: packs.Metadata{ID: "fixture", Name: "Fixture Pack", Version: "1.0.0"},
			Runtime: packs.Runtime{Tools: map[string]packs.Tool{
				"ready":   {SessionCheck: &packs.SessionCheck{CommandID: "session", UnauthenticatedStderrContains: "sign in"}},
				"missing": {},
			}},
			Commands: map[string]packs.Command{
				"safe": {
					Name: "Safe inspect", Description: "Read-only fixture task", Tool: "ready", Risk: packs.RiskRead,
					Inputs: []packs.Input{{
						ID: "query", Type: packs.InputString, Label: "Query", Required: true,
						Validation: packs.InputValidation{MaxLength: &maxLength, DisallowLeadingDash: true},
					}},
					Output: packs.Output{Mode: packs.OutputRaw},
				},
				"change": {
					Name: "Change", Tool: "ready", Risk: packs.RiskChange,
					Output: packs.Output{Mode: packs.OutputRaw},
				},
				"auth": {
					Name: "Auth", Tool: "ready", Risk: packs.RiskRead,
					Requirements: packs.Requirements{RequiresAuth: true},
					Output:       packs.Output{Mode: packs.OutputRaw},
				},
				"session": {
					Name: "Session status", Tool: "ready", Risk: packs.RiskRead,
					Requirements: packs.Requirements{RequiresAuth: true, AuthMode: packs.AuthModeVendorSession},
					Output:       packs.Output{Mode: packs.OutputRaw},
				},
				"secret": {
					Name: "Secret", Tool: "ready", Risk: packs.RiskRead,
					Output: packs.Output{Mode: packs.OutputRaw, Sensitivity: packs.Sensitivity{ContainsSecrets: true}},
				},
				"unavailable": {
					Name: "Unavailable", Tool: "missing", Risk: packs.RiskRead,
					Output: packs.Output{Mode: packs.OutputRaw},
				},
			},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}

	snapshot := discovery.NewSnapshot([]discovery.ToolState{
		{PackID: "fixture", PackVersion: "1.0.0", ToolID: "ready", Status: discovery.StatusReady, Version: "1.2.3", VersionConstraint: ">=1.0.0"},
		{PackID: "fixture", PackVersion: "1.0.0", ToolID: "missing", Status: discovery.StatusMissing, Message: "tool is unavailable"},
	})

	catalog := newTaskCatalog(registry, snapshot)
	tools := catalog.ListTools()
	if len(tools) != 2 {
		t.Fatalf("tool diagnostic count = %d, want 2: %#v", len(tools), tools)
	}
	if tools[0].PackID != "fixture" || tools[0].PackName != "Fixture Pack" || tools[0].PackVersion != "1.0.0" || tools[0].ToolID != "missing" || tools[0].Status != string(discovery.StatusMissing) || tools[0].Message != "Tool was not found. Install it or configure an explicit backend tool path." {
		t.Fatalf("missing tool diagnostic = %#v", tools[0])
	}
	if tools[1].ToolID != "ready" || tools[1].Status != string(discovery.StatusReady) || tools[1].Version != "1.2.3" || tools[1].VersionConstraint != ">=1.0.0" {
		t.Fatalf("ready tool diagnostic = %#v", tools[1])
	}
	if !tools[1].RequiresVendorSession || tools[1].SessionCheck == nil || tools[1].SessionCheck.CommandID != "session" || tools[1].SessionCheck.UnauthenticatedStderrContains != "sign in" {
		t.Fatalf("ready vendor-session metadata = %#v", tools[1])
	}

	tasks := catalog.ListTasks()
	if len(tasks) != 2 {
		t.Fatalf("task count = %d, want 2: %#v", len(tasks), tasks)
	}
	var task server.Task
	for _, candidate := range tasks {
		if candidate.CommandID == "safe" {
			task = candidate
			break
		}
	}
	if task.CommandID == "" || task.PackID != "fixture" || task.ToolID != "ready" || task.ToolVersion != "1.2.3" {
		t.Fatalf("safe task metadata = %#v", task)
	}
	if len(task.Inputs) != 1 || task.Inputs[0].Validation.MaxLength == nil || *task.Inputs[0].Validation.MaxLength != 64 {
		t.Fatalf("safe task input metadata = %#v", task.Inputs)
	}

	task.Inputs[0].Validation.Enum = append(task.Inputs[0].Validation.Enum, "mutated")
	*task.Inputs[0].Validation.MaxLength = 1
	tools[1].SessionCheck.CommandID = "mutated"

	second := catalog.ListTasks()
	var secondSafe server.Task
	for _, candidate := range second {
		if candidate.CommandID == "safe" {
			secondSafe = candidate
			break
		}
	}
	if secondSafe.CommandID == "" || len(secondSafe.Inputs[0].Validation.Enum) != 0 || secondSafe.Inputs[0].Validation.MaxLength == nil || *secondSafe.Inputs[0].Validation.MaxLength != 64 {
		t.Fatal("task metadata returned shared validation state")
	}
	secondTools := catalog.ListTools()
	if secondTools[1].SessionCheck == nil || secondTools[1].SessionCheck.CommandID != "session" {
		t.Fatal("tool metadata returned shared session-check state")
	}
}
