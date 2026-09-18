package executor

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

const (
	defaultTimeout    = 30 * time.Second
	defaultWaitDelay  = 2 * time.Second
	defaultChunkBytes = 16 << 10
	defaultMaxOutput  = 2 << 20
)

type Status string

const (
	StatusExited    Status = "exited"
	StatusCancelled Status = "cancelled"
	StatusTimedOut  Status = "timed-out"
	StatusFailed    Status = "failed"
)

type EventType string

const (
	EventStarted   EventType = "run.started"
	EventStdout    EventType = "stdout.chunk"
	EventStderr    EventType = "stderr.chunk"
	EventExited    EventType = "run.exited"
	EventCancelled EventType = "run.cancelled"
	EventTimedOut  EventType = "run.timed-out"
	EventFailed    EventType = "run.failed"
)

type Event struct {
	RunID     string
	Type      EventType
	Timestamp time.Time
	Data      []byte
	ExitCode  *int
}

type Sink interface {
	Emit(Event) error
}

type SinkFunc func(Event) error

func (f SinkFunc) Emit(event Event) error { return f(event) }

type Config struct {
	Timeout                 time.Duration
	WaitDelay               time.Duration
	ChunkBytes              int
	MaxOutputBytesPerStream int64
	Now                     func() time.Time
	NewRunID                func() (string, error)
}

type Executor struct {
	timeout                 time.Duration
	waitDelay               time.Duration
	chunkBytes              int
	maxOutputBytesPerStream int64
	now                     func() time.Time
	newRunID                func() (string, error)
	newProcessController    processControllerFactory
}

type Result struct {
	RunID     string
	Status    Status
	StartedAt time.Time
	EndedAt   time.Time
	ExitCode  int
}

type ErrorCode string

const (
	ErrInvalidPlan ErrorCode = "invalid_plan"
	ErrStart       ErrorCode = "start_failed"
	ErrOutputLimit ErrorCode = "output_limit"
	ErrSink        ErrorCode = "sink_failed"
	ErrWait        ErrorCode = "wait_failed"
)

