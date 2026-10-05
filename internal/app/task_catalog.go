package app

import (
	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

type taskCatalog struct {
	tasks                     []server.Task
	tools                     []server.ToolDiagnostic
	credentialLoginCapability func() (string, string, server.CredentialLoginCapability, bool)
	taskAvailability          func(string, string) bool
}

func newTaskCatalog(registry *packs.Registry, snapshot discovery.Snapshot) *taskCatalog {
	catalog := &taskCatalog{}
	if registry == nil {
		return catalog
	}

	vendorSessionTools := make(map[discovery.ToolRef]bool)
	for _, loaded := range registry.Packs() {
		for _, named := range registry.Commands(loaded.Pack.Metadata.ID) {
			command := named.Command
			if commandBrowserRunnable(command) && command.Requirements.RequiresAuth && command.Requirements.AuthMode == packs.AuthModeVendorSession {
				vendorSessionTools[discovery.ToolRef{PackID: loaded.Pack.Metadata.ID, ToolID: command.Tool}] = true
			}
		}
	}

	for _, state := range snapshot.Tools() {
		loaded, ok := registry.FindPack(state.PackID)
		if !ok {
			continue
		}
		diagnostic := server.ToolDiagnostic{
			PackID:                state.PackID,
			PackName:              loaded.Pack.Metadata.Name,
			PackVersion:           state.PackVersion,
			ToolID:                state.ToolID,
			Status:                string(state.Status),
			Version:               state.Version,
			VersionConstraint:     state.VersionConstraint,
			Message:               browserToolMessage(state.Status),
			RequiresVendorSession: vendorSessionTools[discovery.ToolRef{PackID: state.PackID, ToolID: state.ToolID}],
		}
		if declared, exists := loaded.Pack.Runtime.Tools[state.ToolID]; exists {
			if declared.Install != nil {
				diagnostic.Install = &server.ToolInstallCapability{Version: declared.Install.Version, CustomLocation: true}
			}
			if declared.SessionCheck != nil {
				diagnostic.SessionCheck = &server.VendorSessionCheck{
					CommandID:                     declared.SessionCheck.CommandID,
					UnauthenticatedStderrContains: declared.SessionCheck.UnauthenticatedStderrContains,
				}
			}
		}
		catalog.tools = append(catalog.tools, diagnostic)
	}
	for _, loaded := range registry.Packs() {
		packID := loaded.Pack.Metadata.ID
		for _, named := range registry.Commands(packID) {
			command := named.Command
			if !commandBrowserRunnable(command) {
				continue
			}
			tool, ok := snapshot.Find(discovery.ToolRef{PackID: packID, ToolID: command.Tool})
			if !ok || !tool.Healthy() {
				continue
			}
			task := server.Task{
				PackID:       packID,
				PackName:     loaded.Pack.Metadata.Name,
				CommandID:    named.ID,
				Name:         command.Name,
				Description:  command.Description,
				ToolID:       command.Tool,
				ToolVersion:  tool.Version,
				Risk:         string(command.Risk),
				RequiresAuth: command.Requirements.RequiresAuth,
				Inputs:       make([]server.TaskInput, len(command.Inputs)),
			}
			if command.Impact != nil {
				task.Impact = &server.TaskImpact{
					TargetInput: command.Impact.TargetInput,
					TargetLabel: command.Impact.TargetLabel,
					Effect:      command.Impact.Effect,
					Scope:       string(command.Impact.Scope),
				}
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

func commandBrowserRunnable(command packs.Command) bool {
	if command.Output.Sensitivity.ContainsSecrets {
		return false
	}
	switch command.Risk {
	case packs.RiskRead, packs.RiskChange, packs.RiskDestructive:
	default:
		return false
	}
	return !command.Requirements.RequiresAuth || command.Requirements.AuthMode == packs.AuthModeVendorSession
}

func browserToolMessage(status discovery.Status) string {
	switch status {
	case discovery.StatusReady:
		return ""
	case discovery.StatusMissing:
		return "Tool was not found. Install it or configure an explicit backend tool path."
	case discovery.StatusAmbiguous:
		return "Multiple matching tools were found. Configure an explicit backend tool path."
	case discovery.StatusIncompatible:
		return "Detected tool version does not satisfy the trusted pack requirement."
	case discovery.StatusProbeFailed:
		return "Tool version detection failed. Run cliharbor doctor for local diagnostic details."
	case discovery.StatusInvalidOverride:
		return "Configured backend tool override is invalid. Run cliharbor doctor for local diagnostic details."
	case discovery.StatusIdentityFailed:
		return "Resolved tool identity could not be verified. Run cliharbor doctor for local diagnostic details."
	case discovery.StatusUnsupportedPlatform:
		return "The trusted pack does not support this operating system."
	default:
		return "Tool is unavailable. Run cliharbor doctor for local diagnostic details."
	}
}

func (c *taskCatalog) ListTasks() []server.Task {
	if c == nil {
		return nil
	}
	out := make([]server.Task, 0, len(c.tasks))
	for _, task := range c.tasks {
		if c.taskAvailability != nil && !c.taskAvailability(task.PackID, task.CommandID) {
			continue
		}
		cloned := task
		if task.Impact != nil {
			impact := *task.Impact
			cloned.Impact = &impact
		}
		cloned.Inputs = make([]server.TaskInput, len(task.Inputs))
		for j, input := range task.Inputs {
			cloned.Inputs[j] = input
			cloned.Inputs[j].Validation.Min = cloneInt64Pointer(input.Validation.Min)
			cloned.Inputs[j].Validation.Max = cloneInt64Pointer(input.Validation.Max)
			cloned.Inputs[j].Validation.MinLength = cloneIntPointer(input.Validation.MinLength)
			cloned.Inputs[j].Validation.MaxLength = cloneIntPointer(input.Validation.MaxLength)
			cloned.Inputs[j].Validation.Enum = append([]string(nil), input.Validation.Enum...)
		}
		out = append(out, cloned)
	}
	return out
}

func (c *taskCatalog) setTaskAvailabilityProvider(provider func(string, string) bool) {
	if c != nil {
		c.taskAvailability = provider
	}
}

func (c *taskCatalog) setCredentialLoginCapabilityProvider(provider func() (string, string, server.CredentialLoginCapability, bool)) {
	if c == nil {
		return
	}
	c.credentialLoginCapability = provider
}

func (c *taskCatalog) enableCredentialLogin(packID, toolID string, capability server.CredentialLoginCapability) {
	if c == nil {
		return
	}
	for i := range c.tools {
		tool := &c.tools[i]
		if tool.PackID != packID || tool.ToolID != toolID || tool.Status != string(discovery.StatusReady) || !tool.RequiresVendorSession {
			continue
		}
		cloned := capability
		tool.CredentialLogin = &cloned
	}
}

func (c *taskCatalog) ListTools() []server.ToolDiagnostic {
	if c == nil {
		return nil
	}
	out := make([]server.ToolDiagnostic, len(c.tools))
	for i, tool := range c.tools {
		out[i] = tool
		if tool.SessionCheck != nil {
			check := *tool.SessionCheck
			out[i].SessionCheck = &check
		}
		if tool.CredentialLogin != nil {
			capability := *tool.CredentialLogin
			out[i].CredentialLogin = &capability
		}
		if tool.Install != nil {
			install := *tool.Install
			out[i].Install = &install
		}
	}
	if c.credentialLoginCapability != nil {
		if packID, toolID, capability, ok := c.credentialLoginCapability(); ok {
			for i := range out {
				if out[i].PackID != packID || out[i].ToolID != toolID || out[i].Status != string(discovery.StatusReady) || !out[i].RequiresVendorSession {
					continue
				}
				cloned := capability
				out[i].CredentialLogin = &cloned
			}
		}
	}
	return out
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
