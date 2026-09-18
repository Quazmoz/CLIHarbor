package executor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

const helperEnv = "CLIHARBOR_EXECUTOR_HELPER"

func TestRunStreamsStdoutStderrAndPreservesArgBoundaries(t *testing.T) {
	t.Setenv(helperEnv, "1")
	argument := `a & b | c ; > < $ ( ) % ! ^ "quoted"`
	plan := helperPlan(t, "echo", argument)
	collector := &eventCollector{}
	executor := testExecutor(2*time.Second, 1<<20)

	result, err := executor.Run(context.Background(), plan, collector)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusExited || result.ExitCode != 0 || result.RunID != "test-run" {
		t.Fatalf("result = %#v", result)
	}
	events := collector.Events()
	if len(events) < 4 || events[0].Type != EventStarted || events[len(events)-1].Type != EventExited {
		t.Fatalf("event sequence = %#v", eventTypes(events))
	}
	if got := string(joinEventData(events, EventStdout)); got != "stdout:"+argument {
		t.Fatalf("stdout = %q", got)
	}
	if got := string(joinEventData(events, EventStderr)); got != "stderr" {
		t.Fatalf("stderr = %q", got)
	}
}

func TestRunPreservesNonZeroExitAsProcessResult(t *testing.T) {
	t.Setenv(helperEnv, "1")
	result, err := testExecutor(2*time.Second, 1<<20).Run(context.Background(), helperPlan(t, "exit", "7"), &eventCollector{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusExited || result.ExitCode != 7 {
		t.Fatalf("result = %#v, want exited code 7", result)
	}
}

func TestRunCancellationAfterObservableOutput(t *testing.T) {
	t.Setenv(helperEnv, "1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	collector := &eventCollector{}
	sink := SinkFunc(func(event Event) error {
		if err := collector.Emit(event); err != nil {
			return err
		}
		if event.Type == EventStdout && bytes.Contains(event.Data, []byte("ready")) {
			cancel()
		}
		return nil
	})

	result, err := testExecutor(5*time.Second, 1<<20).Run(ctx, helperPlan(t, "wait"), sink)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusCancelled {
		t.Fatalf("status = %s, want cancelled", result.Status)
	}
	if !containsEvent(collector.Events(), EventCancelled) {
		t.Fatal("cancelled event missing")
	}
}

func TestRunTimeoutIsBounded(t *testing.T) {
	t.Setenv(helperEnv, "1")
	executor := New(Config{
		Timeout: 75 * time.Millisecond,
		WaitDelay: 100 * time.Millisecond,
		NewRunID: func() (string, error) { return "test-run", nil },
	})
	result, err := executor.Run(context.Background(), helperPlan(t, "wait"), &eventCollector{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusTimedOut {
		t.Fatalf("status = %s, want timed-out", result.Status)
	}
}

func TestRunFailsClosedWhenOutputLimitExceeded(t *testing.T) {
	t.Setenv(helperEnv, "1")
	executor := testExecutor(2*time.Second, 64)
	result, err := executor.Run(context.Background(), helperPlan(t, "flood"), &eventCollector{})
	if result.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", result.Status)
	}
	assertExecutorCode(t, err, ErrOutputLimit)
}

func TestRunCancelsWhenEventSinkFails(t *testing.T) {
	t.Setenv(helperEnv, "1")
	sink := SinkFunc(func(event Event) error {
		if event.Type == EventStdout {
			return errors.New("simulated downstream failure")
		}
		return nil
	})
	result, err := testExecutor(2*time.Second, 1<<20).Run(context.Background(), helperPlan(t, "echo", "value"), sink)
	if result.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", result.Status)
	}
	assertExecutorCode(t, err, ErrSink)
	if strings.Contains(err.Error(), "simulated downstream failure") {
		t.Fatalf("executor leaked sink detail: %v", err)
	}
}

func TestRunUsesNeutralWorkingDirectory(t *testing.T) {
	t.Setenv(helperEnv, "1")
	collector := &eventCollector{}
	result, err := testExecutor(2*time.Second, 1<<20).Run(context.Background(), helperPlan(t, "cwd"), collector)
	if err != nil || result.Status != StatusExited {
		t.Fatalf("result/error = %#v / %v", result, err)
	}
	got := strings.TrimSpace(string(joinEventData(collector.Events(), EventStdout)))
	current, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if samePath(got, current) {
		t.Fatalf("executor inherited caller working directory %q", got)
	}
	if !strings.Contains(filepath.Base(got), "cliharbor-run-") {
		t.Fatalf("working directory = %q, want neutral temporary directory", got)
	}
	if _, err := os.Stat(got); !os.IsNotExist(err) {
		t.Fatalf("neutral working directory still exists after run: %q (err=%v)", got, err)
	}
}

func TestRunRejectsPlansOutsideCurrentSafetyEnvelope(t *testing.T) {
	executable, name, identity := currentExecutable(t)
	base := planner.Plan{
		PackID: "demo", PackVersion: "1.0.0", CommandID: "inspect", ToolID: "fixture",
		ExecutablePath: executable, ExecutableName: name, ExecutableIdentity: identity, Risk: packs.RiskRead, Output: packs.Output{Mode: packs.OutputRaw},
	}
	for _, mutate := range []func(*planner.Plan){
		func(plan *planner.Plan) { plan.Risk = packs.RiskChange },
		func(plan *planner.Plan) { plan.Requirements.RequiresAuth = true },
		func(plan *planner.Plan) { plan.Output.Sensitivity.ContainsSecrets = true },
		func(plan *planner.Plan) { plan.Args = []string{"contains\x00nul"} },
		func(plan *planner.Plan) { plan.ExecutableName = "different-binary" },
	} {
		plan := base.Clone()
		mutate(&plan)
		_, err := testExecutor(time.Second, 1<<20).Run(context.Background(), plan, nil)
		assertExecutorCode(t, err, ErrInvalidPlan)
	}
}

func TestRunRejectsExecutableReplacementAfterDiscovery(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fixture")
	if err := os.WriteFile(path, []byte("first"), 0o755); err != nil {
		t.Fatal(err)
	}
	identity, err := discovery.CaptureExecutableIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	plan := planner.Plan{
		PackID: "demo", PackVersion: "1.0.0", CommandID: "inspect", ToolID: "fixture",
		ExecutablePath: path, ExecutableName: "fixture", ExecutableIdentity: identity,
		Risk: packs.RiskRead, Output: packs.Output{Mode: packs.OutputRaw},
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("other"), 0o755); err != nil {
		t.Fatal(err)
	}

	_, err = testExecutor(time.Second, 1<<20).Run(context.Background(), plan, nil)
	assertExecutorCode(t, err, ErrInvalidPlan)
}

func TestRunSupportsSpacesAndUnicodeInExecutablePathAndArgs(t *testing.T) {
	t.Setenv(helperEnv, "1")
	source, _, _ := currentExecutable(t)
	dir := filepath.Join(t.TempDir(), "space 雪")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(dir, filepath.Base(source))
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, data, 0o755); err != nil {
		t.Fatal(err)
	}
	identity, err := discovery.CaptureExecutableIdentity(destination)
	if err != nil {
		t.Fatal(err)
	}

	plan := helperPlan(t, "echo", "café 雪")
	plan.ExecutablePath = destination
	plan.ExecutableName = filepath.Base(destination)
	plan.ExecutableIdentity = identity
	collector := &eventCollector{}
	result, err := testExecutor(2*time.Second, 1<<20).Run(context.Background(), plan, collector)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusExited || result.ExitCode != 0 {
		t.Fatalf("result = %#v", result)
	}
	if got := string(joinEventData(collector.Events(), EventStdout)); got != "stdout:café 雪" {
		t.Fatalf("stdout = %q", got)
	}
}

func TestRunHonorsCancellationBeforeProcessStart(t *testing.T) {
	t.Setenv(helperEnv, "1")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	collector := &eventCollector{}

	result, err := testExecutor(time.Second, 1<<20).Run(ctx, helperPlan(t, "wait"), collector)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusCancelled {
		t.Fatalf("status = %s, want cancelled", result.Status)
	}
	if len(collector.Events()) != 0 {
		t.Fatalf("events = %#v, want none before process start", eventTypes(collector.Events()))
	}
}

func TestRunCleansUpAfterLifecycleSetupFailure(t *testing.T) {
	t.Setenv(helperEnv, "1")
	controller := &failingAfterStartController{}
	executor := testExecutor(2*time.Second, 1<<20)
	executor.newProcessController = func() (processController, error) {
		return controller, nil
	}

	result, err := executor.Run(context.Background(), helperPlan(t, "wait"), &eventCollector{})
	if result.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", result.Status)
	}
	assertExecutorCode(t, err, ErrStart)
	if !controller.cancelled || !controller.closed {
		t.Fatalf("controller cleanup = cancelled:%t closed:%t", controller.cancelled, controller.closed)
	}
}

func TestRunDoubleCancellationIsSafe(t *testing.T) {
	t.Setenv(helperEnv, "1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := SinkFunc(func(event Event) error {
		if event.Type == EventStdout && bytes.Contains(event.Data, []byte("ready")) {
			cancel()
			cancel()
		}
		return nil
	})

	result, err := testExecutor(5*time.Second, 1<<20).Run(ctx, helperPlan(t, "wait"), sink)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusCancelled {
		t.Fatalf("status = %s, want cancelled", result.Status)
	}
}