type Error struct {
	Code    ErrorCode
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

func New(config Config) *Executor {
	if config.Timeout <= 0 {
		config.Timeout = defaultTimeout
	}
	if config.WaitDelay <= 0 {
		config.WaitDelay = defaultWaitDelay
	}
	if config.ChunkBytes <= 0 || config.ChunkBytes > defaultMaxOutput {
		config.ChunkBytes = defaultChunkBytes
	}
	if config.MaxOutputBytesPerStream <= 0 {
		config.MaxOutputBytesPerStream = defaultMaxOutput
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.NewRunID == nil {
		config.NewRunID = randomRunID
	}
	return &Executor{
		timeout:                 config.Timeout,
		waitDelay:               config.WaitDelay,
		chunkBytes:              config.ChunkBytes,
		maxOutputBytesPerStream: config.MaxOutputBytesPerStream,
		now:                     config.Now,
		newRunID:                config.NewRunID,
		newProcessController:    newProcessController,
	}
}

func (e *Executor) Run(ctx context.Context, plan planner.Plan, sink Sink) (Result, error) {
	if e == nil {
		e = New(Config{})
	}
	if sink == nil {
		sink = SinkFunc(func(Event) error { return nil })
	}
	if err := validatePlan(plan); err != nil {
		return Result{}, err
	}
	if err := revalidateExecutable(plan); err != nil {
		return Result{}, err
	}

	runID, err := e.newRunID()
	if err != nil || runID == "" {
		return Result{}, &Error{Code: ErrInvalidPlan, Message: "generate run identifier"}
	}
	if err := ctx.Err(); err != nil {
		now := e.now().UTC()
		return Result{
			RunID:     runID,
			Status:    statusForContextError(err),
			StartedAt: now,
			EndedAt:   now,
			ExitCode:  -1,
		}, nil
	}

	runCtx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()

	workdir, err := os.MkdirTemp("", "cliharbor-run-")
	if err != nil {
		return Result{}, &Error{Code: ErrStart, Message: "create neutral working directory"}
	}
	defer func() { _ = os.RemoveAll(workdir) }()

	controllerFactory := e.newProcessController
	if controllerFactory == nil {
		controllerFactory = newProcessController
	}
	controller, err := controllerFactory()
	if err != nil {
		return Result{RunID: runID, Status: StatusFailed, ExitCode: -1}, &Error{Code: ErrStart, Message: "create process lifecycle boundary"}
	}
	defer func() { _ = controller.close() }()

	startedGate := make(chan struct{})
	cmd := exec.CommandContext(runCtx, plan.ExecutablePath, plan.Args...)
	cmd.Dir = workdir
	cmd.WaitDelay = e.waitDelay

	var cancellationApplied atomic.Bool
	cmd.Cancel = func() error {
		err := controller.cancel(cmd)
		if err == nil {
			cancellationApplied.Store(true)
		}
		return err
	}
	cancelExecution := func() {
		cancel()
		if err := controller.cancel(cmd); err == nil {
			cancellationApplied.Store(true)
		}
	}
	state := &streamState{sink: sink, cancel: cancelExecution, now: e.now, runID: runID}
	cmd.Stdout = &eventWriter{state: state, eventType: EventStdout, started: startedGate, chunkBytes: e.chunkBytes, maxBytes: e.maxOutputBytesPerStream}
	cmd.Stderr = &eventWriter{state: state, eventType: EventStderr, started: startedGate, chunkBytes: e.chunkBytes, maxBytes: e.maxOutputBytesPerStream}

	if err := controller.configure(cmd); err != nil {
		now := e.now().UTC()
		return Result{RunID: runID, Status: StatusFailed, StartedAt: now, EndedAt: now, ExitCode: -1}, &Error{Code: ErrStart, Message: "configure process lifecycle boundary"}
	}
	if err := cmd.Start(); err != nil {
		now := e.now().UTC()
		if ctxErr := runCtx.Err(); ctxErr != nil {
			return Result{RunID: runID, Status: statusForContextError(ctxErr), StartedAt: now, EndedAt: now, ExitCode: -1}, nil
		}
		return Result{RunID: runID, Status: StatusFailed, StartedAt: now, EndedAt: now, ExitCode: -1}, &Error{Code: ErrStart, Message: "start planned executable"}
	}
	if err := controller.afterStart(cmd); err != nil {
		close(startedGate)
		_ = controller.cancel(cmd)
		_ = cmd.Wait()
		now := e.now().UTC()
		if ctxErr := runCtx.Err(); ctxErr != nil {
			return Result{RunID: runID, Status: statusForContextError(ctxErr), StartedAt: now, EndedAt: now, ExitCode: -1}, nil
		}
		return Result{RunID: runID, Status: StatusFailed, StartedAt: now, EndedAt: now, ExitCode: -1}, &Error{Code: ErrStart, Message: "attach planned executable to lifecycle boundary"}
	}

	started := e.now().UTC()
	if err := state.emit(Event{RunID: runID, Type: EventStarted, Timestamp: started}); err != nil {
		close(startedGate)
		_ = controller.cancel(cmd)
		_ = cmd.Wait()
		return Result{RunID: runID, Status: StatusFailed, StartedAt: started, EndedAt: e.now().UTC(), ExitCode: -1}, err
	}
	close(startedGate)

	waitErr := cmd.Wait()
	closeErr := controller.close()
	ended := e.now().UTC()

	if streamErr := state.err(); streamErr != nil {
		return Result{RunID: runID, Status: StatusFailed, StartedAt: started, EndedAt: ended, ExitCode: -1}, streamErr
	}
	if closeErr != nil {
		return Result{RunID: runID, Status: StatusFailed, StartedAt: started, EndedAt: ended, ExitCode: -1}, &Error{Code: ErrWait, Message: "close process lifecycle boundary"}
	}
	if cancellationApplied.Load() {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			_ = state.emit(Event{RunID: runID, Type: EventTimedOut, Timestamp: ended})
			return Result{RunID: runID, Status: StatusTimedOut, StartedAt: started, EndedAt: ended, ExitCode: -1}, nil
		}
		if errors.Is(runCtx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			_ = state.emit(Event{RunID: runID, Type: EventCancelled, Timestamp: ended})
			return Result{RunID: runID, Status: StatusCancelled, StartedAt: started, EndedAt: ended, ExitCode: -1}, nil
		}
	}

	exitCode := 0
	if waitErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(waitErr, &exitErr) {
			_ = state.emit(Event{RunID: runID, Type: EventFailed, Timestamp: ended})
			return Result{RunID: runID, Status: StatusFailed, StartedAt: started, EndedAt: ended, ExitCode: -1}, &Error{Code: ErrWait, Message: "wait for planned executable"}
		}
		exitCode = exitErr.ExitCode()
	}
	code := exitCode
	if err := state.emit(Event{RunID: runID, Type: EventExited, Timestamp: ended, ExitCode: &code}); err != nil {
		return Result{RunID: runID, Status: StatusFailed, StartedAt: started, EndedAt: ended, ExitCode: exitCode}, err
	}
	return Result{RunID: runID, Status: StatusExited, StartedAt: started, EndedAt: ended, ExitCode: exitCode}, nil
}

