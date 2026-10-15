package runs

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

func TestGuardedOutputNeverStreamsUnvalidatedVendorBytes(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	registry, discovery := managerFixture(t)
	manager := newTestManager(t, registry, discovery, Config{
		MaxOutputBytesPerStream: 1024,
		MaxEventBytesPerRun:     4096,
		OutputGuard:             func(plan planner.Plan) func([]byte) ([]byte, error) {
			if plan.CommandID != "inspect" {
				return nil
			}
			return func(raw []byte) ([]byte, error) {
				if string(raw) != "stdout:approved" {
					return nil, errors.New("quarantined vendor output was unsafe")
				}
				return []byte(`{"safe_name":"reviewed"}`), nil
			}
		},
	})
	for _, test := range []struct {
		query      string
		shouldPass bool
	}{
		{"TOP-SECRET", false},
		{"approved", true},
	} {
		started, err := manager.Start(Request{
			PackID:    "fixture",
			CommandID: "inspect",
			Values:    map[string]json.RawMessage{"query": json.RawMessage(`"` + test.query + `"`)},
		})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		complete, err := manager.Wait(ctx, started.RunID)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		if (complete.Status == StatusExited) != test.shouldPass {
			t.Fatalf("status = %v for query %q", complete.Status, test.query)
		}
		raw := decodeEventData(t, complete.Events, "stdout.chunk")
		if test.shouldPass && string(raw) != `{"safe_name":"reviewed"}` {
			t.Fatalf("filtered output = %s", raw)
		}
		if !test.shouldPass && len(raw) != 0 {
			t.Fatalf("rejected vendor output was persisted: %s", raw)
		}
		snapshot, err := json.Marshal(complete)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(snapshot), "TOP-SECRET") || strings.Contains(string(snapshot), "stderr") ||
			strings.Contains(string(snapshot), "stdout:approved") {
			t.Fatalf("unguarded process bytes became browser-visible: %s", snapshot)
		}
		batch, err := manager.WaitEvents(t.Context(), started.RunID, 0)
		if err != nil {
			t.Fatal(err)
		}
		events, err := json.Marshal(batch)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(events), "TOP-SECRET") || strings.Contains(string(events), "stderr") {
			t.Fatalf("raw process bytes appeared in replay: %s", events)
		}
	}
}
