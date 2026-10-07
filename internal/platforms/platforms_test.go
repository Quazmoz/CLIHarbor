package platforms

import (
	"errors"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

type fakePlatform struct {
	activated []discovery.ToolState
	available bool
}

func (f *fakePlatform) Descriptor() server.Platform {
	return server.Platform{ID: "fake", Name: "Fake", PackID: "fake-pack", ToolID: "fake",
		Features: []server.PlatformFeature{{ID: "tasks", Name: "Tasks"}}}
}
func (f *fakePlatform) ActivateTool(state discovery.ToolState) {
	f.activated = append(f.activated, state)
}
func (f *fakePlatform) TaskAvailable(string, string) bool { return f.available }
func (f *fakePlatform) ResolveExecutionContext(planner.Plan) (runs.ExecutionContext, error) {
	return runs.ExecutionContext{}, errors.New("fake context")
}

func TestSetRoutesHooksToOwningPlatformAndFailsClosedForOthers(t *testing.T) {
	fake := &fakePlatform{}
	set := NewSet(discovery.NewSnapshot([]discovery.ToolState{{PackID: "fake-pack", ToolID: "fake", Status: discovery.StatusMissing}}), fake)

	listed := set.ListPlatforms()
	if len(listed) != 1 || listed[0].ID != "fake" || listed[0].Ready {
		t.Fatalf("ListPlatforms() = %+v, want one not-ready platform", listed)
	}
	if set.TaskAvailable("fake-pack", "anything") {
		t.Fatal("owned pack should defer to the platform")
	}
	if !set.TaskAvailable("generic-pack", "anything") {
		t.Fatal("generic packs must stay available")
	}
	if _, err := set.ResolveExecutionContext(planner.Plan{PackID: "fake-pack", ToolID: "fake"}); err == nil || err.Error() != "fake context" {
		t.Fatalf("owned plan error = %v, want platform resolver", err)
	}
	if _, err := set.ResolveExecutionContext(planner.Plan{PackID: "generic-pack", ToolID: "x"}); err == nil {
		t.Fatal("unowned tools must fail closed")
	}

	set.ActivateTool(discovery.ToolState{PackID: "generic-pack", ToolID: "x", Status: discovery.StatusReady})
	set.ActivateTool(discovery.ToolState{PackID: "fake-pack", ToolID: "fake", Status: discovery.StatusReady})
	if len(fake.activated) != 1 || !set.ListPlatforms()[0].Ready {
		t.Fatalf("activation not routed: %+v / %+v", fake.activated, set.ListPlatforms())
	}
}

func TestSetOmitsPlatformsWhosePackIsNotLoaded(t *testing.T) {
	set := NewSet(discovery.NewSnapshot(nil), &fakePlatform{available: true})
	if got := set.ListPlatforms(); len(got) != 0 {
		t.Fatalf("ListPlatforms() = %+v, want none", got)
	}
	if _, err := set.ResolveExecutionContext(planner.Plan{PackID: "fake-pack", ToolID: "fake"}); err == nil {
		t.Fatal("unloaded platform must not resolve context")
	}
}
