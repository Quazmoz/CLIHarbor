//go:build darwin || linux

package processcontrol

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func TestProcessGroupCleansUpDescendants(t *testing.T) {
	for _, mode := range []string{"cancel", "timeout", "normal", "late-cancel", "cancel-before-attach"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			pidPath, heartbeat := filepath.Join(dir, "pid"), filepath.Join(dir, "heartbeat")
			controller, err := New()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = controller.Close() })
			ctx, cancel := context.WithCancel(t.Context())
			if mode == "timeout" {
				cancel()
				ctx, cancel = context.WithTimeout(t.Context(), time.Second)
			}
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProcessGroupHelper$", "--", "group-parent", mode, pidPath, heartbeat)
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			cmd.WaitDelay = 100 * time.Millisecond
			cmd.Cancel = func() error { return controller.Cancel(cmd) }
			if err := controller.Configure(cmd); err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill() })
			if mode != "cancel-before-attach" {
				if err := controller.AfterStart(cmd); err != nil {
					t.Fatal(err)
				}
			}
			waitForGroupFile(t, heartbeat)
			pidBytes, err := os.ReadFile(pidPath)
			if err != nil {
				t.Fatal(err)
			}
			pid, err := strconv.Atoi(string(pidBytes))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
			switch mode {
			case "cancel", "cancel-before-attach":
				cancel()
			}
			waitErr := cmd.Wait()
			normalExit := mode == "normal" || mode == "late-cancel"
			if normalExit && waitErr != nil && !errors.Is(waitErr, exec.ErrWaitDelay) {
				t.Fatal(waitErr)
			}
			if !normalExit && waitErr == nil {
				t.Fatal("cancelled process exited successfully")
			}
			if mode == "late-cancel" && !errors.Is(controller.Cancel(cmd), os.ErrProcessDone) {
				t.Fatal("late cancellation must preserve the completed root exit")
			}
			if mode == "cancel-before-attach" {
				if err := controller.AfterStart(cmd); err != nil {
					t.Fatal(err)
				}
			}
			if err := controller.Close(); err != nil {
				t.Fatal(err)
			}
			if err := controller.Close(); err != nil {
				t.Fatal("Close must be idempotent", err)
			}
			// A zombie can still have a PID on Linux. A stopped heartbeat verifies
			// that the child is no longer executing without relying on init reaping.
			time.Sleep(50 * time.Millisecond)
			before, err := os.ReadFile(heartbeat)
			if err != nil {
				t.Fatal(err)
			}
			time.Sleep(100 * time.Millisecond)
			after, err := os.ReadFile(heartbeat)
			if err != nil || string(before) != string(after) {
				t.Fatalf("descendant remained active after %s: %v", mode, err)
			}
		})
	}
}

func waitForGroupFile(t *testing.T, name string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(name); err == nil && len(data) > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("helper process did not become ready")
}

func TestProcessGroupHelper(t *testing.T) {
	for i, arg := range os.Args {
		if arg == "group-child" && i+1 < len(os.Args) {
			for {
				if err := os.WriteFile(os.Args[i+1], []byte(time.Now().String()), 0o600); err != nil {
					os.Exit(3)
				}
				time.Sleep(5 * time.Millisecond)
			}
		}
		if arg != "group-parent" || i+3 >= len(os.Args) {
			continue
		}
		mode, pidPath, heartbeat := os.Args[i+1], os.Args[i+2], os.Args[i+3]
		child := exec.Command(os.Args[0], "-test.run=^TestProcessGroupHelper$", "--", "group-child", heartbeat)
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(4)
		}
		if err := os.WriteFile(pidPath, []byte(strconv.Itoa(child.Process.Pid)), 0o600); err != nil {
			_ = child.Process.Kill()
			os.Exit(5)
		}
		if mode == "normal" || mode == "late-cancel" {
			waitForGroupFile(t, heartbeat)
			os.Exit(0)
		}
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
}

func TestProcessGroupRejectsMissingProcess(t *testing.T) {
	controller, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer controller.Close()
	if controller.Configure(nil) == nil || controller.AfterStart(nil) == nil {
		t.Fatal("missing commands must fail closed")
	}
	if err := controller.Cancel(nil); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("Cancel(nil) = %v", err)
	}
}