func statusForContextError(err error) Status {
	if errors.Is(err, context.DeadlineExceeded) {
		return StatusTimedOut
	}
	return StatusCancelled
}

type eventWriter struct {
	mu         sync.Mutex
	state      *streamState
	eventType  EventType
	started    <-chan struct{}
	chunkBytes int
	maxBytes   int64
	total      int64
}

func (w *eventWriter) Write(p []byte) (int, error) {
	<-w.started
	w.mu.Lock()
	defer w.mu.Unlock()

	original := len(p)
	if w.total+int64(len(p)) > w.maxBytes {
		err := &Error{Code: ErrOutputLimit, Message: "process output exceeded the configured per-stream limit"}
		w.state.fail(err)
		return 0, err
	}
	w.total += int64(len(p))
	for len(p) > 0 {
		n := w.chunkBytes
		if len(p) < n {
			n = len(p)
		}
		chunk := append([]byte(nil), p[:n]...)
		if err := w.state.emit(Event{RunID: w.state.runID, Type: w.eventType, Timestamp: w.state.now().UTC(), Data: chunk}); err != nil {
			return 0, err
		}
		p = p[n:]
	}
	return original, nil
}

type streamState struct {
	mu     sync.Mutex
	sink   Sink
	cancel context.CancelFunc
	now    func() time.Time
	runID  string
	first  error
}

func (s *streamState) emit(event Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.first != nil {
		return s.first
	}
	if event.Data != nil {
		event.Data = append([]byte(nil), event.Data...)
	}
	if err := s.sink.Emit(event); err != nil {
		s.first = &Error{Code: ErrSink, Message: "deliver process event"}
		s.cancel()
		return s.first
	}
	return nil
}

func (s *streamState) fail(err error) {
	s.mu.Lock()
	if s.first == nil {
		s.first = err
		s.cancel()
	}
	s.mu.Unlock()
}

func (s *streamState) err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.first
}

func validatePlan(plan planner.Plan) error {
	if plan.Risk != packs.RiskRead {
		return &Error{Code: ErrInvalidPlan, Message: "executor accepts read-only plans only"}
	}
	if plan.Requirements.RequiresAuth {
		return &Error{Code: ErrInvalidPlan, Message: "executor does not yet accept auth-required plans"}
	}
	if plan.Output.Sensitivity.ContainsSecrets {
		return &Error{Code: ErrInvalidPlan, Message: "executor does not yet accept secret-bearing plans"}
	}
	if plan.ExecutablePath == "" || !filepath.IsAbs(plan.ExecutablePath) || plan.ExecutableName == "" || !plan.ExecutableIdentity.Valid() {
		return &Error{Code: ErrInvalidPlan, Message: "plan executable identity is incomplete"}
	}
	for _, arg := range plan.Args {
		if strings.ContainsRune(arg, '\x00') {
			return &Error{Code: ErrInvalidPlan, Message: "plan argument contains NUL"}
		}
	}
	return nil
}

func revalidateExecutable(plan planner.Plan) error {
	clean := filepath.Clean(plan.ExecutablePath)
	if !plan.ExecutableIdentity.Matches(clean) {
		return &Error{Code: ErrInvalidPlan, Message: "planned executable changed since discovery"}
	}
	info, err := os.Lstat(clean)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return &Error{Code: ErrInvalidPlan, Message: "planned executable is no longer a regular file"}
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return &Error{Code: ErrInvalidPlan, Message: "planned executable is no longer executable"}
	}
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return &Error{Code: ErrInvalidPlan, Message: "revalidate planned executable"}
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return &Error{Code: ErrInvalidPlan, Message: "revalidate planned executable"}
	}
	if !samePath(filepath.Clean(resolved), clean) {
		return &Error{Code: ErrInvalidPlan, Message: "planned executable path changed since discovery"}
	}
	actualName := filepath.Base(clean)
	if runtime.GOOS == "windows" {
		if !strings.EqualFold(actualName, plan.ExecutableName) {
			return &Error{Code: ErrInvalidPlan, Message: "planned executable basename changed since discovery"}
		}
	} else if actualName != plan.ExecutableName {
		return &Error{Code: ErrInvalidPlan, Message: "planned executable basename changed since discovery"}
	}
	return nil
}

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func randomRunID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}
