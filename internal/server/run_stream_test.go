package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

type streamRunService struct {
	mu          sync.Mutex
	snapshot    runs.Snapshot
	waitStarted chan struct{}
	waitDone    chan struct{}
	cancelCalls int
}

func (s *streamRunService) Start(runs.Request) (runs.Snapshot, error) {
	return s.snapshot, nil
}

func (s *streamRunService) Get(runID string) (runs.Snapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if runID != s.snapshot.RunID {
		return runs.Snapshot{}, false
	}
	return s.snapshot, true
}

func (s *streamRunService) Cancel(runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if runID != s.snapshot.RunID {
		return &runs.Error{Code: runs.ErrNotFound}
	}
	s.cancelCalls++
	return nil
}

func (s *streamRunService) WaitEvents(ctx context.Context, runID string, after uint64) (runs.EventBatch, error) {
	s.mu.Lock()
	snapshot := s.snapshot
	started := s.waitStarted
	s.mu.Unlock()
	if runID != snapshot.RunID {
		return runs.EventBatch{}, &runs.Error{Code: runs.ErrNotFound}
	}

	var latest uint64
	if len(snapshot.Events) != 0 {
		latest = snapshot.Events[len(snapshot.Events)-1].Sequence
	}
	if after > latest {
		return runs.EventBatch{}, &runs.Error{Code: runs.ErrInvalidCursor}
	}

	var events []runs.Event
	for _, event := range snapshot.Events {
		if event.Sequence > after {
			events = append(events, event)
		}
	}
	if len(events) != 0 || snapshot.Status != runs.StatusRunning {
		return runs.EventBatch{
			RunID:    snapshot.RunID,
			Events:   events,
			Status:   snapshot.Status,
			ExitCode: snapshot.ExitCode,
			Complete: snapshot.Status != runs.StatusRunning,
		}, nil
	}
	if started != nil {
		select {
		case <-started:
		default:
			close(started)
		}
	}
	<-ctx.Done()
	if s.waitDone != nil {
		close(s.waitDone)
	}
	return runs.EventBatch{}, ctx.Err()
}

func TestRunEventStreamReplaysAfterLastEventIDAndCompletes(t *testing.T) {
	exitCode := 0
	service := &streamRunService{snapshot: runs.Snapshot{
		RunID:     strings.Repeat("a", 32),
		PackID:    "fixture",
		CommandID: "inspect",
		ToolID:    "fixture",
		Status:    runs.StatusExited,
		ExitCode:  &exitCode,
		Events: []runs.Event{
			{Sequence: 1, Type: "run.started", Timestamp: time.Date(2026, 9, 18, 10, 0, 0, 0, time.UTC)},
			{Sequence: 2, Type: "stdout.chunk", Timestamp: time.Date(2026, 9, 18, 10, 0, 1, 0, time.UTC), DataBase64: "aGVsbG8="},
			{Sequence: 3, Type: "run.exited", Timestamp: time.Date(2026, 9, 18, 10, 0, 2, 0, time.UTC), ExitCode: &exitCode},
		},
	}}
	s := newTestServer(t, Config{Runs: service})
	client := sessionClient(t)
	bootstrap(t, client, s)

	request, err := http.NewRequest(http.MethodGet, s.BaseURL()+"/api/v1/runs/"+service.snapshot.RunID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Last-Event-ID", "1")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusOK)
	}
	if contentType := response.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/event-stream") {
		t.Fatalf("content type = %q", contentType)
	}
	text := string(body)
	if strings.Contains(text, "id: 1\n") || !strings.Contains(text, "id: 2\n") || !strings.Contains(text, "id: 3\n") {
		t.Fatalf("unexpected replay body: %q", text)
	}
	if !strings.Contains(text, "event: run-event\n") || !strings.Contains(text, "event: run-complete\n") {
		t.Fatalf("missing SSE event types: %q", text)
	}
	if !strings.Contains(text, "\"dataBase64\":\"aGVsbG8=\"") || !strings.Contains(text, "\"status\":\"exited\"") {
		t.Fatalf("missing safe stream payload: %q", text)
	}
}

func TestRunEventStreamRejectsMalformedAndImpossibleCursorsBeforeStreaming(t *testing.T) {
	service := &streamRunService{snapshot: runs.Snapshot{
		RunID:  strings.Repeat("b", 32),
		Status: runs.StatusRunning,
		Events: []runs.Event{{Sequence: 1, Type: "run.started", Timestamp: time.Now().UTC()}},
	}}
	s := newTestServer(t, Config{Runs: service})
	client := sessionClient(t)
	bootstrap(t, client, s)

	for _, cursor := range []string{"-1", " 1", "2", "18446744073709551616"} {
		t.Run(cursor, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodGet, s.BaseURL()+"/api/v1/runs/"+service.snapshot.RunID+"/events", nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Last-Event-ID", cursor)
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			body, readErr := io.ReadAll(response.Body)
			response.Body.Close()
			if readErr != nil {
				t.Fatal(readErr)
			}
			if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(body), "invalid_cursor") {
				t.Fatalf("cursor %q response = HTTP %d %q", cursor, response.StatusCode, body)
			}
		})
	}
}

