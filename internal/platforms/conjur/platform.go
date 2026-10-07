// Package conjur is CLIHarbor's dedicated CyberArk Conjur platform: guided
// sign-in, execution-context resolution for mutating commands, and the
// read-only secret-value security audit. It builds on the generic pack
// engine and the first-party cyberark-conjur-v9 pack.
package conjur

import (
	"context"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

// Feature IDs are a closed set shared with the frontend route table.
const (
	FeatureTasks         = "tasks"
	FeatureSignIn        = "sign-in"
	FeatureSecurityAudit = "security-audit"
)

// Platform bundles the Conjur-specific services behind platforms.Platform.
type Platform struct {
	Login *CredentialLoginService
	Audit *SecretAuditService
}

func New(ctx context.Context, snapshot discovery.Snapshot) *Platform {
	return &Platform{
		Login: NewCredentialLoginService(snapshot),
		Audit: NewSecretAuditService(ctx, snapshot),
	}
}

func (p *Platform) Descriptor() server.Platform {
	return server.Platform{
		ID:      "conjur",
		Name:    "CyberArk Conjur",
		Summary: "Guided sign-in, approval-gated secret and policy tasks, and a read-only secret-value security audit, built and tested for the Conjur CLI.",
		PackID:  PackID,
		ToolID:  ToolID,
		Features: []server.PlatformFeature{
			{ID: FeatureTasks, Name: "Conjur tasks"},
			{ID: FeatureSignIn, Name: "Sign in"},
			{ID: FeatureSecurityAudit, Name: "Security audit"},
		},
	}
}

func (p *Platform) ActivateTool(state discovery.ToolState) {
	p.Login.activateTool(state)
	p.Audit.activate()
}

func (p *Platform) TaskAvailable(packID, commandID string) bool {
	return TaskAvailable(packID, commandID)
}

func (p *Platform) ResolveExecutionContext(plan planner.Plan) (runs.ExecutionContext, error) {
	return ResolveExecutionContext(plan)
}
