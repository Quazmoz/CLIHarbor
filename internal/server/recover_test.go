package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

func capturePanicLog(t *testing.T) *strings.Builder {
	t.Helper()
	var mu sync.Mutex
	var out strings.Builder
	previous := panicLogf
	panicLogf = func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		fmt.Fprintf(&out, format, args...)
	}
	t.Cleanup(func() { panicLogf = previous })
	return &out
}

func TestRecoverPanicsReturnsSanitizedAPIError(t *testing.T) {
	logs := capturePanicLog(t)
	s := &Server{}
	handler := s.recoverPanics(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("vendor said: password=hunter2")
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/tasks", nil))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	var body apiErrorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not a structured API error: %q", recorder.Body.String())
	}
	if body.Error.Code != apperror.CodeInternalError {
		t.Fatalf("error code = %q", body.Error.Code)
	}
	for _, leak := range []string{"hunter2", "password"} {
		if strings.Contains(recorder.Body.String(), leak) || strings.Contains(logs.String(), leak) {
			t.Fatalf("panic value leaked (%q): body=%q log=%q", leak, recorder.Body.String(), logs.String())
		}
	}
	if !strings.Contains(logs.String(), "(string)") || !strings.Contains(logs.String(), "/api/v1/tasks") {
		t.Fatalf("log lacks type/path context: %q", logs.String())
	}
}

func TestRecoverPanicsAbortsWhenResponseAlreadyStarted(t *testing.T) {
	capturePanicLog(t)
	s := &Server{}
	handler := s.recoverPanics(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("partial"))
		panic("late")
	}))
	defer func() {
		if recovered := recover(); recovered != http.ErrAbortHandler {
			t.Fatalf("recovered = %v, want http.ErrAbortHandler", recovered)
		}
	}()
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/runs/x/events", nil))
	t.Fatal("expected abort panic")
}

func TestRecoverPanicsPreservesErrAbortHandler(t *testing.T) {
	logs := capturePanicLog(t)
	s := &Server{}
	handler := s.recoverPanics(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	}))
	defer func() {
		if recovered := recover(); recovered != http.ErrAbortHandler {
			t.Fatalf("recovered = %v", recovered)
		}
		if logs.Len() != 0 {
			t.Fatalf("intentional abort was logged as a crash: %q", logs.String())
		}
	}()
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
}

func TestRecoverPanicsKeepsResponseControllerAndConnection(t *testing.T) {
	capturePanicLog(t)
	s := &Server{}
	mux := http.NewServeMux()
	mux.HandleFunc("/stream", func(w http.ResponseWriter, _ *http.Request) {
		controller := http.NewResponseController(w)
		if err := controller.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
			t.Errorf("SetWriteDeadline through wrapper: %v", err)
		}
		_, _ = w.Write([]byte("data: ok\n\n"))
		if err := controller.Flush(); err != nil {
			t.Errorf("Flush through wrapper: %v", err)
		}
	})
	mux.HandleFunc("/boom", func(http.ResponseWriter, *http.Request) { panic(struct{}{}) })
	server := httptest.NewServer(s.recoverPanics(mux))
	defer server.Close()

	response, err := http.Get(server.URL + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	line, _ := bufio.NewReader(response.Body).ReadString('\n')
	_ = response.Body.Close()
	if line != "data: ok\n" {
		t.Fatalf("stream line = %q", line)
	}
	for i := 0; i < 3; i++ {
		response, err := http.Get(server.URL + "/boom")
		if err != nil {
			t.Fatalf("panic dropped the connection instead of answering: %v", err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusInternalServerError {
			t.Fatalf("status = %d", response.StatusCode)
		}
	}
}

func TestBoundedPathStripsControlsAndTruncates(t *testing.T) {
	if got := boundedPath("/a\nb"); got != "/a?b" {
		t.Fatalf("got %q", got)
	}
	if got := boundedPath("/" + strings.Repeat("x", 500)); !strings.Contains(got, "(501 bytes)") {
		t.Fatalf("got %q", got)
	}
}
