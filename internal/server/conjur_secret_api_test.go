package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type fakeSecretRetrievalService struct {
	requests []SecretRetrievalRequest
	err      error
}

func (f *fakeSecretRetrievalService) Versions(r SecretRetrievalRequest) (SecretVersionsResponse, error) {
	f.requests = append(f.requests, r)
	return SecretVersionsResponse{VariableID: r.VariableID, Versions: []SecretVersion{{Version: 2}, {Version: 1}}}, f.err
}

func (f *fakeSecretRetrievalService) Reveal(r SecretRetrievalRequest) (SecretRevealResponse, error) {
	f.requests = append(f.requests, r)
	return SecretRevealResponse{VariableID: r.VariableID, Version: r.Version, Value: "SENTINEL"}, f.err
}

func (f *fakeSecretRetrievalService) AccessLog() []SecretAccessEntry {
	return []SecretAccessEntry{{VariableID: "app/db", Outcome: "revealed"}}
}

func TestSecretRetrievalEndpointsEnforceBoundaryAndShape(t *testing.T) {
	service := &fakeSecretRetrievalService{}
	s := newTestServer(t, Config{SecretRetrieval: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	send := func(method, path, body, token string) (int, string, string) {
		t.Helper()
		request, err := http.NewRequest(method, s.BaseURL()+"/api/v1/conjur/secrets/"+path, strings.NewReader(body))
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
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(data), response.Header.Get("Cache-Control")
	}

	valid := `{"packId":"cyberark-conjur-v9","toolId":"conjur","account":"acct","applianceUrl":"https://conjur.example.test","variableId":"app/db","version":3}`
	if status, _, _ := send(http.MethodPost, "reveal", valid, ""); status != http.StatusForbidden {
		t.Fatalf("reveal without CSRF = %d", status)
	}
	if status, _, _ := send(http.MethodGet, "reveal", "", ""); status != http.StatusMethodNotAllowed {
		t.Fatalf("GET reveal = %d", status)
	}
	base := `"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":"https://conjur.example.test"`
	for _, body := range []string{
		`{` + base + `,"account":"acct","variableId":"app/db","version":-1}`,
		`{` + base + `,"account":"acct","variableId":"app/db","version":"1"}`,
		`{` + base + `,"account":"acct","variableId":"","version":1}`,
		`{` + base + `,"account":"acct","variableId":" app/db"}`,
		`{` + base + `,"account":"acct","variableId":"spoof\u202edb"}`,
		`{` + base + `,"account":"a:b","variableId":"app/db"}`,
		`{` + base + `,"account":"acct","variableId":"app/db","value":"x"}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":"http://conjur.example.test","account":"acct","variableId":"app/db"}`,
	} {
		if status, _, _ := send(http.MethodPost, "reveal", body, csrf); status != http.StatusBadRequest {
			t.Fatalf("body %s = %d, want 400", body, status)
		}
	}
	if status, _, _ := send(http.MethodPost, "versions", valid, csrf); status != http.StatusBadRequest {
		t.Fatalf("versions with a version = %d, want 400", status)
	}
	if len(service.requests) != 0 {
		t.Fatalf("rejected requests reached the service: %+v", service.requests)
	}

	status, body, cache := send(http.MethodPost, "reveal", valid, csrf)
	var revealed SecretRevealResponse
	if status != http.StatusOK || cache != "no-store" || json.Unmarshal([]byte(body), &revealed) != nil || revealed.Value != "SENTINEL" || revealed.Version != 3 {
		t.Fatalf("reveal = %d %q %s", status, cache, body)
	}
	versions := strings.Replace(valid, `,"version":3`, "", 1)
	if status, body, _ := send(http.MethodPost, "versions", versions, csrf); status != http.StatusOK || !strings.Contains(body, `"version":2`) {
		t.Fatalf("versions = %d %s", status, body)
	}
	if status, body, _ := send(http.MethodGet, "access-log", "", ""); status != http.StatusOK || !strings.Contains(body, `"outcome":"revealed"`) {
		t.Fatalf("access log = %d %s", status, body)
	}

	service.err = ErrSecretRetrievalUnavailable
	if status, _, _ := send(http.MethodPost, "reveal", valid, csrf); status != http.StatusConflict {
		t.Fatalf("unavailable reveal = %d, want 409", status)
	}
}
