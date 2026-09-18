package runs

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestManagerWaitEventsReplaysFromCursorAndRejectsImpossibleCursor(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	registry, snapshot := managerFixture(t)
	manager := newTestManager(t, registry, snapshot, Config{
		MaxActive:               1,
		MaxRetained:             2,
		MaxOutputBytesPerStream: 1024,
		MaxEventBytesPerRun:     4096,
		NewRunID:                fixedRunIDs(strings.Repeat("9", 32)),
	})

	run, err := manager.Start(Request{
		PackID:    "fixture",
		CommandID: "inspect",
		Values:    map[string]json.RawMessage{"query": rawRunJSON(t, "stream")},
	})
	if err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	finished, err := manager.Wait(waitCtx, run.RunID)
	if err != nil {
		t.Fatal(err)
	}

	batch, err := manager.WaitEvents(waitCtx, run.RunID, 0)
	if err != nil {
		t.Fatalf("WaitEvents() error = %v", err)
	}
	if !batch.Complete || batch.Status != StatusExited || batch.ExitCode == nil || *batch.ExitCode != 0 {
		t.Fatalf("completed batch = %#v", batch)
	}
	if len(batch.Events) != len(finished.Events) || len(batch.Events) < 3 {
		t.Fatalf("events = %d, snapshot events = %d", len(batch.Events), len(finished.Events))
	}

	cursor := batch.Events[0].Sequence
	replay, err := manager.WaitEvents(waitCtx, run.RunID, cursor)
	if err != nil {
		t.Fatalf("replay WaitEvents() error = %v", err)
	}
	if len(replay.Events) != len(batch.Events)-1 {
		t.Fatalf("replay events = %d, want %d", len(replay.Events), len(batch.Events)-1)
	}
	for _, event := range replay.Events {
		if event.Sequence <= cursor {
			t.Fatalf("replayed sequence %d is not after cursor %d", event.Sequence, cursor)
		}
	}

	_, err = manager.WaitEvents(waitCtx, run.RunID, batch.Events[len(batch.Events)-1].Sequence+1)
	assertRunCode(t, err, ErrInvalidCursor)
}
