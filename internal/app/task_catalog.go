package app

import (
	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

type taskCatalog struct {
	tasks []server.Task
	tools []server.ToolDiagnostic
}

func newTaskCatalog(registry *packs.Registry, snapshot discovery.Snapshot) *taskCatalog {
	catalog := &taskCatalog{}
	if registry == nil {
		return catalog
	}
	for _, state := range snapshot.Tools() {
		loaded, ok := registry.FindPack(state.PackID)
		if !ok {
			continue
		}
		catalog.tools = append(catalog.tools, server.ToolDiagnostic{
			PackID:            state.PackID,
			PackName:          loaded.Pack.Metadata.Name,
			PackVersion:       state.PackVersion,
			ToolID:            state.ToolID,
			Status:            string(state.Status),
			Version:           state.Version,
			VersionConstraint: state.VersionConstraint,
			Message:           state.Message,
		})
	}
	for _, loaded := range registry.Packs() {
		packID := loaded.Pack.Metadata.ID
		for _, named := range registry.Commands(packID) {
			command := named.Command
			if command.Risk != packs.RiskRead || command.Requirements.RequiresAuth || command.Output.Sensitivity.ContainsSecrets {
				continue
			}
			tool, ok := snapshot.Find(discovery.ToolRef{PackID: packID, ToolID: command.Tool})
			if !ok || !tool.Healthy() {
				continue
			}
			task := server.Task{
				PackID:      packID,
				PackName:    loaded.Pack.Metadata.Name,
				CommandID:   named.ID,
				Name:        command.Name,
				Description: command.Description,
				ToolID:      command.Tool,
				ToolVersion: tool.Version,
				Inputs:      make([]server.TaskInput, len(command.Inputs)),
			}
			for i, input := range command.Inputs {
				task.Inputs[i] = server.TaskInput{
					ID:       input.ID,
					Type:     string(input.Type),
					Label:    input.Label,
					Required: input.Required,
					Validation: server.TaskInputValidation{
						Min:                 input.Validation.Min,
						Max:                 input.Validation.Max,
						MinLength:           input.Validation.MinLength,
						MaxLength:           input.Validation.MaxLength,
						Pattern:             input.Validation.Pattern,
						Enum:                append([]string(nil), input.Validation.Enum...),
						DisallowLeadingDash: input.Validation.DisallowLeadingDash,
					},
				}
			}
			catalog.tasks = append(catalog.tasks, task)
		}
	}
	return catalog
}

func (c *taskCatalog) ListTasks() []server.Task {
	if c == nil {
		return nil
	}
	out := make([]server.Task, len(c.tasks))
	for i, task := range c.tasks {
		out[i] = task
		out[i].Inputs = make([]server.TaskInput, len(task.Inputs))
		for j, input := range task.Inputs {
			out[i].Inputs[j] = input
			out[i].Inputs[j].Validation.Min = cloneInt64Pointer(input.Validation.Min)
			out[i].Inputs[j].Validation.Max = cloneInt64Pointer(input.Validation.Max)
			out[i].Inputs[j].Validation.MinLength = cloneIntPointer(input.Validation.MinLength)
			out[i].Inputs[j].Validation.MaxLength = cloneIntPointer(input.Validation.MaxLength)
			out[i].Inputs[j].Validation.Enum = append([]string(nil), input.Validation.Enum...)
		}
	}
	return out
}

func (c *taskCatalog) ListTools() []server.ToolDiagnostic {
	if c == nil {
		return nil
	}
	return append([]server.ToolDiagnostic(nil), c.tools...)
}

func cloneInt64Pointer(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneIntPointer(value *int) *int {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
