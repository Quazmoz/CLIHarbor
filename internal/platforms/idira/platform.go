package idira

import (
	"fmt"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

// Platform is a dedicated read-only Privilege Cloud workspace. Login and MFA
// remain in the vendor's terminal; no PAM mutation context is admitted here.
type Platform struct{}

func New() *Platform { return &Platform{} }

func (p *Platform) Descriptor() server.Platform {
	return server.Platform{
		ID:      "idira",
		Name:    "Idira PAM",
		Summary: "CyberArk Privilege Cloud session readiness and read-only Safe/account metadata through the official idsec CLI.",
		PackID:  PackID,
		ToolID:  ToolID,
		Features: []server.PlatformFeature{
			{ID: "tasks", Name: "Read-only PAM inventory"},
		},
	}
}

func (p *Platform) ActivateTool(discovery.ToolState) {}

func (p *Platform) TaskAvailable(packID, commandID string) bool {
	if packID != PackID {
		return false
	}
	switch commandID {
	case "version", "session-status", "list-safes", "list-accounts":
		return true
	default:
		return false
	}
}

func (p *Platform) ResolveExecutionContext(planner.Plan) (runs.ExecutionContext, error) {
	return runs.ExecutionContext{}, fmt.Errorf("Idira PAM mutation commands are not approved")
}
