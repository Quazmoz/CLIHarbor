package toolbootstrap

import (
	"context"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

// Provisioner can provide a reviewed local executable for a missing trusted
// tool. Implementations must not widen the pack's executable/argv authority.
type Provisioner interface {
	Ensure(context.Context, discovery.ToolRef) (path string, installed bool, err error)
}
