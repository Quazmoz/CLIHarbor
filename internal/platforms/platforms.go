// Package platforms holds CLIHarbor's dedicated CLI integrations.
//
// CLIHarbor has two halves. The generic core (packs, discovery, planner,
// executor, runs) works with any reviewed CLI and must never branch on a
// vendor. A dedicated platform layers behavior that is built and tested for
// one specific CLI on top of that core: guided sign-in, execution-context
// checks, maintenance workflows such as a security audit, and so on.
//
// Each platform lives in its own subpackage (platforms/conjur, ...) and is
// wired into the runtime through Set, so the core sees only this interface.
package platforms

import (
	"fmt"
	"sync"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

// Platform is one dedicated CLI integration bound to exactly one pack tool.
type Platform interface {
	// Descriptor returns the browser-safe description. Ready is filled by Set.
	Descriptor() server.Platform
	// ActivateTool is called when the platform's tool becomes ready after startup
	// (for example after an in-app install).
	ActivateTool(state discovery.ToolState)
	// TaskAvailable lets the platform hide pack commands whose vendor-side
	// preconditions are not met. Only called for the platform's own pack.
	TaskAvailable(packID, commandID string) bool
	// ResolveExecutionContext returns the target context shown on approval for
	// mutating commands. Only called for the platform's own pack tool.
	ResolveExecutionContext(plan planner.Plan) (runs.ExecutionContext, error)
}

// Set is the runtime's view of every dedicated platform. It implements
// server.PlatformService and routes per-pack hooks to the owning platform.
type Set struct {
	mu        sync.RWMutex
	items     []Platform
	available map[string]bool
	ready     map[string]bool
}

// NewSet registers platforms whose tool is declared by a loaded pack. A
// platform whose pack is not loaded (for example --no-default-packs) is
// left out entirely, so its hooks never run.
func NewSet(snapshot discovery.Snapshot, items ...Platform) *Set {
	s := &Set{available: map[string]bool{}, ready: map[string]bool{}}
	for _, item := range items {
		d := item.Descriptor()
		state, ok := snapshot.Find(discovery.ToolRef{PackID: d.PackID, ToolID: d.ToolID})
		if !ok {
			continue
		}
		s.items = append(s.items, item)
		s.available[d.ID] = true
		s.ready[d.ID] = state.Healthy()
	}
	return s
}

func (s *Set) ListPlatforms() []server.Platform {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]server.Platform, 0, len(s.items))
	for _, item := range s.items {
		d := item.Descriptor()
		d.Ready = s.ready[d.ID]
		d.Features = append([]server.PlatformFeature{}, d.Features...)
		out = append(out, d)
	}
	return out
}

func (s *Set) owner(packID, toolID string) Platform {
	for _, item := range s.items {
		d := item.Descriptor()
		if d.PackID == packID && (toolID == "" || d.ToolID == toolID) {
			return item
		}
	}
	return nil
}

// ActivateTool forwards a newly ready tool to the platform that owns it.
func (s *Set) ActivateTool(state discovery.ToolState) {
	item := s.owner(state.PackID, state.ToolID)
	if item == nil {
		return
	}
	item.ActivateTool(state)
	s.mu.Lock()
	s.ready[item.Descriptor().ID] = state.Healthy()
	s.mu.Unlock()
}

// TaskAvailable defers to the owning platform; generic packs are always available.
func (s *Set) TaskAvailable(packID, commandID string) bool {
	if item := s.owner(packID, ""); item != nil {
		return item.TaskAvailable(packID, commandID)
	}
	return true
}

// ResolveExecutionContext fails closed for tools no dedicated platform owns.
func (s *Set) ResolveExecutionContext(plan planner.Plan) (runs.ExecutionContext, error) {
	if item := s.owner(plan.PackID, plan.ToolID); item != nil {
		return item.ResolveExecutionContext(plan)
	}
	return runs.ExecutionContext{}, fmt.Errorf("no reviewed mutation context resolver for %s/%s", plan.PackID, plan.ToolID)
}
