package server

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

func TestRejectsHostileOriginForReadRequests(t *testing.T) {
	runID := strings.Repeat("a", 32)
	service := &streamRunService{snapshot: runs.Snapshot{
		RunID:  runID,
		Status: runs.StatusExited,
	}}
	s := newTestServer(t, Config{Runs: service})
	client := sessionClient(t)
	bootstrap(t, client, s)

	for _, path := range []string{"/api/v1/status", "/api/v1/runs/" + runID + "/events"} {
		for _, origin := range []string{"https://attacker.invalid", "null"} {
			req, err := http.NewRequest(http.MethodGet, s.BaseURL()+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Origin", origin)
			response, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, readErr := io.ReadAll(response.Body)
			response.Body.Close()
			if readErr != nil {
				t.Fatal(readErr)
			}
			if response.StatusCode != http.StatusForbidden || !strings.Contains(string(body), "\"code\":\"request_forbidden\"") || strings.Contains(string(body), "origin") {
				t.Fatalf("path %s hostile origin %q response = HTTP %d %q", path, origin, response.StatusCode, body)
			}
		}
	}

	req, err := http.NewRequest(http.MethodGet, s.BaseURL()+"/api/v1/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", s.BaseURL())
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("same-origin GET status = %d, want %d", response.StatusCode, http.StatusOK)
	}

	response, err = client.Get(s.BaseURL() + "/api/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("origin-less GET status = %d, want %d", response.StatusCode, http.StatusOK)
	}
}
