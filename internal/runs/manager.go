package runs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/executor"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
	"github.com/Quazmoz/CLIHarbor/internal/structured"
)

const (
	defaultMaxActive       = 4
	defaultMaxRetained     = 32
	defaultTimeout         = 30 * time.Second
	defaultWaitDelay       = 2 * time.Second
	defaultChunkBytes      = 16 << 10
	defaultMaxOutputStream = 256 << 10
	defaultMaxEventBytes   = 1 << 20
	defaultMaxEvents       = 1024
)

type Status string

const (
	StatusRunning   Status = "running"
	StatusExited    Status = "exited"
	StatusCancelled Status = "cancelled"
	StatusTimedOut  Status = "timed-out"
	StatusFailed    Status = "failed"
)

type ErrorCode string

const (
	ErrInvalidRequest ErrorCode = "invalid_request"
	ErrUnavailable    ErrorCode = "unavailable"
	ErrCapacity       ErrorCode = "capacity"
	ErrNotFound       ErrorCode = "not_found"
	ErrClosed         ErrorCode = "closed"
	ErrInvalidCursor  ErrorCode = "invalid_cursor"
)

type Error struct {
	Code ErrorCode
}

func (e *Error) Error() string {
	return string(e.Code)
}

type Request struct {
	PackID    string
	CommandID string
	Values    map[string]json.RawMessage
}

type Event struct {
	Sequence   uint64    `json:"sequence"`
	Type       string    `json:"type"`
	Timestamp  time.Time `json:"timestamp"`
	DataBase64 string    `json:"dataBase64,omitempty"`
	ExitCode   *int      `json:"exitCode,omitempty"`
}

type Snapshot struct {
	RunID       string             `json:"runId"`
	PackID      string             `json:"packId"`
	CommandID   string             `json:"commandId"`
	ToolID      string             `json:"toolId"`
	ToolVersion string             `json:"toolVersion,omitempty"`
	Status      Status             `json:"status"`
	StartedAt   *time.Time         `json:"startedAt,omitempty"`
	EndedAt     *time.Time         `json:"endedAt,omitempty"`
	ExitCode    *int               `json:"exitCode,omitempty"`
	Structured  *structured.Result `json:"structured,omitempty"`
	Events      []Event            `json:"events,omitempty"`
}

type EventBatch struct {
	RunID    string
	Events   []Event
	Status   Status
	ExitCode *int
	Complete bool
}

type Config struct {
	MaxActive               int
	MaxRetained             int
	Timeout                 time.Duration
	WaitDelay               time.Duration
	ChunkBytes              int
	MaxOutputBytesPerStream int64
	MaxEventBytesPerRun     int64
	MaxEventsPerRun         int
	NewRunID                func() (string, error)
}

type Manager struct {
	registry  *packs.Registry
	discovery discovery.Snapshot
	config    Config

	ctx    context.Context
	cancel context.CancelFunc

	mu        sync.Mutex
	runs      map[string]*record
	order     []string
	active    int
	closed    bool
	waitGroup sync.WaitGroup
}

type record struct {
	runID              string
	packID             string
	commandID          string
	toolID             string
	toolVersion        string
	status             Status
	startedAt          *time.Time
	endedAt            *time.Time
	exitCode           *int
	events             []Event
	eventBytes         int64
	nextSeq            uint64
	cancel             context.CancelFunc
	done               chan struct{}
	changed            chan struct{}
	structuredSpec     *packs.StructuredOutput
	structuredRenderer string
	structuredStdout   []byte
	structuredTooLarge bool
	structuredResult   *structured.Result
}

func NewManager(parent context.Context, registry *packs.Registry, snapshot discovery.Snapshot, config Config) (*Manager, error) {
	if parent == nil {
		return nil, fmt.Errorf("parent context is required")
	}
	if registry == nil {
		return nil, fmt.Errorf("pack registry is required")
	}
	if config.MaxActive <= 0 {
		config.MaxActive = defaultMaxActive
	}
	if config.MaxRetained <= 0 {
		config.MaxRetained = defaultMaxRetained
	}
	if config.MaxRetained < config.MaxActive {
		return nil, fmt.Errorf("max retained runs must be at least max active runs")
	}
	if config.Timeout <= 0 {
		config.Timeout = defaultTimeout
	}
	if config.WaitDelay <= 0 {
		config.WaitDelay = defaultWaitDelay
	}
	if config.ChunkBytes <= 0 {
		config.ChunkBytes = defaultChunkBytes
	}
	if config.MaxOutputBytesPerStream <= 0 {
		config.MaxOutputBytesPerStream = defaultMaxOutputStream
	}
	if config.MaxEventBytesPerRun <= 0 {
		config.MaxEventBytesPerRun = defaultMaxEventBytes
	}
	if config.MaxEventsPerRun <= 0 {
		config.MaxEventsPerRun = defaultMaxEvents
	}
	minEventBytes := config.MaxOutputBytesPerStream * 2
	if config.MaxEventBytesPerRun < minEventBytes {
		return nil, fmt.Errorf("max event bytes per run must cover both output streams")
	}
	if config.NewRunID == nil {
		config.NewRunID = randomRunID
	}

	ctx, cancel := context.WithCancel(parent)
	return &Manager{
		registry:  registry,
		discovery: snapshot,
		config:    config,
		ctx:       ctx,
		cancel:    cancel,
		runs:      make(map[string]*record),
	}, nil
}

