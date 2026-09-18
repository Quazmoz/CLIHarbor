package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

func TestRunAPICreateGetCancelUsesExistingSecurityBoundary(t *testing.T) {
	service := &fakeRunService{
		snapshot: runs.Snapshot{
			RunID:     strings.Repeat("a", 32),
			PackID:    "fixture",
			CommandID: "inspect",
			ToolID:    "fixture",
			Status:    runs.StatusRunning,
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

func TestRunAPIMapsStableRunErrorsWithoutDetails(t *testing.T) {
	for _, test := range []struct {
		code       runs.ErrorCode
		wantStatus int
	}{
		{runs.ErrInvalidRequest, http.StatusBadRequest},
		{runs.ErrUnavailable, http.StatusConflict},
		{runs.ErrCapacity, http.StatusTooManyRequests},
		{runs.ErrClosed, http.StatusServiceUnavailable},
	} {
		t.Run(string(test.code), func(t *testing.T) {
			service := &fakeRunService{startErr: &runs.Error{Code: test.code}}
			s := newTestServer(t, Config{Runs: service})
			client := sessionClient(t)
			bootstrap(t, client, s)
			csrf := fetchStatus(t, client, s).CSRFToken
			response := doAuthorizedRunPost(t, client, s, csrf, "/api/v1/runs", []byte(`{"packId":"fixture","commandId":"inspect"}`))
			defer response.Body.Close()
			if response.StatusCode != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.wantStatus)
			}
			var payload struct {
				Error string `json:"error"`
			}
			if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload.Error != string(test.code) {
				t.Fatalf("error = %q, want %q", payload.Error, test.code)
			}
		})
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

var _ = time.Time{}
