package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/executor"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

const executionFixtureEnv = "CLIHARBOR_PHASE4B_FIXTURE"

func TestExecutionIntegrationExactArgvAndStreams(t *testing.T) {
	state := prepareExecutionFixtureRuntime(t)
	query := "space café 雪 & pipe | semicolon ;"

	plan, err := planner.Build(state.Registry, state.Discovery, planner.Request{
		PackID:    "integration",
		CommandID: "inspect",
		Values: map[string]json.RawMessage{
			"query":   integrationRawJSON(t, query),
			"limit":   integrationRawJSON(t, int64(0)),
			"verbose": integrationRawJSON(t, true),
			"mode":    integrationRawJSON(t, "detailed"),
		},
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}

	wantArgs := []string{
		"-test.run=^TestExecutionFixtureProcess$",
		"--",
		"inspect",
		"--query", query,
		"--limit", "0",
		"--verbose",
		"--detailed-mode",
	}
	if strings.Join(plan.Args, "\x00") != strings.Join(wantArgs, "\x00") {
		t.Fatalf("plan args = %#v, want %#v", plan.Args, wantArgs)
	}
	if plan.ToolVersion != "1.2.3" {
		t.Fatalf("tool version = %q, want 1.2.3", plan.ToolVersion)
	}

	directStdout, directStderr, directExit := runExecutionFixtureDirect(t, plan.ExecutablePath, plan.Args)
	if directExit != 0 {
		t.Fatalf("direct fixture exit = %d, want 0", directExit)
	}

	collector := &integrationEventCollector{}
	result, err := integrationExecutor(10*time.Second).Run(t.Context(), plan, collector)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != executor.StatusExited || result.ExitCode != directExit || result.RunID != "integration-run" {
		t.Fatalf("result = %#v, direct exit = %d", result, directExit)
	}
	if got := collector.data(executor.EventStdout); !bytes.Equal(got, directStdout) {
		t.Fatalf("stdout = %q, direct = %q", got, directStdout)
	}
	if got := collector.data(executor.EventStderr); !bytes.Equal(got, directStderr) {
		t.Fatalf("stderr = %q, direct = %q", got, directStderr)
	}
	if types := collector.types(); len(types) < 4 || types[0] != executor.EventStarted || types[len(types)-1] != executor.EventExited {
		t.Fatalf("event sequence = %#v", types)
	}
}

func TestExecutionIntegrationSecondPackToolIsIsolated(t *testing.T) {
	fixture := executionFixtureConfigForTest(t)
	alternatePackPath, alternateRef := alternateExecutionFixturePackForTest(t, fixture.executable)
	fixture.options.PackFiles = append(fixture.options.PackFiles, alternatePackPath)
	fixture.options.ToolOverrides[alternateRef] = fixture.executable

	state, err := prepareRuntime(t.Context(), fixture.options)
	if err != nil {
		t.Fatalf("prepareRuntime() error = %v", err)
	}

	primary, ok := state.Discovery.Find(fixture.ref)
	if !ok || primary.Status != discovery.StatusReady || primary.Version != "1.2.3" {
		t.Fatalf("primary discovery state = %#v", primary)
	}
	alternate, ok := state.Discovery.Find(alternateRef)
	if !ok || alternate.Status != discovery.StatusReady || alternate.Version != "3.4.5" || !alternate.ExecutableIdentity.Valid() {
		t.Fatalf("alternate discovery state = %#v", alternate)
	}

	plan, err := planner.Build(state.Registry, state.Discovery, planner.Request{
		PackID:    "integration-alt",
		CommandID: "summarize",
		Values: map[string]json.RawMessage{
			"topic":  integrationRawJSON(t, "delta café 雪"),
			"format": integrationRawJSON(t, "brief"),
		},
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	wantArgs := []string{
		"-test.run=^TestExecutionFixtureProcess$",
		"--",
		"summarize",
		"--topic", "delta café 雪",
		"--brief",
	}
	if strings.Join(plan.Args, "\x00") != strings.Join(wantArgs, "\x00") {
		t.Fatalf("alternate plan args = %#v, want %#v", plan.Args, wantArgs)
	}
	if plan.ToolID != "alternate" || plan.ToolVersion != "3.4.5" {
		t.Fatalf("alternate plan authority = tool %q version %q", plan.ToolID, plan.ToolVersion)
	}

	directStdout, directStderr, directExit := runExecutionFixtureDirect(t, plan.ExecutablePath, plan.Args)
	collector := &integrationEventCollector{}
	result, err := integrationExecutor(10*time.Second).Run(t.Context(), plan, collector)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != executor.StatusExited || result.ExitCode != directExit || directExit != 0 {
		t.Fatalf("alternate result = %#v, direct exit = %d", result, directExit)
	}
	if got := collector.data(executor.EventStdout); !bytes.Equal(got, directStdout) {
		t.Fatalf("alternate stdout = %q, direct = %q", got, directStdout)
	}
	if got := collector.data(executor.EventStderr); !bytes.Equal(got, directStderr) {
		t.Fatalf("alternate stderr = %q, direct = %q", got, directStderr)
	}

	if _, err := planner.Build(state.Registry, state.Discovery, planner.Request{
		PackID:    "integration",
		CommandID: "summarize",
		Values: map[string]json.RawMessage{
			"topic":  integrationRawJSON(t, "delta"),
			"format": integrationRawJSON(t, "brief"),
		},
	}); err == nil {
		t.Fatal("primary pack unexpectedly gained alternate-pack command authority")
	}
}

func TestExecutionIntegrationPreservesNonZeroExit(t *testing.T) {
	state := prepareExecutionFixtureRuntime(t)
	plan, err := planner.Build(state.Registry, state.Discovery, planner.Request{
		PackID:    "integration",
		CommandID: "fail",
		Values: map[string]json.RawMessage{
			"code": integrationRawJSON(t, int64(7)),
		},
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}

	_, _, directExit := runExecutionFixtureDirect(t, plan.ExecutablePath, plan.Args)
	if directExit != 7 {
		t.Fatalf("direct fixture exit = %d, want 7", directExit)
	}

	result, err := integrationExecutor(10*time.Second).Run(t.Context(), plan, &integrationEventCollector{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != executor.StatusExited || result.ExitCode != directExit {
		t.Fatalf("result = %#v, direct exit = %d", result, directExit)
	}
}

func TestExecutionIntegrationCancellationAfterOutput(t *testing.T) {
	state := prepareExecutionFixtureRuntime(t)
	plan, err := planner.Build(state.Registry, state.Discovery, planner.Request{
		PackID:    "integration",
		CommandID: "wait",
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	collector := &integrationEventCollector{cancelOnReady: cancel}

	result, err := integrationExecutor(10*time.Second).Run(ctx, plan, collector)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != executor.StatusCancelled {
		t.Fatalf("status = %s, want cancelled", result.Status)
	}
	if !bytes.Contains(collector.data(executor.EventStdout), []byte("ready")) {
		t.Fatalf("stdout = %q, want observable ready output", collector.data(executor.EventStdout))
	}
	if !collector.contains(executor.EventCancelled) {
		t.Fatalf("event sequence = %#v, want cancellation event", collector.types())
	}
}

func TestExecutionFixtureProcess(t *testing.T) {
	if os.Getenv(executionFixtureEnv) != "1" {
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
		fmt.Fprint(os.Stderr, "fixture command missing")
		os.Exit(90)
	}

	args := os.Args[separator+1:]
	switch args[0] {
	case "version":
		fmt.Fprintln(os.Stdout, "fixture 1.2.3")
		os.Exit(0)
	case "version-alt":
		fmt.Fprintln(os.Stdout, "alternate 3.4.5")
		os.Exit(0)
	case "inspect":
		fmt.Fprint(os.Stdout, "inspect:"+strings.Join(args[1:], "\x1f"))
		fmt.Fprint(os.Stderr, "fixture-stderr")
		os.Exit(0)
	case "summarize":
		fmt.Fprint(os.Stdout, "summarize:"+strings.Join(args[1:], "\x1f"))
		fmt.Fprint(os.Stderr, "alternate-stderr")
		os.Exit(0)
	case "exit":
		if len(args) != 3 || args[1] != "--code" {
			os.Exit(91)
		}
		code, err := strconv.Atoi(args[2])
		if err != nil {
			os.Exit(92)
		}
		os.Exit(code)
	case "wait":
		fmt.Fprintln(os.Stdout, "ready")
		time.Sleep(30 * time.Second)
		os.Exit(0)
	default:
		os.Exit(93)
	}
}

type executionFixtureConfig struct {
	options    Options
	executable string
	ref        discovery.ToolRef
}

func prepareExecutionFixtureRuntime(t *testing.T) RuntimeState {
	t.Helper()
	fixture := executionFixtureConfigForTest(t)
	state, err := prepareRuntime(t.Context(), fixture.options)
	if err != nil {
		t.Fatalf("prepareRuntime() error = %v", err)
	}

	loaded, ok := state.Registry.FindPack("integration")
	if !ok || loaded.Source.Kind != packs.SourceExplicitLocal {
		t.Fatalf("fixture pack source = %#v, want explicit-local", loaded.Source)
	}

	tool, ok := state.Discovery.Find(fixture.ref)
	if !ok {
		t.Fatal("fixture discovery state missing")
	}
	if tool.Status != discovery.StatusReady || tool.Path == "" || tool.Version != "1.2.3" || !tool.ExecutableIdentity.Valid() {
		t.Fatalf("fixture discovery state = %#v", tool)
	}
	if runtime.GOOS == "windows" {
		if !strings.EqualFold(tool.Path, fixture.executable) {
			t.Fatalf("fixture path = %q, override = %q", tool.Path, fixture.executable)
		}
	} else if tool.Path != fixture.executable {
		t.Fatalf("fixture path = %q, override = %q", tool.Path, fixture.executable)
	}
	return state
}

func executionFixtureConfigForTest(t *testing.T) executionFixtureConfig {
	t.Helper()
	t.Setenv(executionFixtureEnv, "1")

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		t.Fatal(err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		t.Fatal(err)
	}
	executable = filepath.Clean(executable)
	executableName := filepath.Base(executable)

	pack := fmt.Sprintf(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: integration
  name: Phase 4B Integration Fixture
  version: 1.0.0
runtime:
  platforms: [%s]
  tools:
    fixture:
      executableNames: [%s]
      versionProbe:
        args:
          - "-test.run=^TestExecutionFixtureProcess$"
          - "--"
          - "version"
        parser: semver-text
        timeoutMillis: 5000
      versionConstraint: ">=1.0.0 <2.0.0"
commands:
  inspect:
    name: Inspect fixture argv
    tool: fixture
    risk: read
    inputs:
      - id: query
        type: string
        label: Query
        required: true
        validation:
          maxLength: 256
          disallowLeadingDash: true
      - id: limit
        type: integer
        label: Limit
        validation:
          min: 0
          max: 100
      - id: verbose
        type: boolean
        label: Verbose
      - id: mode
        type: enum
        label: Mode
        required: true
        validation:
          enum: [safe, detailed]
          disallowLeadingDash: true
    argv:
      - literal: "-test.run=^TestExecutionFixtureProcess$"
      - literal: "--"
      - literal: "inspect"
      - flag:
          name: --query
          valueFrom: query
      - flag:
          name: --limit
          valueFrom: limit
          omitWhenEmpty: true
      - switch:
          name: --verbose
          enabledFrom: verbose
      - map:
          valueFrom: mode
          values:
            safe: --safe-mode
            detailed: --detailed-mode
    output:
      mode: raw
  fail:
    name: Return fixture exit code
    tool: fixture
    risk: read
    inputs:
      - id: code
        type: integer
        label: Exit code
        required: true
        validation:
          min: 1
          max: 20
    argv:
      - literal: "-test.run=^TestExecutionFixtureProcess$"
      - literal: "--"
      - literal: "exit"
      - flag:
          name: --code
          valueFrom: code
    output:
      mode: raw
  wait:
    name: Wait for cancellation
    tool: fixture
    risk: read
    argv:
      - literal: "-test.run=^TestExecutionFixtureProcess$"
      - literal: "--"
      - literal: "wait"
    output:
      mode: raw
`, runtime.GOOS, executableName)

	packPath := filepath.Join(t.TempDir(), "integration.yaml")
	if err := os.WriteFile(packPath, []byte(pack), 0o600); err != nil {
		t.Fatal(err)
	}

	ref := discovery.ToolRef{PackID: "integration", ToolID: "fixture"}
	return executionFixtureConfig{
		options: Options{
			PackFiles:     []string{packPath},
			ToolOverrides: map[discovery.ToolRef]string{ref: executable},
		},
		executable: executable,
		ref:        ref,
	}
}

func alternateExecutionFixturePackForTest(t *testing.T, executable string) (string, discovery.ToolRef) {
	t.Helper()
	executableName := filepath.Base(executable)
	pack := fmt.Sprintf(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: integration-alt
  name: Phase 4B Alternate Integration Fixture
  version: 2.0.0
runtime:
  platforms: [%s]
  tools:
    alternate:
      executableNames: [%s]
      versionProbe:
        args:
          - "-test.run=^TestExecutionFixtureProcess$"
          - "--"
          - "version-alt"
        parser: semver-text
        timeoutMillis: 5000
      versionConstraint: ">=3.0.0 <4.0.0"
commands:
  summarize:
    name: Summarize alternate fixture
    tool: alternate
    risk: read
    inputs:
      - id: topic
        type: string
        label: Topic
        required: true
        validation:
          maxLength: 128
          disallowLeadingDash: true
      - id: format
        type: enum
        label: Format
        required: true
        validation:
          enum: [brief, full]
          disallowLeadingDash: true
    argv:
      - literal: "-test.run=^TestExecutionFixtureProcess$"
      - literal: "--"
      - literal: "summarize"
      - flag:
          name: --topic
          valueFrom: topic
      - map:
          valueFrom: format
          values:
            brief: --brief
            full: --full
    output:
      mode: raw
`, runtime.GOOS, executableName)

	packPath := filepath.Join(t.TempDir(), "integration-alt.yaml")
	if err := os.WriteFile(packPath, []byte(pack), 0o600); err != nil {
		t.Fatal(err)
	}
	return packPath, discovery.ToolRef{PackID: "integration-alt", ToolID: "alternate"}
}

func runExecutionFixtureDirect(t *testing.T, executable string, args []string) ([]byte, []byte, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Env = os.Environ()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		return stdout.Bytes(), stderr.Bytes(), 0
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("direct fixture execution error = %v", err)
	}
	return stdout.Bytes(), stderr.Bytes(), exitErr.ExitCode()
}

func integrationRawJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func integrationExecutor(timeout time.Duration) *executor.Executor {
	return executor.New(executor.Config{
		Timeout:                 timeout,
		WaitDelay:               100 * time.Millisecond,
		ChunkBytes:              32,
		MaxOutputBytesPerStream: 1 << 20,
		NewRunID:                func() (string, error) { return "integration-run", nil },
	})
}

type integrationEventCollector struct {
	mu            sync.Mutex
	events        []executor.Event
	stdout        []byte
	cancelOnReady context.CancelFunc
	cancelled     bool
}

func (c *integrationEventCollector) Emit(event executor.Event) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	event.Data = append([]byte(nil), event.Data...)
	c.events = append(c.events, event)
	if event.Type == executor.EventStdout {
		c.stdout = append(c.stdout, event.Data...)
		if c.cancelOnReady != nil && !c.cancelled && bytes.Contains(c.stdout, []byte("ready")) {
			c.cancelled = true
			c.cancelOnReady()
		}
	}
	return nil
}

func (c *integrationEventCollector) data(eventType executor.EventType) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []byte
	for _, event := range c.events {
		if event.Type == eventType {
			out = append(out, event.Data...)
		}
	}
	return out
}

func (c *integrationEventCollector) types() []executor.EventType {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]executor.EventType, 0, len(c.events))
	for _, event := range c.events {
		out = append(out, event.Type)
	}
	return out
}

func (c *integrationEventCollector) contains(eventType executor.EventType) bool {
	for _, current := range c.types() {
		if current == eventType {
			return true
		}
	}
	return false
}