func (m *Manager) Start(request Request) (Snapshot, error) {
	if m == nil {
		return Snapshot{}, &Error{Code: ErrClosed}
	}
	m.mu.Lock()
	closed := m.closed || m.ctx.Err() != nil
	atCapacity := m.active >= m.config.MaxActive
	m.mu.Unlock()
	if closed {
		return Snapshot{}, &Error{Code: ErrClosed}
	}
	if atCapacity {
		return Snapshot{}, &Error{Code: ErrCapacity}
	}

	plan, err := planner.Build(m.registry, m.discovery, planner.Request{
		PackID:    request.PackID,
		CommandID: request.CommandID,
		Values:    cloneValues(request.Values),
	})
	if err != nil {
		return Snapshot{}, classifyPlannerError(err)
	}

	runID, err := m.config.NewRunID()
	if err != nil || !validRunID(runID) {
		return Snapshot{}, fmt.Errorf("generate run identifier")
	}

	m.mu.Lock()
	if m.closed || m.ctx.Err() != nil {
		m.mu.Unlock()
		return Snapshot{}, &Error{Code: ErrClosed}
	}
	if m.active >= m.config.MaxActive {
		m.mu.Unlock()
		return Snapshot{}, &Error{Code: ErrCapacity}
	}
	if err := m.makeRetentionRoomLocked(); err != nil {
		m.mu.Unlock()
		return Snapshot{}, err
	}
	if _, exists := m.runs[runID]; exists {
		m.mu.Unlock()
		return Snapshot{}, fmt.Errorf("generated duplicate run identifier")
	}

	runCtx, cancel := context.WithCancel(m.ctx)
	rec := &record{
		runID:              runID,
		packID:             plan.PackID,
		commandID:          plan.CommandID,
		toolID:             plan.ToolID,
		toolVersion:        plan.ToolVersion,
		status:             StatusRunning,
		cancel:             cancel,
		done:               make(chan struct{}),
		changed:            make(chan struct{}),
		structuredSpec:     cloneStructuredSpec(plan.Output.Structured),
		structuredRenderer: plan.Output.Renderer,
	}
	m.runs[runID] = rec
	m.order = append(m.order, runID)
	m.active++
	m.waitGroup.Add(1)
	snapshot := rec.snapshot()
	m.mu.Unlock()

	go m.execute(runCtx, rec, plan.Clone())
	return snapshot, nil
}

