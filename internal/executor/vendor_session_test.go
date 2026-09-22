package executor

import (
	"context"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestRunAllowsReadOnlyVendorSessionPlan(t *testing.T) {
	t.Setenv(helperEnv, "1")
	plan := helperPlan(t, "echo", "vendor-session")
	plan.Requirements = packs.Requirements{
		RequiresAuth: true,
		AuthMode:     packs.AuthModeVendorSession,
	}
	collector := &eventCollector{}
	result, err := testExecutor(2*time.Second, 1<<20).Run(context.Background(), plan, collector)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusExited || result.ExitCode != 0 {
		t.Fatalf("result = %#v", result)
	}
	if got := string(joinEventData(collector.Events(), EventStdout)); got != "stdout:vendor-session" {
		t.Fatalf("stdout = %q", got)
	}
}
