package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type fakeToolService struct {
	tools []ToolDiagnostic
}

func (f fakeToolService) ListTools() []ToolDiagnostic {
	return append([]ToolDiagnostic(nil), f.tools...)
}

func TestToolAPIRequiresSessionAndOmitsExecutionAuthority(t *testing.T) {
	service := fakeToolService{tools: []ToolDiagnostic{{
		PackID:            "fixture",
		PackName:          "Fixture Pack",
		PackVersion:       "1.0.0",
		ToolID:            "fixture",
		Status:            "ready",
		Version:           "1.2.3",
		VersionConstraint: ">=1.0.0 <2.0.0",
		Message:           "safe diagnostic",
	}}}
	s := newTestServer(t, Config{Tools: service})

	unauthenticated, err := http.Get(s.BaseURL() + "/api/v1/tools")
	if err != nil {
		t.Fatal(err)
	}
	unauthenticated.Body.Close()
	if unauthenticated.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", unauthenticated.StatusCode, http.StatusUnauthorized)
	}

	client := sessionClient(t)
	bootstrap(t, client, s)
	response, err := client.Get(s.BaseURL() + "/api/v1/tools")
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
	for _, forbidden := range []string{"path", "executable", "candidate", "identity", "argv", "environment"} {
		if strings.Contains(strings.ToLower(string(body)), forbidden) {
			t.Fatalf("tool response unexpectedly contains authority field %q: %s", forbidden, body)
		}
	}

	var payload struct {
		Tools []ToolDiagnostic `json:"tools"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Tools) != 1 || payload.Tools[0].ToolID != "fixture" || payload.Tools[0].Version != "1.2.3" {
		t.Fatalf("tool payload = %#v", payload.Tools)
	}
}

func TestToolAPIIsReadOnly(t *testing.T) {
	s := newTestServer(t, Config{Tools: fakeToolService{}})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	request, err := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/tools", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", s.BaseURL())
	request.Header.Set(csrfHeaderName, csrf)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusMethodNotAllowed)
	}
}
