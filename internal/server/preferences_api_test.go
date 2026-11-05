package server

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

type memoryPreferences struct{ data []byte }

func (m *memoryPreferences) Load() []byte { return m.data }
func (m *memoryPreferences) Save(data []byte) error {
	m.data = append([]byte(nil), data...)
	return nil
}

func TestTaskPreferencesRoundTripOnlyValidatedIdentityDocuments(t *testing.T) {
	store := &memoryPreferences{data: []byte(`{"version":1,"favorites":[{"packId":"p","commandId":"tampered","argv":"x"}],"recent":[]}`)}
	s := newTestServer(t, Config{TaskPreferences: store})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	do := func(method, body, token string) (int, string) {
		request, err := http.NewRequest(method, s.BaseURL()+"/api/v1/preferences", strings.NewReader(body))
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
		return response.StatusCode, string(data)
	}

	if status, body := do(http.MethodGet, "", ""); status != http.StatusOK || body != string(emptyTaskPreferences) {
		t.Fatalf("tampered stored document = %d %s, want empty preferences", status, body)
	}
	valid := `{"version":1,"favorites":[{"packId":"cyberark-conjur-v9","commandId":"whoami"}],"recent":[]}`
	if status, _ := do(http.MethodPut, valid, ""); status != http.StatusForbidden {
		t.Fatalf("PUT without CSRF = %d, want 403", status)
	}
	for _, invalid := range []string{
		`{"version":2,"favorites":[],"recent":[]}`,
		`{"version":1,"favorites":[],"recent":[],"formValues":{"query":"x"}}`,
		`{"version":1,"favorites":[{"packId":"p","commandId":""}],"recent":[]}`,
		`{"version":1,"favorites":[],"recent":[],"recent":[]}`,
		`{"version":1,"favorites":[]}`,
	} {
		if status, _ := do(http.MethodPut, invalid, csrf); status != http.StatusBadRequest {
			t.Fatalf("PUT %s = %d, want 400", invalid, status)
		}
	}
	if status, _ := do(http.MethodPut, valid, csrf); status != http.StatusNoContent {
		t.Fatalf("valid PUT = %d, want 204", status)
	}
	if status, body := do(http.MethodGet, "", ""); status != http.StatusOK || body != valid {
		t.Fatalf("GET after save = %d %s", status, body)
	}
}
