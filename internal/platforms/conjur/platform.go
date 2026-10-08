// Package conjur is CLIHarbor's dedicated CyberArk Conjur platform: guided
// sign-in, execution-context resolution for mutating commands, and the
// metadata-first regex explorer with explicit opt-in value scans. It builds on the generic pack
// engine and the first-party cyberark-conjur-v9 pack.
package conjur

import (
	"context"
	"runtime"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
	"github.com/Quazmoz/CLIHarbor/internal/platforms"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/Quazmoz/CLIHarbor/internal/toolbootstrap"
)

// Feature IDs are a closed set shared with the frontend route table.
const (
	FeatureTasks         = "tasks"
	FeatureSignIn        = "sign-in"
	FeatureSecurityAudit = "security-audit"
	FeatureAccessExplorer = "access-explorer"
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
		Summary: "Guided sign-in, approved inventory and access tools, approval-gated secret changes, and a metadata-first regex pattern explorer.",
		PackID:  PackID,
		ToolID:  ToolID,
		Features: []server.PlatformFeature{
			{ID: FeatureTasks, Name: "Conjur tasks"},
			{ID: FeatureSignIn, Name: "Sign in"},
			{ID: FeatureSecurityAudit, Name: "Security audit"},
			{ID: FeatureAccessExplorer, Name: "Access & permissions"},
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

// AutoSetup is Conjur's reviewed Windows amd64 bootstrap (ADR-025).
var AutoSetup = platforms.AutoSetup{
	Ref:             ConjurRef,
	ShortName:       "Conjur",
	DisplayName:     "CyberArk Conjur CLI",
	Version:         ConjurVersion,
	FailureGuidance: "Automatic Conjur setup could not complete. CLIHarbor did not bypass device policy; use an approved existing Conjur installation or allow the pinned CyberArk download and restart CLIHarbor.",
	Supported:       func() bool { return runtime.GOOS == "windows" && runtime.GOARCH == "amd64" },
	NewProvisioner:  func() toolbootstrap.Provisioner { return NewConjurProvisioner() },
}
