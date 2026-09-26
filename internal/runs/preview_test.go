package runs

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestManagerPreviewUsesPlannerWithoutStartingRun(t *testing.T) {
	registry, snapshot := managerFixture(t)
	manager := newTestManager(t, registry, snapshot, Config{})

	preview, err := manager.Preview(Request{
		PackID:    "fixture",
		CommandID: "inspect",
		Values:    map[string]json.RawMessage{"query": rawRunJSON(t, "hello world")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if preview.PackID != "fixture" || preview.CommandID != "inspect" || preview.ToolID != "fixture" {
		t.Fatalf("preview identity = %#v", preview)
	}
	if preview.ExecutableName == "" || strings.ContainsAny(preview.ExecutableName, `/\\`) {
		t.Fatalf("preview executable name = %q, want basename only", preview.ExecutableName)
	}
	wantArgs := []string{"-test.run=^TestManagerHelperProcess$", "--", "echo", "--query", "hello world"}
	if len(preview.Args) != len(wantArgs) {
		t.Fatalf("preview args = %#v, want %#v", preview.Args, wantArgs)
	}
	for i := range wantArgs {
		if preview.Args[i] != wantArgs[i] {
			t.Fatalf("preview args[%d] = %q, want %q", i, preview.Args[i], wantArgs[i])
		}
	}
	if got := manager.List(); len(got) != 0 {
		t.Fatalf("Preview() created retained runs: %#v", got)
	}
}

func TestManagerPreviewFailsClosedOnExecutionPolicy(t *testing.T) {
	registry, snapshot := managerFixture(t)
	manager := newTestManager(t, registry, snapshot, Config{})

	_, err := manager.Preview(Request{PackID: "fixture", CommandID: "change"})
	assertRunCode(t, err, ErrPolicyBlocked)
}
