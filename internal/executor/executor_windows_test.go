//go:build windows

package executor

import (
	"errors"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const processSynchronize = 0x00100000

func TestRunWindowsJobAllowsNormalDescendantCompletion(t *testing.T) {
	t.Setenv(helperEnv, "1")
	result, err := testExecutor(2*time.Second, 1<<20).Run(
		t.Context(),
		helperPlan(t, "spawn-child-exit"),
		&eventCollector{},
	)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusExited || result.ExitCode != 0 {
		t.Fatalf("result = %#v, want exited code 0", result)
	}
}

func TestRunWindowsCancellationTerminatesDescendant(t *testing.T) {
	t.Setenv(helperEnv, "1")
	ctx, cancel := contextWithCancel(t)
	observer := &windowsDescendantObserver{cancel: cancel}

	result, err := testExecutor(5*time.Second, 1<<20).Run(ctx, helperPlan(t, "spawn-child-wait"), observer)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusCancelled {
		t.Fatalf("status = %s, want cancelled", result.Status)
	}
	observer.assertDescendantExited(t)
}

func TestRunWindowsTimeoutTerminatesDescendant(t *testing.T) {
	t.Setenv(helperEnv, "1")
	observer := &windowsDescendantObserver{}
	executor := New(Config{
		Timeout:   150 * time.Millisecond,
		WaitDelay: 100 * time.Millisecond,
		NewRunID:  func() (string, error) { return "test-run", nil },
	})

	result, err := executor.Run(t.Context(), helperPlan(t, "spawn-child-wait"), observer)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Status != StatusTimedOut {
		t.Fatalf("status = %s, want timed-out", result.Status)
	}
	observer.assertDescendantExited(t)
}

func TestRunWindowsOutputLimitTerminatesDescendant(t *testing.T) {
	t.Setenv(helperEnv, "1")
	observer := &windowsDescendantObserver{}

	result, err := testExecutor(5*time.Second, 64).Run(t.Context(), helperPlan(t, "spawn-child-flood"), observer)
	if result.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", result.Status)
	}
	assertExecutorCode(t, err, ErrOutputLimit)
	observer.assertDescendantExited(t)
}

func TestRunWindowsSinkFailureTerminatesDescendant(t *testing.T) {
	t.Setenv(helperEnv, "1")
	observer := &windowsDescendantObserver{failAfterChild: true}

	result, err := testExecutor(5*time.Second, 1<<20).Run(t.Context(), helperPlan(t, "spawn-child-wait"), observer)
	if result.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", result.Status)
	}
	assertExecutorCode(t, err, ErrSink)
	observer.assertDescendantExited(t)
}

func TestRunWindowsInheritedOutputHandlesCannotHangRun(t *testing.T) {
	t.Setenv(helperEnv, "1")
	observer := &windowsDescendantObserver{}

	result, err := testExecutor(5*time.Second, 1<<20).Run(t.Context(), helperPlan(t, "spawn-orphan"), observer)
	if result.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", result.Status)
	}
	assertExecutorCode(t, err, ErrWait)
	observer.assertDescendantExited(t)
}

type windowsDescendantObserver struct {
	pending        string
	handle         syscall.Handle
	observeErr     error
	cancel         func()
	failAfterChild bool
}

func (o *windowsDescendantObserver) Emit(event Event) error {
	if event.Type != EventStdout && event.Type != EventStderr {
		return nil
	}
	o.pending += string(event.Data)
	for {
		newline := strings.IndexByte(o.pending, '\n')
		if newline < 0 {
			return nil
		}
		line := o.pending[:newline]
		o.pending = o.pending[newline+1:]
		if !strings.HasPrefix(line, "child-pid:") || o.handle != 0 || o.observeErr != nil {
			continue
		}

		pid, err := strconv.ParseUint(strings.TrimPrefix(line, "child-pid:"), 10, 32)
		if err != nil {
			o.observeErr = err
			return nil
		}
		handle, err := syscall.OpenProcess(processSynchronize, false, uint32(pid))
		if err != nil {
			o.observeErr = err
			return nil
		}
		o.handle = handle

		if o.cancel != nil {
			cancel := o.cancel
			o.cancel = nil
			cancel()
		}
		if o.failAfterChild {
			return errors.New("simulated descendant sink failure")
		}
	}
}

func (o *windowsDescendantObserver) assertDescendantExited(t *testing.T) {
	t.Helper()
	if o.observeErr != nil {
		t.Fatalf("observe descendant: %v", o.observeErr)
	}
	if o.handle == 0 {
		t.Fatal("descendant process handle was not captured")
	}
	defer syscall.CloseHandle(o.handle)

	status, err := syscall.WaitForSingleObject(o.handle, 2_000)
	if err != nil {
		t.Fatalf("WaitForSingleObject(descendant) error = %v", err)
	}
	if status != syscall.WAIT_OBJECT_0 {
		t.Fatalf("descendant wait status = %d, want WAIT_OBJECT_0", status)
	}
}

func contextWithCancel(t *testing.T) (context.Context, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	return ctx, cancel
}
