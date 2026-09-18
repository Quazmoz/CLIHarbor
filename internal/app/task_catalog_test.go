package app

import (
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestTaskCatalogExposesOnlyRunnableReadOnlyNonSecretMetadata(t *testing.T) {
	maxLength := 64
	registry, err := packs.NewRegistry([]packs.LoadedPack{{
		Pack: packs.Pack{
			Metadata: packs.Metadata{ID: "fixture", Name: "Fixture Pack", Version: "1.0.0"},
			Runtime: packs.Runtime{Tools: map[string]packs.Tool{
				"ready":   {},
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
					Output: packs.Output{Mode: packs.OutputRaw},
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
		{PackID: "fixture", ToolID: "ready", Status: discovery.StatusReady, Version: "1.2.3"},
		{PackID: "fixture", ToolID: "missing", Status: discovery.StatusMissing},
	})

	catalog := newTaskCatalog(registry, snapshot)
	tasks := catalog.ListTasks()
	if len(tasks) != 1 {
		t.Fatalf("task count = %d, want 1: %#v", len(tasks), tasks)
	}
	task := tasks[0]
	if task.PackID != "fixture" || task.CommandID != "safe" || task.ToolID != "ready" || task.ToolVersion != "1.2.3" {
		t.Fatalf("safe task metadata = %#v", task)
	}
	if len(task.Inputs) != 1 || task.Inputs[0].Validation.MaxLength == nil || *task.Inputs[0].Validation.MaxLength != 64 {
		t.Fatalf("safe task input metadata = %#v", task.Inputs)
	}

	task.Inputs[0].Validation.Enum = append(task.Inputs[0].Validation.Enum, "mutated")
	*task.Inputs[0].Validation.MaxLength = 1
	second := catalog.ListTasks()
	if len(second[0].Inputs[0].Validation.Enum) != 0 || second[0].Inputs[0].Validation.MaxLength == nil || *second[0].Inputs[0].Validation.MaxLength != 64 {
		t.Fatal("task metadata returned shared validation state")
	}
}
