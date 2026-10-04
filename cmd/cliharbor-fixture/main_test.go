package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/executor"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/structured"
)

func TestFixtureCLI(t *testing.T) {
	for _, tc := range []struct {
		args []string
		code int
	}{
		{[]string{"--version"}, 0},
		{[]string{"--help"}, 0},
		{[]string{"inspect", "--safe-mode"}, 0},
		{[]string{"inspect", "--detailed-mode", "--limit", "5", "--verbose"}, 0},
		{[]string{"inspect"}, 2},
		{[]string{"inspect", "--safe-mode", "--detailed-mode"}, 2},
		{[]string{"inspect", "--safe-mode", "--limit", "0"}, 2},
		{[]string{"inspect", "--safe-mode", "--limit", "1001"}, 2},
		{[]string{"inspect", "--safe-mode", "--unknown"}, 2},
		{[]string{"inspect", "--safe-mode", "extra"}, 2},
		{[]string{"wait", "--seconds", "0"}, 2},
		{[]string{"wait", "--seconds", "61"}, 2},
		{[]string{"wait", "--seconds", "bad"}, 2},
		{[]string{"fail"}, 42},
		{[]string{"fail", "extra"}, 2},
		{[]string{"unknown"}, 2},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if code := run(tc.args, &stdout, &stderr); code != tc.code {
				t.Fatalf("exit = %d, want %d; stderr = %s", code, tc.code, &stderr)
			}
			if tc.args[0] == "inspect" && tc.code == 0 {
				var data map[string]any
				if err := json.Unmarshal(stdout.Bytes(), &data); err != nil || data["platform"] != runtime.GOOS || data["ok"] != true {
					t.Fatalf("invalid inspection output: %s (%v)", &stdout, err)
				}
			}
		})
	}
}

// Build and run the actual testing CLI through the production pack/discovery/
// planner/executor/result path, including a binary path with spaces and Unicode.
func TestExamplePackExecutesLocalCLI(t *testing.T) {
	name := "cliharbor-fixture"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	artifact := filepath.Join(t.TempDir(), "testing CLI 雪", name)
	build := exec.CommandContext(t.Context(), "go", "build", "-o", artifact, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build testing CLI: %v\n%s", err, output)
	}
	registry, err := packs.NewLoader().LoadFiles([]string{filepath.Join("..", "..", "packs", "example", "pack.yaml")})
	if err != nil {
		t.Fatal(err)
	}
	ref := discovery.ToolRef{PackID: "example", ToolID: "fixture"}
	snapshot, err := discovery.NewResolver(discovery.Config{}).Discover(t.Context(), registry, map[discovery.ToolRef]string{ref: artifact})
	if err != nil {
		t.Fatal(err)
	}
	tool, ok := snapshot.Find(ref)
	if !ok || !tool.Healthy() || tool.Version != "1.0.0" {
		t.Fatalf("testing CLI did not qualify: %#v", tool)
	}
	manager, err := runs.NewManager(t.Context(), registry, snapshot, runs.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Shutdown(context.Background())
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	started, err := manager.Start(runs.Request{PackID: "example", CommandID: "inspect", Values: map[string]json.RawMessage{
		"mode": json.RawMessage(`"detailed"`), "limit": json.RawMessage(`5`), "verbose": json.RawMessage(`true`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := manager.Wait(ctx, started.RunID)
	if err != nil || result.Status != runs.StatusExited || result.ExitCode == nil || *result.ExitCode != 0 || result.Structured == nil || result.Structured.Status != structured.StatusAvailable {
		t.Fatalf("inspection result = %#v, error = %v", result, err)
	}
	var stderr string
	for _, event := range result.Events {
		if event.Type == string(executor.EventStderr) {
			stderr += eventText(t, event)
		}
	}
	if !strings.Contains(stderr, "Synthetic inspection complete") {
		t.Fatal("separate stderr evidence missing")
	}
	failed, err := manager.Start(runs.Request{PackID: "example", CommandID: "fail"})
	if err != nil {
		t.Fatal(err)
	}
	failure, err := manager.Wait(ctx, failed.RunID)
	if err != nil || failure.Status != runs.StatusExited || failure.ExitCode == nil || *failure.ExitCode != 42 {
		t.Fatalf("failure result = %#v, error = %v", failure, err)
	}
	waiting, err := manager.Start(runs.Request{PackID: "example", CommandID: "wait"})
	if err != nil {
		t.Fatal(err)
	}
	cursor := uint64(0)
	for {
		batch, err := manager.WaitEvents(ctx, waiting.RunID, cursor)
		if err != nil {
			t.Fatal(err)
		}
		ready := false
		for _, event := range batch.Events {
			cursor = event.Sequence
			ready = ready || (event.Type == string(executor.EventStdout) && strings.Contains(eventText(t, event), "ready:"))
		}
		if ready {
			break
		}
	}
	if err := manager.Cancel(waiting.RunID); err != nil {
		t.Fatal(err)
	}
	cancelled, err := manager.Wait(ctx, waiting.RunID)
	if err != nil || cancelled.Status != runs.StatusCancelled {
		t.Fatalf("cancel result = %#v, error = %v", cancelled, err)
	}
}

func eventText(t *testing.T, event runs.Event) string {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(event.DataBase64)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
