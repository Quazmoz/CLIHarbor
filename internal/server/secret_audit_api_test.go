package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type fakeSecretAuditService struct {
	mu      sync.Mutex
	starts  []SecretAuditRequest
	cancels int
	err     error
}

func (f *fakeSecretAuditService) Snapshot() SecretAuditSnapshot {
	return SecretAuditSnapshot{Available: true, State: "idle"}
}

func (f *fakeSecretAuditService) Start(request SecretAuditRequest) (SecretAuditSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts = append(f.starts, request)
	return SecretAuditSnapshot{Available: true, State: "running"}, f.err
}

func (f *fakeSecretAuditService) Cancel() SecretAuditSnapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancels++
	return SecretAuditSnapshot{Available: true, State: "cancelled"}
}

func TestSecretAuditEndpointEnforcesBoundaryAndRequestShape(t *testing.T) {
	service := &fakeSecretAuditService{}
	s := newTestServer(t, Config{SecretAudit: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken
	endpoint := s.BaseURL() + "/api/v1/conjur/secret-audit"

	send := func(method, body, token string) int {
		t.Helper()
		request, err := http.NewRequest(method, endpoint, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", s.BaseURL())
		if token != "" {
			request.Header.Set(csrfHeaderName, token)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return response.StatusCode
	}

	valid := `{"packId":"cyberark-conjur-v9","toolId":"conjur","minimumConfidence":"medium","applianceUrl":"https://conjur.example.test","scanType":"regex","pattern":"^team/.*/password$"}`
	if status := send(http.MethodPost, valid, ""); status != http.StatusForbidden {
		t.Fatalf("missing CSRF status = %d, want 403", status)
	}
	if status := send(http.MethodDelete, "", ""); status != http.StatusForbidden {
		t.Fatalf("cancel without CSRF status = %d, want 403", status)
	}
	for _, body := range []string{
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","minimumConfidence":"low"}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","minimumConfidence":"medium","path":"x"}`,
		`{"packId":"Bad Pack","toolId":"conjur","minimumConfidence":"high"}`,
		`{"packId":"cyberark-conjur-v9","packId":"x","toolId":"conjur","minimumConfidence":"high"}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","minimumConfidence":"high","scanType":"regex","pattern":"["}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","minimumConfidence":"high","applianceUrl":"http://conjur.example.test"}`,
	} {
		if status := send(http.MethodPost, body, csrf); status != http.StatusBadRequest {
			t.Fatalf("body %s status = %d, want 400", body, status)
		}
	}
	if len(service.starts) != 0 {
		t.Fatalf("rejected requests reached the service: %+v", service.starts)
	}

	if status := send(http.MethodPost, valid, csrf); status != http.StatusAccepted {
		t.Fatalf("valid start status = %d, want 202", status)
	}
	if got := service.starts[0]; got.PackID != "cyberark-conjur-v9" || got.ToolID != "conjur" || got.MinimumConfidence != "medium" ||
		got.ApplianceURL != "https://conjur.example.test" || got.ScanType != "regex" || got.Pattern != "^team/.*/password$" {
		t.Fatalf("start request = %+v", got)
	}
	if status := send(http.MethodDelete, "", csrf); status != http.StatusOK || service.cancels != 1 {
		t.Fatalf("cancel status = %d, cancels = %d", status, service.cancels)
	}

	service.err = ErrSecretAuditUnavailable
	if status := send(http.MethodPost, valid, csrf); status != http.StatusConflict {
		t.Fatalf("unavailable start status = %d, want 409", status)
	}
}

func TestSecretAuditValidatesScanConfiguration(t *testing.T) {
	valid := SecretAuditRequest{
		PackID: "cyberark-conjur-v9", ToolID: "conjur", MinimumConfidence: "high",
		ApplianceURL: "https://conjur.example.test", ScanType: "regex", Pattern: `^team[./].*/password$`,
	}
	for _, kind := range []string{"contains", "exact", "regex", "references", ""} {
		request := valid
		request.ScanType = kind
		if kind == "references" || kind == "" {
			request.Pattern = ""
		}
		encoded, _ := json.Marshal(request)
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(encoded)))
		r.Header.Set("Content-Type", "application/json")
		got, err := decodeSecretAuditRequest(httptest.NewRecorder(), r)
		if err != nil || got != request {
			t.Fatalf("valid %s scan decoded as %+v, error %v", kind, got, err)
		}
	}
	for _, change := range []func(*SecretAuditRequest){
		func(r *SecretAuditRequest) { r.ScanType = "script" },
		func(r *SecretAuditRequest) { r.Pattern = "" },
		func(r *SecretAuditRequest) { r.ScanType = "references" },
		func(r *SecretAuditRequest) { r.Pattern = "[" },
		func(r *SecretAuditRequest) { r.Pattern = `(?=password)` },
		func(r *SecretAuditRequest) { r.Pattern = strings.Repeat("x", 1025) },
		func(r *SecretAuditRequest) { r.Pattern = "text\ntext" },
		func(r *SecretAuditRequest) { r.Pattern = "spoof\u202etxt" },
		func(r *SecretAuditRequest) { r.Pattern = string([]byte{0xff}) },
		func(r *SecretAuditRequest) { r.ApplianceURL = "http://conjur.example.test" },
		func(r *SecretAuditRequest) { r.ApplianceURL = "https://user:pass@conjur.example.test" },
		func(r *SecretAuditRequest) { r.ApplianceURL = "https://conjur.example.test?secret=value" },
		func(r *SecretAuditRequest) { r.ApplianceURL = "https://conjur.example.test#fragment" },
		func(r *SecretAuditRequest) { r.ApplianceURL = " https://conjur.example.test" },
	} {
		request := valid
		change(&request)
		if ValidateSecretAuditRequest(request) == nil {
			t.Fatal("invalid scan accepted")
		}
	}
}
