package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/structured"
)

func TestRunAPICreateGetCancelUsesExistingSecurityBoundary(t *testing.T) {
	service := &fakeRunService{
		snapshot: runs.Snapshot{
			RunID:     strings.Repeat("a", 32),
			PackID:    "fixture",
			CommandID: "inspect",
			ToolID:    "fixture",
			Status:    runs.StatusRunning,
			Structured: &structured.Result{
				Status: structured.StatusInvalid, Renderer: "cards", Error: structured.ErrWrongType,
			},
		},
	}
	s := newTestServer(t, Config{Runs: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	status := fetchStatus(t, client, s)

	requestBody := []byte(`{"packId":"fixture","commandId":"inspect","values":{"query":"snow 雪 & | ;"}}`)

	t.Run("missing session", func(t *testing.T) {
		request := newRunRequest(t, s, requestBody)
		request.Header.Set("Origin", s.BaseURL())
		request.Header.Set(csrfHeaderName, status.CSRFToken)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusUnauthorized)
		}
	})

	t.Run("wrong origin", func(t *testing.T) {
		request := newRunRequest(t, s, requestBody)
		request.Header.Set("Origin", "https://attacker.invalid")
		request.Header.Set(csrfHeaderName, status.CSRFToken)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusForbidden)
		}
	})

	t.Run("missing csrf", func(t *testing.T) {
		request := newRunRequest(t, s, requestBody)
		request.Header.Set("Origin", s.BaseURL())
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusForbidden)
		}
	})

	t.Run("valid create", func(t *testing.T) {
		response := doAuthorizedRunPost(t, client, s, status.CSRFToken, "/api/v1/runs", requestBody)
		defer response.Body.Close()
		if response.StatusCode != http.StatusAccepted {
			t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusAccepted)
		}
		var snapshot runs.Snapshot
		if err := json.NewDecoder(response.Body).Decode(&snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.RunID != service.snapshot.RunID || snapshot.Status != runs.StatusRunning {
			t.Fatalf("snapshot = %#v", snapshot)
		}
		request := service.lastRequest()
		if request.PackID != "fixture" || request.CommandID != "inspect" || string(request.Values["query"]) != `"snow 雪 & | ;"` {
			t.Fatalf("service request = %#v", request)
		}
	})

	t.Run("get", func(t *testing.T) {
		response, err := client.Get(s.BaseURL() + "/api/v1/runs/" + service.snapshot.RunID)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusOK)
		}
		var snapshot runs.Snapshot
		if err := json.NewDecoder(response.Body).Decode(&snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.Structured == nil || snapshot.Structured.Status != structured.StatusInvalid || snapshot.Structured.Error != structured.ErrWrongType {
			t.Fatalf("structured snapshot = %#v", snapshot.Structured)
		}
	})

	t.Run("cancel", func(t *testing.T) {
		response := doAuthorizedRunPost(t, client, s, status.CSRFToken, "/api/v1/runs/"+service.snapshot.RunID+"/cancel", nil)
		response.Body.Close()
		if response.StatusCode != http.StatusAccepted {
			t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusAccepted)
		}
		if got := service.lastCancelled(); got != service.snapshot.RunID {
			t.Fatalf("cancelled = %q", got)
		}
	})
}

