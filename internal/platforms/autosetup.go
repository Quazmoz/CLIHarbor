package platforms

import (
	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/toolbootstrap"
)

// AutoSetup is a dedicated platform's reviewed zero-config dependency
// bootstrap (ADR-025). The generic runtime drives it only for the exact tool
// Ref, only when that tool is missing, and only from the embedded default
// packs; custom packs never inherit it.
type AutoSetup struct {
	Ref discovery.ToolRef
	// ShortName and DisplayName appear in operator-facing setup messages,
	// for example "Conjur" and "CyberArk Conjur CLI".
	ShortName   string
	DisplayName string
	Version     string
	// FailureGuidance is the sanitized message shown when setup cannot finish.
	// It must not contain error details from the network or filesystem.
	FailureGuidance string
	// Supported reports whether a reviewed artifact exists for this host.
	Supported func() bool
	// NewProvisioner builds the pinned, byte-verifying provisioner.
	NewProvisioner func() toolbootstrap.Provisioner
}