func TestEventDataIsolatedFromSinkMutation(t *testing.T) {
	t.Setenv(helperEnv, "1")
	var captured []byte
	sink := SinkFunc(func(event Event) error {
		if event.Type == EventStdout && len(event.Data) > 0 {
			captured = append([]byte(nil), event.Data...)
			event.Data[0] = 'X'
		}
		return nil
	})
	result, err := testExecutor(2*time.Second, 1<<20).Run(context.Background(), helperPlan(t, "echo", "immutable"), sink)
	if err != nil || result.Status != StatusExited {
		t.Fatalf("result/error = %#v / %v", result, err)
	}
	if string(captured) != "stdout:immutable" {
		t.Fatalf("captured = %q", captured)
	}
}

func TestExecutorHelperProcess(t *testing.T) {
	if os.Getenv(helperEnv) != "1" {
		return
	}
	separator := -1
	for index, arg := range os.Args {
		if arg == "--" {
			separator = index
			break
		}
	}
	if separator < 0 || separator+1 >= len(os.Args) {
		fmt.Fprint(os.Stderr, "missing helper mode")
		os.Exit(90)
	}
	args := os.Args[separator+1:]
	switch args[0] {
	case "echo":
		fmt.Fprint(os.Stdout, "stdout:"+strings.Join(args[1:], "|"))
		fmt.Fprint(os.Stderr, "stderr")
		os.Exit(0)
	case "exit":
		code, err := strconv.Atoi(args[1])
		if err != nil {
			os.Exit(91)
		}
		os.Exit(code)
	case "wait":
		fmt.Fprint(os.Stdout, "ready\n")
		time.Sleep(30 * time.Second)
		os.Exit(0)
	case "flood":
		fmt.Fprint(os.Stdout, strings.Repeat("x", 4096))
		os.Exit(0)
	case "cwd":
		cwd, err := os.Getwd()
		if err != nil {
			os.Exit(92)
		}
		fmt.Fprint(os.Stdout, cwd)
		os.Exit(0)
	case "spawn-child-exit":
		child := helperChildCommand("child-exit")
		if err := child.Start(); err != nil {
			os.Exit(94)
		}
		fmt.Fprintf(os.Stdout, "child-pid:%d\n", child.Process.Pid)
		if err := child.Wait(); err != nil {
			os.Exit(95)
		}
		os.Exit(0)
	case "spawn-child-wait":
		child := helperChildCommand("child-wait")
		if err := child.Start(); err != nil {
			os.Exit(96)
		}
		fmt.Fprintf(os.Stdout, "child-pid:%d\n", child.Process.Pid)
		time.Sleep(30 * time.Second)
		os.Exit(0)
	case "spawn-child-flood":
		child := helperChildCommand("child-wait")
		if err := child.Start(); err != nil {
			os.Exit(97)
		}
		fmt.Fprintf(os.Stderr, "child-pid:%d\n", child.Process.Pid)
		fmt.Fprint(os.Stdout, strings.Repeat("x", 4096))
		time.Sleep(30 * time.Second)
		os.Exit(0)
	case "spawn-orphan":
		child := helperChildCommand("child-wait")
		if err := child.Start(); err != nil {
			os.Exit(98)
		}
		fmt.Fprintf(os.Stdout, "child-pid:%d\n", child.Process.Pid)
		os.Exit(0)
	case "child-exit":
		os.Exit(0)
	case "child-wait":
		time.Sleep(30 * time.Second)
		os.Exit(0)
	default:
		os.Exit(93)
	}
}