func TestRunEventStreamDisconnectDoesNotCancelExecution(t *testing.T) {
	service := &streamRunService{
		snapshot: runs.Snapshot{
			RunID:  strings.Repeat("c", 32),
			Status: runs.StatusRunning,
			Events: []runs.Event{{Sequence: 1, Type: "run.started", Timestamp: time.Now().UTC()}},
		},
		waitStarted: make(chan struct{}),
		waitDone:    make(chan struct{}),
	}
	s := newTestServer(t, Config{Runs: service})
	client := sessionClient(t)
	bootstrap(t, client, s)

	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.BaseURL()+"/api/v1/runs/"+service.snapshot.RunID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}

	select {
	case <-service.waitStarted:
	case <-time.After(time.Second):
		response.Body.Close()
		t.Fatal("stream did not begin waiting for run events")
	}

	cancel()
	response.Body.Close()
	select {
	case <-service.waitDone:
	case <-time.After(time.Second):
		t.Fatal("stream handler did not observe client disconnect")
	}

	service.mu.Lock()
	cancelCalls := service.cancelCalls
	service.mu.Unlock()
	if cancelCalls != 0 {
		t.Fatalf("stream disconnect triggered %d run cancellations", cancelCalls)
	}
}

func TestRunEventStreamCapacityIsBounded(t *testing.T) {
	service := &streamRunService{
		snapshot: runs.Snapshot{
			RunID:  strings.Repeat("e", 32),
			Status: runs.StatusRunning,
			Events: []runs.Event{{Sequence: 1, Type: "run.started", Timestamp: time.Now().UTC()}},
		},
		waitStarted: make(chan struct{}),
		waitDone:    make(chan struct{}),
	}
	s := newTestServer(t, Config{Runs: service, MaxEventStreams: 1})
	client := sessionClient(t)
	bootstrap(t, client, s)

	ctx, cancel := context.WithCancel(context.Background())
	firstRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, s.BaseURL()+"/api/v1/runs/"+service.snapshot.RunID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	firstResponse, err := client.Do(firstRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer firstResponse.Body.Close()

	select {
	case <-service.waitStarted:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("first stream did not acquire a stream slot")
	}

	secondResponse, err := client.Get(s.BaseURL() + "/api/v1/runs/" + service.snapshot.RunID + "/events")
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	secondResponse.Body.Close()
	if secondResponse.StatusCode != http.StatusTooManyRequests {
		cancel()
		t.Fatalf("second stream status = %d, want %d", secondResponse.StatusCode, http.StatusTooManyRequests)
	}

	cancel()
	select {
	case <-service.waitDone:
	case <-time.After(time.Second):
		t.Fatal("first stream did not release after cancellation")
	}
}

func TestServerShutdownCancelsActiveRunEventStreams(t *testing.T) {
	service := &streamRunService{
		snapshot: runs.Snapshot{
			RunID:  strings.Repeat("f", 32),
			Status: runs.StatusRunning,
			Events: []runs.Event{{Sequence: 1, Type: "run.started", Timestamp: time.Now().UTC()}},
		},
		waitStarted: make(chan struct{}),
		waitDone:    make(chan struct{}),
	}
	frontend := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	s, err := New(Config{Frontend: frontend, Runs: service, ShutdownTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	serverCtx, stopServer := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(serverCtx) }()

	client := sessionClient(t)
	bootstrap(t, client, s)
	request, err := http.NewRequest(http.MethodGet, s.BaseURL()+"/api/v1/runs/"+service.snapshot.RunID+"/events", nil)
	if err != nil {
		stopServer()
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		stopServer()
		t.Fatal(err)
	}
	defer response.Body.Close()

	select {
	case <-service.waitStarted:
	case <-time.After(time.Second):
		stopServer()
		t.Fatal("stream did not begin waiting for run events")
	}

	stopServer()
	select {
	case <-service.waitDone:
	case <-time.After(time.Second):
		t.Fatal("stream observer did not stop during server shutdown")
	}
	select {
	case runErr := <-done:
		if runErr != nil {
			t.Fatalf("server shutdown: %v", runErr)
		}
	case <-time.After(time.Second):
		t.Fatal("server shutdown waited on an active SSE observer")
	}
}

func TestRunEventStreamRequiresAuthenticatedSession(t *testing.T) {
	service := &streamRunService{snapshot: runs.Snapshot{
		RunID:  strings.Repeat("d", 32),
		Status: runs.StatusExited,
	}}
	s := newTestServer(t, Config{Runs: service})

	response, err := http.Get(s.BaseURL() + "/api/v1/runs/" + service.snapshot.RunID + "/events")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusUnauthorized)
	}
}
