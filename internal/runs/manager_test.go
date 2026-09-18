package runs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/structured"
)

const managerHelperEnv = "CLIHARBOR_RUN_MANAGER_HELPER"

func TestManagerExecutesAuthorizedPlanAndReturnsBoundedSnapshot(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	registry, snapshot := managerFixture(t)
	manager := newTestManager(t, registry, snapshot, Config{
		MaxActive:               2,
		MaxRetained:             4,
		MaxOutputBytesPerStream: 1024,
		MaxEventBytesPerRun:     4096,
		NewRunID:                fixedRunIDs(strings.Repeat("a", 32)),
	})

	started, err := manager.Start(Request{
		PackID:    "fixture",
		CommandID: "inspect",
		Values: map[string]json.RawMessage{
			"query": rawRunJSON(t, "snow 雪 & | ;"),
		},
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if started.Status != StatusRunning || started.RunID != strings.Repeat("a", 32) || started.StartedAt != nil {
		t.Fatalf("initial snapshot = %#v", started)
	}

	waitCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	finished, err := manager.Wait(waitCtx, started.RunID)
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if finished.Status != StatusExited || finished.ExitCode == nil || *finished.ExitCode != 0 || finished.StartedAt == nil || finished.EndedAt == nil {
		t.Fatalf("finished snapshot = %#v", finished)
	}

	stdout := decodeEventData(t, finished.Events, "stdout.chunk")
	if got := string(stdout); got != "stdout:snow 雪 & | ;" {
		t.Fatalf("stdout = %q", got)
	}
	if len(finished.Events) < 3 {
		t.Fatalf("events = %#v", finished.Events)
	}
	for i, event := range finished.Events {
		if event.Sequence != uint64(i+1) {
			t.Fatalf("event sequence[%d] = %d, want %d", i, event.Sequence, i+1)
		}
	}

	encoded, err := json.Marshal(finished)
	if err != nil {
		t.Fatal(err)
	}
	executable, _, _ := currentManagerExecutable(t)
	if strings.Contains(string(encoded), executable) || strings.Contains(string(encoded), "-test.run") {
		t.Fatalf("browser snapshot leaked executable or argv authority: %s", encoded)
	}
}

func TestManagerEnforcesCapacityAndReleasesSlotAfterCancellation(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	registry, snapshot := managerFixture(t)
	manager := newTestManager(t, registry, snapshot, Config{
		MaxActive:               1,
		MaxRetained:             3,
		MaxOutputBytesPerStream: 1024,
		MaxEventBytesPerRun:     4096,
		NewRunID: fixedRunIDs(
			strings.Repeat("a", 32),
			strings.Repeat("b", 32),
			strings.Repeat("c", 32),
		),
	})

	first, err := manager.Start(Request{PackID: "fixture", CommandID: "wait"})
	if err != nil {
		t.Fatalf("first Start() error = %v", err)
	}
	_, err = manager.Start(Request{PackID: "fixture", CommandID: "inspect", Values: map[string]json.RawMessage{"query": rawRunJSON(t, "second")}})
	assertRunCode(t, err, ErrCapacity)

	if err := manager.Cancel(first.RunID); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	waitCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	cancelled, err := manager.Wait(waitCtx, first.RunID)
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if cancelled.Status != StatusCancelled {
		t.Fatalf("status = %s, want cancelled", cancelled.Status)
	}

	second, err := manager.Start(Request{PackID: "fixture", CommandID: "inspect", Values: map[string]json.RawMessage{"query": rawRunJSON(t, "second")}})
	if err != nil {
		t.Fatalf("second Start() after cancellation error = %v", err)
	}
	finished, err := manager.Wait(waitCtx, second.RunID)
	if err != nil {
		t.Fatalf("second Wait() error = %v", err)
	}
	if finished.Status != StatusExited {
		t.Fatalf("second status = %s, want exited", finished.Status)
	}
}

func TestManagerDuplicateReadRequestsCreateDistinctRuns(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	registry, snapshot := managerFixture(t)
	manager := newTestManager(t, registry, snapshot, Config{
		MaxActive:               2,
		MaxRetained:             4,
		MaxOutputBytesPerStream: 1024,
		MaxEventBytesPerRun:     4096,
		NewRunID: fixedRunIDs(
			strings.Repeat("2", 32),
			strings.Repeat("3", 32),
		),
	})

	request := Request{
		PackID:    "fixture",
		CommandID: "inspect",
		Values:    map[string]json.RawMessage{"query": rawRunJSON(t, "same")},
	}
	first, err := manager.Start(request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.Start(request)
	if err != nil {
		t.Fatal(err)
	}
	if first.RunID == second.RunID {
		t.Fatalf("duplicate read requests shared run id %q", first.RunID)
	}

	waitCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for _, runID := range []string{first.RunID, second.RunID} {
		finished, err := manager.Wait(waitCtx, runID)
		if err != nil {
			t.Fatal(err)
		}
		if finished.Status != StatusExited {
			t.Fatalf("run %s status = %s, want exited", runID, finished.Status)
		}
	}
}

func TestManagerShutdownCancelsActiveRuns(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	registry, snapshot := managerFixture(t)
	manager, err := NewManager(t.Context(), registry, snapshot, Config{
		MaxActive:               1,
		MaxRetained:             2,
		MaxOutputBytesPerStream: 1024,
		MaxEventBytesPerRun:     4096,
		NewRunID:                fixedRunIDs(strings.Repeat("d", 32)),
	})
	if err != nil {
		t.Fatal(err)
	}

	run, err := manager.Start(Request{PackID: "fixture", CommandID: "wait"})
	if err != nil {
		t.Fatal(err)
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := manager.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	snapshotAfter, ok := manager.Get(run.RunID)
	if !ok {
		t.Fatal("run disappeared during shutdown")
	}
	if snapshotAfter.Status != StatusCancelled {
		t.Fatalf("status = %s, want cancelled", snapshotAfter.Status)
	}

	_, err = manager.Start(Request{PackID: "fixture", CommandID: "inspect", Values: map[string]json.RawMessage{"query": rawRunJSON(t, "blocked")}})
	assertRunCode(t, err, ErrClosed)
}

func TestManagerEvictsCompletedRunsButNeverActiveRuns(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	registry, snapshot := managerFixture(t)
	manager := newTestManager(t, registry, snapshot, Config{
		MaxActive:               1,
		MaxRetained:             1,
		MaxOutputBytesPerStream: 1024,
		MaxEventBytesPerRun:     4096,
		NewRunID: fixedRunIDs(
			strings.Repeat("e", 32),
			strings.Repeat("f", 32),
		),
	})

	first, err := manager.Start(Request{PackID: "fixture", CommandID: "inspect", Values: map[string]json.RawMessage{"query": rawRunJSON(t, "first")}})
	if err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if _, err := manager.Wait(waitCtx, first.RunID); err != nil {
		t.Fatal(err)
	}

	second, err := manager.Start(Request{PackID: "fixture", CommandID: "inspect", Values: map[string]json.RawMessage{"query": rawRunJSON(t, "second")}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := manager.Get(first.RunID); ok {
		t.Fatal("completed run was not evicted at retention bound")
	}
	if _, ok := manager.Get(second.RunID); !ok {
		t.Fatal("new run missing")
	}
}

func TestManagerFailsClosedOnPlannerPolicyAndOutputLimit(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	registry, snapshot := managerFixture(t)
	manager := newTestManager(t, registry, snapshot, Config{
		MaxActive:               1,
		MaxRetained:             2,
		MaxOutputBytesPerStream: 64,
		MaxEventBytesPerRun:     256,
		NewRunID:                fixedRunIDs(strings.Repeat("1", 32)),
	})

	_, err := manager.Start(Request{PackID: "fixture", CommandID: "change"})
	assertRunCode(t, err, ErrUnavailable)

	run, err := manager.Start(Request{PackID: "fixture", CommandID: "flood"})
	if err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	finished, err := manager.Wait(waitCtx, run.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", finished.Status)
	}
}


func TestManagerStructuredOutputFixtureMatrixPreservesRawEvidence(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	tests := []struct {
		name       string
		scenario   string
		status     structured.Status
		code       structured.ErrorCode
		exitCode   int
		wantName   string
		wantStderr string
	}{
		{name: "valid", scenario: "valid", status: structured.StatusAvailable, wantName: "fixture"},
		{name: "malformed json", scenario: "malformed", status: structured.StatusInvalid, code: structured.ErrMalformedJSON},
		{name: "wrong type", scenario: "wrong-type", status: structured.StatusInvalid, code: structured.ErrWrongType},
		{name: "unknown field", scenario: "unknown", status: structured.StatusInvalid, code: structured.ErrUnexpectedField},
		{name: "large output", scenario: "large", status: structured.StatusInvalid, code: structured.ErrOutputTooLarge},
		{name: "markup string", scenario: "markup", status: structured.StatusAvailable, wantName: "<script>alert(1)</script>"},
		{name: "nonzero", scenario: "nonzero", status: structured.StatusUnavailable, code: structured.ErrNonzeroExit, exitCode: 7},
		{name: "stdout and stderr", scenario: "stderr", status: structured.StatusAvailable, wantName: "mixed", wantStderr: "fixture warning"},
		{name: "unicode", scenario: "unicode", status: structured.StatusAvailable, wantName: "雪 café"},
		{name: "secret-like unknown", scenario: "secret", status: structured.StatusInvalid, code: structured.ErrUnexpectedField},
		{name: "duplicate keys", scenario: "duplicate", status: structured.StatusInvalid, code: structured.ErrDuplicateKey},
		{name: "invalid utf8", scenario: "invalid-utf8", status: structured.StatusInvalid, code: structured.ErrInvalidEncoding},
		{name: "integer overflow", scenario: "overflow", status: structured.StatusInvalid, code: structured.ErrInvalidInteger},
		{name: "nested object", scenario: "nested", status: structured.StatusInvalid, code: structured.ErrWrongType},
		{name: "ansi control", scenario: "control", status: structured.StatusInvalid, code: structured.ErrUnsafeControl},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry, snapshot := managerFixture(t)
			manager := newTestManager(t, registry, snapshot, Config{
				MaxActive: 1, MaxRetained: 2,
				MaxOutputBytesPerStream: 128 << 10, MaxEventBytesPerRun: 256 << 10,
				NewRunID: fixedRunIDs(fmt.Sprintf("%032x", index+1)),
			})
			run, err := manager.Start(Request{
				PackID: "fixture", CommandID: "structured",
				Values: map[string]json.RawMessage{"scenario": rawRunJSON(t, test.scenario)},
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
			if finished.Status != StatusExited || finished.ExitCode == nil || *finished.ExitCode != test.exitCode {
				t.Fatalf("run state = %#v", finished)
			}
			if finished.Structured == nil || finished.Structured.Status != test.status || finished.Structured.Error != test.code {
				t.Fatalf("structured = %#v, want %s/%s", finished.Structured, test.status, test.code)
			}
			if test.wantName != "" && (len(finished.Structured.Fields) == 0 || finished.Structured.Fields[0].Value != test.wantName) {
				t.Fatalf("structured fields = %#v", finished.Structured.Fields)
			}
			if len(decodeEventData(t, finished.Events, "stdout.chunk")) == 0 {
				t.Fatal("raw stdout evidence was not retained")
			}
			if test.wantStderr != "" && string(decodeEventData(t, finished.Events, "stderr.chunk")) != test.wantStderr {
				t.Fatalf("stderr evidence missing")
			}
			started := 0
			for _, event := range finished.Events {
				if event.Type == "run.started" {
					started++
				}
			}
			if started != 1 {
				t.Fatalf("run.started events = %d, want one execution", started)
			}
		})
	}
}

func TestManagerHelperProcess(t *testing.T) {
	if os.Getenv(managerHelperEnv) != "1" {
		return
	}
	separator := -1
	for i, arg := range os.Args {
		if arg == "--" {
			separator = i
			break
		}
	}
	if separator < 0 || separator+1 >= len(os.Args) {
		os.Exit(90)
	}
	args := os.Args[separator+1:]

	switch args[0] {
	case "echo":
		if len(args) != 3 || args[1] != "--query" {
			os.Exit(91)
		}
		fmt.Fprint(os.Stdout, "stdout:"+args[2])
		fmt.Fprint(os.Stderr, "stderr")
		os.Exit(0)
	case "wait":
		fmt.Fprintln(os.Stdout, "ready")
		time.Sleep(30 * time.Second)
		os.Exit(0)
	case "flood":
		fmt.Fprint(os.Stdout, strings.Repeat("x", 4096))
		os.Exit(0)
	case "exit":
		code, err := strconv.Atoi(args[1])
		if err != nil {
			os.Exit(92)
		}
		os.Exit(code)
	case "structured":
		if len(args) != 2 {
			os.Exit(94)
		}
		switch args[1] {
		case "valid":
			fmt.Fprint(os.Stdout, `{"name":"fixture","count":7,"ok":true}`)
		case "malformed":
			fmt.Fprint(os.Stdout, `{"name":`)
		case "wrong-type":
			fmt.Fprint(os.Stdout, `{"name":42}`)
		case "unknown":
			fmt.Fprint(os.Stdout, `{"name":"ok","extra":"unexpected"}`)
		case "large":
			fmt.Fprint(os.Stdout, `{"name":"`+strings.Repeat("x", structured.MaxInputBytes+1024)+`"}`)
		case "markup":
			fmt.Fprint(os.Stdout, `{"name":"<script>alert(1)</script>"}`)
		case "nonzero":
			fmt.Fprint(os.Stdout, `{"name":"looks-successful"}`)
			os.Exit(7)
		case "stderr":
			fmt.Fprint(os.Stdout, `{"name":"mixed"}`)
			fmt.Fprint(os.Stderr, "fixture warning")
		case "unicode":
			fmt.Fprint(os.Stdout, `{"name":"雪 café"}`)
		case "secret":
			fmt.Fprint(os.Stdout, `{"name":"ok","token":"do-not-render"}`)
		case "duplicate":
			fmt.Fprint(os.Stdout, `{"name":"one","name":"two"}`)
		case "invalid-utf8":
			data := append([]byte(`{"name":"bad`), byte(0xff))
			data = append(data, []byte(`"}`)...)
			_, _ = os.Stdout.Write(data)
		case "overflow":
			fmt.Fprint(os.Stdout, `{"name":"ok","count":9223372036854775808}`)
		case "nested":
			fmt.Fprint(os.Stdout, `{"name":{"deep":{"deeper":"x"}}}`)
		case "control":
			fmt.Fprint(os.Stdout, `{"name":"\u001b[31mred"}`)
		default:
			os.Exit(95)
		}
		os.Exit(0)
	default:
		os.Exit(93)
	}
}

func managerFixture(t *testing.T) (*packs.Registry, discovery.Snapshot) {
	t.Helper()
	executable, executableName, identity := currentManagerExecutable(t)
	maxLength := 256
	pack := packs.Pack{
		Metadata: packs.Metadata{ID: "fixture", Name: "Fixture", Version: "1.0.0"},
		Runtime: packs.Runtime{
			Platforms: []string{runtime.GOOS},
			Tools: map[string]packs.Tool{
				"fixture": {ExecutableNames: []string{executableName}},
			},
		},
		Commands: map[string]packs.Command{
			"inspect": {
				Name: "Inspect", Tool: "fixture", Risk: packs.RiskRead,
				Inputs: []packs.Input{{
					ID: "query", Type: packs.InputString, Label: "Query", Required: true,
					Validation: packs.InputValidation{MaxLength: &maxLength, DisallowLeadingDash: true},
				}},
				Argv: []packs.Argument{
					{Literal: "-test.run=^TestManagerHelperProcess$"},
					{Literal: "--"},
					{Literal: "echo"},
					{Flag: &packs.FlagArgument{Name: "--query", ValueFrom: "query"}},
				},
				Output: packs.Output{Mode: packs.OutputRaw},
			},
			"wait": {
				Name: "Wait", Tool: "fixture", Risk: packs.RiskRead,
				Argv: []packs.Argument{
					{Literal: "-test.run=^TestManagerHelperProcess$"},
					{Literal: "--"},
					{Literal: "wait"},
				},
				Output: packs.Output{Mode: packs.OutputRaw},
			},
			"flood": {
				Name: "Flood", Tool: "fixture", Risk: packs.RiskRead,
				Argv: []packs.Argument{
					{Literal: "-test.run=^TestManagerHelperProcess$"},
					{Literal: "--"},
					{Literal: "flood"},
				},
				Output: packs.Output{Mode: packs.OutputRaw},
			},
			"change": {
				Name: "Change", Tool: "fixture", Risk: packs.RiskChange,
				Argv:   []packs.Argument{{Literal: "never-executed"}},
				Output: packs.Output{Mode: packs.OutputRaw},
			},
		},
	}
	scenarios := []string{"valid", "malformed", "wrong-type", "unknown", "large", "markup", "nonzero", "stderr", "unicode", "secret", "duplicate", "invalid-utf8", "overflow", "nested", "control"}
	mappedScenarios := make(map[string]string, len(scenarios))
	for _, scenario := range scenarios {
		mappedScenarios[scenario] = scenario
	}
	pack.Commands["structured"] = packs.Command{
		Name: "Structured", Tool: "fixture", Risk: packs.RiskRead,
		Inputs: []packs.Input{{
			ID: "scenario", Type: packs.InputEnum, Label: "Scenario", Required: true,
			Validation: packs.InputValidation{Enum: scenarios, DisallowLeadingDash: true},
		}},
		Argv: []packs.Argument{
			{Literal: "-test.run=^TestManagerHelperProcess$"},
			{Literal: "--"},
			{Literal: "structured"},
			{Map: &packs.MapArgument{ValueFrom: "scenario", Values: mappedScenarios}},
		},
		Output: packs.Output{
			Mode: packs.OutputJSON, Renderer: "cards",
			Structured: &packs.StructuredOutput{Fields: []packs.StructuredField{
				{Key: "name", Label: "Name", Type: packs.StructuredString, Required: true},
				{Key: "count", Label: "Count", Type: packs.StructuredInteger},
				{Key: "ok", Label: "Healthy", Type: packs.StructuredBoolean},
			}},
		},
	}
	registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: pack}})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := discovery.NewSnapshot([]discovery.ToolState{{
		PackID: "fixture", PackVersion: "1.0.0", ToolID: "fixture",
		Status: discovery.StatusReady, Path: executable, ExecutableName: executableName,
		ExecutableIdentity: identity,
	}})
	return registry, snapshot
}

func currentManagerExecutable(t *testing.T) (string, string, discovery.ExecutableIdentity) {
	t.Helper()
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	path, err = filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	path = filepath.Clean(path)
	identity, err := discovery.CaptureExecutableIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	return path, filepath.Base(path), identity
}

func newTestManager(t *testing.T, registry *packs.Registry, snapshot discovery.Snapshot, config Config) *Manager {
	t.Helper()
	manager, err := NewManager(t.Context(), registry, snapshot, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := manager.Shutdown(shutdownCtx); err != nil {
			t.Errorf("Shutdown() error = %v", err)
		}
	})
	return manager
}

func fixedRunIDs(ids ...string) func() (string, error) {
	var mu sync.Mutex
	index := 0
	return func() (string, error) {
		mu.Lock()
		defer mu.Unlock()
		if index >= len(ids) {
			return "", errors.New("no run ids remaining")
		}
		id := ids[index]
		index++
		return id, nil
	}
}

func rawRunJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func decodeEventData(t *testing.T, events []Event, eventType string) []byte {
	t.Helper()
	var out []byte
	for _, event := range events {
		if event.Type != eventType || event.DataBase64 == "" {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(event.DataBase64)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, data...)
	}
	return out
}

func assertRunCode(t *testing.T, err error, want ErrorCode) {
	t.Helper()
	var runErr *Error
	if !errors.As(err, &runErr) {
		t.Fatalf("error = %T %v, want runs.Error %s", err, err, want)
	}
	if runErr.Code != want {
		t.Fatalf("code = %s, want %s", runErr.Code, want)
	}
}