func TestRunAPIFailsClosedOnExecutionAuthorityFieldsAndMalformedJSON(t *testing.T) {
	service := &fakeRunService{
		snapshot: runs.Snapshot{RunID: strings.Repeat("b", 32), Status: runs.StatusRunning},
	}
	s := newTestServer(t, Config{Runs: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	tests := []struct {
		name string
		body string
	}{
		{
			name: "browser executable path",
			body: `{"packId":"fixture","commandId":"inspect","executablePath":"C:\\evil.exe","values":{}}`,
		},
		{
			name: "browser argv",
			body: `{"packId":"fixture","commandId":"inspect","argv":["--unsafe"],"values":{}}`,
		},
		{
			name: "duplicate top-level key",
			body: `{"packId":"fixture","packId":"other","commandId":"inspect","values":{}}`,
		},
		{
			name: "duplicate nested input",
			body: `{"packId":"fixture","commandId":"inspect","values":{"query":"one","query":"two"}}`,
		},
		{
			name: "trailing json",
			body: `{"packId":"fixture","commandId":"inspect"} {"packId":"other"}`,
		},
		{
			name: "missing command",
			body: `{"packId":"fixture","values":{}}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := doAuthorizedRunPost(t, client, s, csrf, "/api/v1/runs", []byte(test.body))
			response.Body.Close()
			if response.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusBadRequest)
			}
		})
	}
	if calls := service.startCalls(); calls != 0 {
		t.Fatalf("run service start calls = %d, want 0", calls)
	}
}

func TestRunAPIRejectsMalformedUTF8BeforePlanning(t *testing.T) {
	service := &fakeRunService{
		snapshot: runs.Snapshot{RunID: strings.Repeat("d", 32), Status: runs.StatusRunning},
	}
	s := newTestServer(t, Config{Runs: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	body := append([]byte(`{"packId":"fixture","commandId":"inspect","values":{"query":"`), 0xff)
	body = append(body, []byte(`"}}`)...)
	response := doAuthorizedRunPost(t, client, s, csrf, "/api/v1/runs", body)
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusBadRequest)
	}
	if calls := service.startCalls(); calls != 0 {
		t.Fatalf("run service start calls = %d, want 0", calls)
	}
}

func TestRunAPIRejectsOversizeRequestBeforePlanning(t *testing.T) {
	service := &fakeRunService{
		snapshot: runs.Snapshot{RunID: strings.Repeat("c", 32), Status: runs.StatusRunning},
	}
	s := newTestServer(t, Config{Runs: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	body := []byte(`{"packId":"fixture","commandId":"inspect","values":{"query":"` + strings.Repeat("x", maxRunRequestBytes) + `"}}`)
	response := doAuthorizedRunPost(t, client, s, csrf, "/api/v1/runs", body)
	response.Body.Close()
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusRequestEntityTooLarge)
	}
	if calls := service.startCalls(); calls != 0 {
		t.Fatalf("run service start calls = %d, want 0", calls)
	}
}

func TestRunAPIMapsStableOperatorErrorsWithoutInternalDetails(t *testing.T) {
	for _, test := range []struct {
		name       string
		runErr     *runs.Error
		wantStatus int
		wantCode   apperror.Code
		wantField  string
	}{
		{name: "invalid input", runErr: &runs.Error{Code: runs.ErrInvalidRequest, Field: "values.query"}, wantStatus: http.StatusBadRequest, wantCode: apperror.CodeInvalidInput, wantField: "values.query"},
		{name: "tool unavailable", runErr: &runs.Error{Code: runs.ErrToolUnavailable}, wantStatus: http.StatusConflict, wantCode: apperror.CodeToolUnavailable},
		{name: "tool changed", runErr: &runs.Error{Code: runs.ErrToolChanged}, wantStatus: http.StatusConflict, wantCode: apperror.CodeToolChanged},
		{name: "policy blocked", runErr: &runs.Error{Code: runs.ErrPolicyBlocked}, wantStatus: http.StatusForbidden, wantCode: apperror.CodeCommandBlocked},
		{name: "capacity", runErr: &runs.Error{Code: runs.ErrCapacity}, wantStatus: http.StatusTooManyRequests, wantCode: apperror.CodeRunCapacity},
		{name: "closed", runErr: &runs.Error{Code: runs.ErrClosed}, wantStatus: http.StatusServiceUnavailable, wantCode: apperror.CodeRuntimeClosed},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &fakeRunService{startErr: test.runErr}
			s := newTestServer(t, Config{Runs: service})
			client := sessionClient(t)
			bootstrap(t, client, s)
			csrf := fetchStatus(t, client, s).CSRFToken
			response := doAuthorizedRunPost(t, client, s, csrf, "/api/v1/runs", []byte(`{"packId":"fixture","commandId":"inspect"}`))
			defer response.Body.Close()
			if response.StatusCode != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.wantStatus)
			}
			var payload apiErrorResponse
			if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload.Error.Code != test.wantCode || payload.Error.Field != test.wantField {
				t.Fatalf("error = %#v, want code=%q field=%q", payload.Error, test.wantCode, test.wantField)
			}
			if payload.Error.Message == "" || payload.Error.Category == "" {
				t.Fatalf("incomplete error DTO: %#v", payload.Error)
			}
		})
	}
}

func TestRunAPIInternalErrorDoesNotCrossBrowserBoundary(t *testing.T) {
	const marker = "PRIVATE_INTERNAL_MARKER <em>markup</em>"
	service := &fakeRunService{startErr: errors.New(marker)}
	s := newTestServer(t, Config{Runs: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	response := doAuthorizedRunPost(t, client, s, csrf, "/api/v1/runs", []byte(`{"packId":"fixture","commandId":"inspect"}`))
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusInternalServerError)
	}
	if strings.Contains(string(body), marker) || strings.Contains(string(body), "PRIVATE_INTERNAL_MARKER") {
		t.Fatalf("browser error leaked internal cause: %s", body)
	}
	if !strings.Contains(string(body), "\"code\":\"internal_error\"") {
		t.Fatalf("browser error missing stable code: %s", body)
	}
}

func newRunRequest(t *testing.T, s *Server, body []byte) *http.Request {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/runs", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	return request
}

func doAuthorizedRunPost(t *testing.T, client *http.Client, s *Server, csrf, path string, body []byte) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, s.BaseURL()+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", s.BaseURL())
	request.Header.Set(csrfHeaderName, csrf)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

type fakeRunService struct {
	mu        sync.Mutex
	snapshot  runs.Snapshot
	startErr  error
	cancelErr error
	requests  []runs.Request
	cancelled []string
}

func (f *fakeRunService) Start(request runs.Request) (runs.Snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.startErr != nil {
		return runs.Snapshot{}, f.startErr
	}
	cloned := runs.Request{
		PackID:    request.PackID,
		CommandID: request.CommandID,
		Values:    make(map[string]json.RawMessage, len(request.Values)),
	}
	for key, value := range request.Values {
		cloned.Values[key] = append(json.RawMessage(nil), value...)
	}
	f.requests = append(f.requests, cloned)
	return f.snapshot, nil
}

func (f *fakeRunService) Get(runID string) (runs.Snapshot, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if runID != f.snapshot.RunID {
		return runs.Snapshot{}, false
	}
	return f.snapshot, true
}

func (f *fakeRunService) Cancel(runID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cancelErr != nil {
		return f.cancelErr
	}
	if runID != f.snapshot.RunID {
		return &runs.Error{Code: runs.ErrNotFound}
	}
	f.cancelled = append(f.cancelled, runID)
	return nil
}

func (f *fakeRunService) lastRequest() runs.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		return runs.Request{}
	}
	return f.requests[len(f.requests)-1]
}

func (f *fakeRunService) lastCancelled() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.cancelled) == 0 {
		return ""
	}
	return f.cancelled[len(f.cancelled)-1]
}

func (f *fakeRunService) startCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}