func (m *Manager) Get(runID string) (Snapshot, bool) {
	if m == nil || !validRunID(runID) {
		return Snapshot{}, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.runs[runID]
	if !ok {
		return Snapshot{}, false
	}
	return rec.snapshot(), true
}

func (m *Manager) WaitEvents(ctx context.Context, runID string, after uint64) (EventBatch, error) {
	if m == nil || ctx == nil || !validRunID(runID) {
		return EventBatch{}, &Error{Code: ErrNotFound}
	}
	for {
		m.mu.Lock()
		rec, ok := m.runs[runID]
		if !ok {
			m.mu.Unlock()
			return EventBatch{}, &Error{Code: ErrNotFound}
		}
		if after > rec.nextSeq {
			m.mu.Unlock()
			return EventBatch{}, &Error{Code: ErrInvalidCursor}
		}
		events := cloneEventsAfter(rec.events, after)
		complete := rec.status != StatusRunning
		if len(events) != 0 || complete {
			batch := EventBatch{
				RunID:    rec.runID,
				Events:   events,
				Status:   rec.status,
				ExitCode: cloneInt(rec.exitCode),
				Complete: complete,
			}
			m.mu.Unlock()
			return batch, nil
		}
		changed := rec.changed
		m.mu.Unlock()

		select {
		case <-changed:
		case <-ctx.Done():
			return EventBatch{}, ctx.Err()
		}
	}
}

func (m *Manager) Wait(ctx context.Context, runID string) (Snapshot, error) {
	if m == nil || !validRunID(runID) {
		return Snapshot{}, &Error{Code: ErrNotFound}
	}
	m.mu.Lock()
	rec, ok := m.runs[runID]
	if !ok {
		m.mu.Unlock()
		return Snapshot{}, &Error{Code: ErrNotFound}
	}
	if rec.status != StatusRunning {
		snapshot := rec.snapshot()
		m.mu.Unlock()
		return snapshot, nil
	}
	done := rec.done
	m.mu.Unlock()

	select {
	case <-done:
		m.mu.Lock()
		snapshot := rec.snapshot()
		m.mu.Unlock()
		return snapshot, nil
	case <-ctx.Done():
		return Snapshot{}, ctx.Err()
	}
}

func (m *Manager) Cancel(runID string) error {
	if m == nil || !validRunID(runID) {
		return &Error{Code: ErrNotFound}
	}
	m.mu.Lock()
	rec, ok := m.runs[runID]
	if !ok {
		m.mu.Unlock()
		return &Error{Code: ErrNotFound}
	}
	if rec.status != StatusRunning {
		m.mu.Unlock()
		return nil
	}
	cancel := rec.cancel
	m.mu.Unlock()
	cancel()
	return nil
}

func (m *Manager) Shutdown(ctx context.Context) error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	if !m.closed {
		m.closed = true
		m.cancel()
	}
	m.mu.Unlock()

	done := make(chan struct{})
	go func() {
		m.waitGroup.Wait()
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *Manager) execute(ctx context.Context, rec *record, plan planner.Plan) {
	defer m.waitGroup.Done()
	exec := executor.New(executor.Config{
		Timeout:                 m.config.Timeout,
		WaitDelay:               m.config.WaitDelay,
		ChunkBytes:              m.config.ChunkBytes,
		MaxOutputBytesPerStream: m.config.MaxOutputBytesPerStream,
		NewRunID:                func() (string, error) { return rec.runID, nil },
	})

	result, runErr := exec.Run(ctx, plan, executor.SinkFunc(func(event executor.Event) error {
		return m.recordEvent(rec, event)
	}))

	var parsed *structured.Result
	if rec.structuredSpec != nil {
		m.mu.Lock()
		spec := cloneStructuredSpec(rec.structuredSpec)
		renderer := rec.structuredRenderer
		stdout := append([]byte(nil), rec.structuredStdout...)
		tooLarge := rec.structuredTooLarge
		m.mu.Unlock()

		var value structured.Result
		switch {
		case runErr != nil:
			value = structured.Unavailable(renderer, structured.ErrExecutionFailed)
		case result.Status == executor.StatusCancelled:
			value = structured.Unavailable(renderer, structured.ErrRunCancelled)
		case result.Status == executor.StatusTimedOut:
			value = structured.Unavailable(renderer, structured.ErrRunTimedOut)
		case result.Status != executor.StatusExited:
			value = structured.Unavailable(renderer, structured.ErrExecutionFailed)
		case result.ExitCode != 0:
			value = structured.Unavailable(renderer, structured.ErrNonzeroExit)
		case tooLarge:
			value = structured.Invalid(renderer, structured.ErrOutputTooLarge)
		default:
			value = structured.Parse(ctx, stdout, *spec, renderer)
		}
		parsed = &value
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.status != StatusRunning {
		return
	}
	m.active--
	rec.cancel = nil

	switch {
	case runErr != nil:
		rec.status = StatusFailed
		now := time.Now().UTC()
		rec.endedAt = &now
		rec.exitCode = nil
	default:
		rec.status = statusFromExecutor(result.Status)
		if !result.StartedAt.IsZero() {
			started := result.StartedAt
			rec.startedAt = &started
		}
		if !result.EndedAt.IsZero() {
			ended := result.EndedAt
			rec.endedAt = &ended
		}
		if result.Status == executor.StatusExited {
			code := result.ExitCode
			rec.exitCode = &code
		}
	}
	rec.structuredResult = parsed
	rec.signalChangedLocked()
	close(rec.done)
}

func (m *Manager) recordEvent(rec *record, event executor.Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.status != StatusRunning {
		return errors.New("run is no longer active")
	}
	dataBytes := int64(len(event.Data))
	if rec.eventBytes+dataBytes > m.config.MaxEventBytesPerRun || len(rec.events) >= m.config.MaxEventsPerRun {
		return errors.New("run event buffer exhausted")
	}
	if rec.structuredSpec != nil && event.Type == executor.EventStdout && len(event.Data) != 0 && !rec.structuredTooLarge {
		if len(event.Data) > structured.MaxInputBytes-len(rec.structuredStdout) {
			rec.structuredTooLarge = true
			rec.structuredStdout = nil
		} else {
			rec.structuredStdout = append(rec.structuredStdout, event.Data...)
		}
	}
	rec.nextSeq++
	stored := Event{
		Sequence:  rec.nextSeq,
		Type:      string(event.Type),
		Timestamp: event.Timestamp,
		ExitCode:  cloneInt(event.ExitCode),
	}
	if len(event.Data) != 0 {
		stored.DataBase64 = encodeBase64(event.Data)
		rec.eventBytes += dataBytes
	}
	rec.events = append(rec.events, stored)
	rec.signalChangedLocked()
	if event.Type == executor.EventStarted && rec.startedAt == nil {
		started := event.Timestamp
		rec.startedAt = &started
	}
	return nil
}

func (m *Manager) makeRetentionRoomLocked() error {
	for len(m.runs) >= m.config.MaxRetained {
		evicted := false
		for index, runID := range m.order {
			rec := m.runs[runID]
			if rec != nil && rec.status != StatusRunning {
				delete(m.runs, runID)
				m.order = append(m.order[:index], m.order[index+1:]...)
				evicted = true
				break
			}
		}
		if !evicted {
			return &Error{Code: ErrCapacity}
		}
	}
	return nil
}

func (r *record) signalChangedLocked() {
	close(r.changed)
	r.changed = make(chan struct{})
}

func (r *record) snapshot() Snapshot {
	events := make([]Event, len(r.events))
	for i, event := range r.events {
		events[i] = event
		events[i].ExitCode = cloneInt(event.ExitCode)
	}
	return Snapshot{
		RunID:       r.runID,
		PackID:      r.packID,
		CommandID:   r.commandID,
		ToolID:      r.toolID,
		ToolVersion: r.toolVersion,
		Status:      r.status,
		StartedAt:   cloneTime(r.startedAt),
		EndedAt:     cloneTime(r.endedAt),
		ExitCode:    cloneInt(r.exitCode),
		Structured:  cloneStructuredResult(r.structuredResult),
		Events:      events,
	}
}

func cloneEventsAfter(events []Event, after uint64) []Event {
	start := 0
	for start < len(events) && events[start].Sequence <= after {
		start++
	}
	out := make([]Event, len(events)-start)
	for i, event := range events[start:] {
		out[i] = event
		out[i].ExitCode = cloneInt(event.ExitCode)
	}
	return out
}

func classifyPlannerError(err error) error {
	var plannerErr *planner.Error
	if !errors.As(err, &plannerErr) {
		return fmt.Errorf("build execution plan: %w", err)
	}
	switch plannerErr.Code {
	case planner.ErrUnknownPack, planner.ErrUnknownCommand, planner.ErrUnknownInput, planner.ErrMissingInput, planner.ErrInvalidInput:
		return &Error{Code: ErrInvalidRequest}
	default:
		return &Error{Code: ErrUnavailable}
	}
}

func statusFromExecutor(status executor.Status) Status {
	switch status {
	case executor.StatusExited:
		return StatusExited
	case executor.StatusCancelled:
		return StatusCancelled
	case executor.StatusTimedOut:
		return StatusTimedOut
	default:
		return StatusFailed
	}
}

func cloneValues(values map[string]json.RawMessage) map[string]json.RawMessage {
	if values == nil {
		return nil
	}
	out := make(map[string]json.RawMessage, len(values))
	for key, value := range values {
		out[key] = append(json.RawMessage(nil), value...)
	}
	return out
}

func cloneStructuredSpec(value *packs.StructuredOutput) *packs.StructuredOutput {
	if value == nil {
		return nil
	}
	cloned := *value
	cloned.Fields = append([]packs.StructuredField(nil), value.Fields...)
	return &cloned
}

func cloneStructuredResult(value *structured.Result) *structured.Result {
	if value == nil {
		return nil
	}
	cloned := *value
	cloned.Fields = append([]structured.Field(nil), value.Fields...)
	return &cloned
}

func cloneInt(value *int) *int {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func randomRunID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func validRunID(value string) bool {
	if len(value) != 32 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