func helperChildCommand(mode string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], "-test.run=^TestExecutorHelperProcess$", "--", mode)
	cmd.Env = os.Environ()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd
}

func helperPlan(t *testing.T, helperArgs ...string) planner.Plan {
	t.Helper()
	executable, name, identity := currentExecutable(t)
	args := []string{"-test.run=^TestExecutorHelperProcess$", "--"}
	args = append(args, helperArgs...)
	return planner.Plan{
		PackID: "demo", PackVersion: "1.0.0", CommandID: "inspect", ToolID: "fixture",
		ExecutablePath: executable, ExecutableName: name, ExecutableIdentity: identity, Args: args, Risk: packs.RiskRead,
		Output: packs.Output{Mode: packs.OutputRaw},
	}
}

func currentExecutable(t *testing.T) (string, string, discovery.ExecutableIdentity) {
	t.Helper()
	path, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	path, err = filepath.EvalSymlinks(path)
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

func testExecutor(timeout time.Duration, maxOutput int64) *Executor {
	return New(Config{
		Timeout: timeout,
		WaitDelay: 100 * time.Millisecond,
		ChunkBytes: 32,
		MaxOutputBytesPerStream: maxOutput,
		NewRunID: func() (string, error) { return "test-run", nil },
	})
}

type failingAfterStartController struct {
	cancelled bool
	closed    bool
}

func (c *failingAfterStartController) configure(*exec.Cmd) error {
	return nil
}

func (c *failingAfterStartController) afterStart(*exec.Cmd) error {
	return errors.New("simulated lifecycle setup failure")
}

func (c *failingAfterStartController) cancel(cmd *exec.Cmd) error {
	c.cancelled = true
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	err := cmd.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

func (c *failingAfterStartController) close() error {
	c.closed = true
	return nil
}

type eventCollector struct {
	mu     sync.Mutex
	events []Event
}

func (c *eventCollector) Emit(event Event) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if event.Data != nil {
		event.Data = append([]byte(nil), event.Data...)
	}
	c.events = append(c.events, event)
	return nil
}

func (c *eventCollector) Events() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Event, len(c.events))
	for index, event := range c.events {
		out[index] = event
		out[index].Data = append([]byte(nil), event.Data...)
	}
	return out
}

func joinEventData(events []Event, eventType EventType) []byte {
	var output []byte
	for _, event := range events {
		if event.Type == eventType {
			output = append(output, event.Data...)
		}
	}
	return output
}

func eventTypes(events []Event) []EventType {
	out := make([]EventType, 0, len(events))
	for _, event := range events {
		out = append(out, event.Type)
	}
	return out
}

func containsEvent(events []Event, eventType EventType) bool {
	for _, event := range events {
		if event.Type == eventType {
			return true
		}
	}
	return false
}

func assertExecutorCode(t *testing.T, err error, want ErrorCode) {
	t.Helper()
	executorErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("error = %T %v, want executor.Error code %s", err, err, want)
	}
	if executorErr.Code != want {
		t.Fatalf("code = %s, want %s (error %v)", executorErr.Code, want, err)
	}
}
