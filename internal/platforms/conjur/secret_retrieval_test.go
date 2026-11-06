package conjur

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/cyberark/conjur-api-go/conjurapi"
	"github.com/cyberark/conjur-api-go/conjurapi/response"
)

type fakeSecretRetrievalClient struct {
	resource    map[string]interface{}
	resourceErr error
	values      map[int]string // 0 = current
	errs        map[int]error
	calls       []string
}

func (f *fakeSecretRetrievalClient) Resource(id string) (map[string]interface{}, error) {
	f.calls = append(f.calls, "resource "+id)
	return f.resource, f.resourceErr
}

func (f *fakeSecretRetrievalClient) RetrieveSecretReader(id string) (io.ReadCloser, error) {
	f.calls = append(f.calls, "current "+id)
	return f.read(0)
}

func (f *fakeSecretRetrievalClient) RetrieveSecretWithVersionReader(id string, version int) (io.ReadCloser, error) {
	f.calls = append(f.calls, "version "+id)
	return f.read(version)
}

func (f *fakeSecretRetrievalClient) read(version int) (io.ReadCloser, error) {
	if err := f.errs[version]; err != nil {
		return nil, err
	}
	return io.NopCloser(strings.NewReader(f.values[version])), nil
}

func newTestSecretRetrieval(client *fakeSecretRetrievalClient) *SecretRetrievalService {
	return &SecretRetrievalService{
		enabled: true,
		loadConfig: func() (conjurapi.Config, error) {
			return conjurapi.Config{ApplianceURL: "https://conjur.example.test/", Account: "acct"}, nil
		},
		newClient: func(conjurapi.Config) (secretRetrievalClient, error) { return client, nil },
		now:       func() time.Time { return time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC) },
	}
}

func retrievalRequest(id string, version int) server.SecretRetrievalRequest {
	return server.SecretRetrievalRequest{PackID: PackID, ToolID: ToolID, Account: "acct",
		ApplianceURL: "https://conjur.example.test", VariableID: id, Version: version}
}

func TestSecretVersionsListsMetadataNewestFirst(t *testing.T) {
	client := &fakeSecretRetrievalClient{resource: map[string]interface{}{"secrets": []interface{}{
		map[string]interface{}{"version": float64(1), "expires_at": nil},
		map[string]interface{}{"version": float64(3), "expires_at": "2027-01-01T00:00:00.000+00:00"},
		map[string]interface{}{"version": float64(2)},
	}}}
	got, err := newTestSecretRetrieval(client).Versions(retrievalRequest("a:variable:b", 0))
	if err != nil || got.FailureCode != "" {
		t.Fatalf("versions = %+v, %v", got, err)
	}
	if len(got.Versions) != 3 || got.Versions[0].Version != 3 || got.Versions[0].ExpiresAt == "" || got.Versions[2].Version != 1 {
		t.Fatalf("versions = %+v", got.Versions)
	}
	// A bare ID shaped like a qualified one must stay inside the displayed account.
	if client.calls[0] != "resource acct:variable:a:variable:b" {
		t.Fatalf("calls = %v", client.calls)
	}
	for _, bad := range []interface{}{"x", []interface{}{"x"}, []interface{}{map[string]interface{}{"version": 1.5}},
		[]interface{}{map[string]interface{}{"version": float64(0)}},
		[]interface{}{map[string]interface{}{"version": float64(1)}, map[string]interface{}{"version": float64(1)}},
		[]interface{}{map[string]interface{}{"version": float64(1), "expires_at": "soon\u202e"}}} {
		client.resource = map[string]interface{}{"secrets": bad}
		if got, _ := newTestSecretRetrieval(client).Versions(retrievalRequest("v", 0)); got.FailureCode != "invalid_response" {
			t.Fatalf("malformed %v accepted: %+v", bad, got)
		}
	}
}

func TestSecretRevealReadsSelectedVersionAndLogsMetadataOnly(t *testing.T) {
	client := &fakeSecretRetrievalClient{values: map[int]string{0: secretSentinel + "-current", 2: secretSentinel + "-v2"}}
	service := newTestSecretRetrieval(client)
	current, _ := service.Reveal(retrievalRequest("app/db", 0))
	previous, _ := service.Reveal(retrievalRequest("app/db", 2))
	if current.Value != secretSentinel+"-current" || previous.Value != secretSentinel+"-v2" || previous.Version != 2 {
		t.Fatalf("reveal = %+v / %+v", current, previous)
	}
	if strings.Join(client.calls, ",") != "current acct:variable:app/db,version acct:variable:app/db" {
		t.Fatalf("calls = %v", client.calls)
	}
	log := service.AccessLog()
	encoded, _ := json.Marshal(log)
	if len(log) != 2 || log[1].Version != 2 || log[1].Outcome != "revealed" || strings.Contains(string(encoded), secretSentinel) {
		t.Fatalf("access log = %s", encoded)
	}
}

func TestSecretRevealFailsClosed(t *testing.T) {
	conjurErr := func(code int) error { return &response.ConjurError{Code: code} }
	cases := []struct {
		name  string
		value string
		err   error
		want  string
	}{
		{"forbidden is not missing", "", conjurErr(http.StatusForbidden), "forbidden"},
		{"missing version", "", conjurErr(http.StatusNotFound), "not_found"},
		{"expired session", "", conjurErr(http.StatusUnauthorized), "session_required"},
		{"transport", "", errors.New("dial " + secretSentinel), "unavailable"},
		{"oversized", strings.Repeat("x", secretRevealMaxBytes+1), nil, "output_limit_exceeded"},
		{"binary", string([]byte{0xff, 0xfe}), nil, "not_text"},
	}
	for _, c := range cases {
		client := &fakeSecretRetrievalClient{values: map[int]string{4: c.value}, errs: map[int]error{4: c.err}}
		service := newTestSecretRetrieval(client)
		got, err := service.Reveal(retrievalRequest("app/db", 4))
		encoded, _ := json.Marshal(got)
		if err != nil || got.FailureCode != c.want || got.Value != "" || strings.Contains(string(encoded), secretSentinel) {
			t.Errorf("%s: %s, %v", c.name, encoded, err)
		}
		if log := service.AccessLog(); len(log) != 1 || log[0].Outcome != c.want {
			t.Errorf("%s: log = %+v", c.name, log)
		}
	}
	exact := &fakeSecretRetrievalClient{values: map[int]string{0: strings.Repeat("x", secretRevealMaxBytes)}}
	if got, _ := newTestSecretRetrieval(exact).Reveal(retrievalRequest("v", 0)); got.FailureCode != "" {
		t.Fatalf("value at the bound refused: %s", got.FailureCode)
	}
}

func TestSecretRevealRefusesUndisplayedContext(t *testing.T) {
	for _, change := range []func(*server.SecretRetrievalRequest){
		func(r *server.SecretRetrievalRequest) { r.ApplianceURL = "https://other.example.test" },
		func(r *server.SecretRetrievalRequest) { r.Account = "other" },
	} {
		service := newTestSecretRetrieval(nil)
		service.newClient = func(conjurapi.Config) (secretRetrievalClient, error) {
			t.Fatal("client created for a mismatched context")
			return nil, nil
		}
		request := retrievalRequest("v", 0)
		change(&request)
		if got, err := service.Reveal(request); err != nil || got.FailureCode != "context_mismatch" {
			t.Fatalf("mismatch = %+v, %v", got, err)
		}
	}
	disabled := newTestSecretRetrieval(nil)
	disabled.enabled = false
	if _, err := disabled.Reveal(retrievalRequest("v", 0)); !errors.Is(err, server.ErrSecretRetrievalUnavailable) {
		t.Fatalf("disabled err = %v", err)
	}
	if _, err := newTestSecretRetrieval(nil).Reveal(retrievalRequest("bad\nid", 0)); !errors.Is(err, server.ErrSecretRetrievalInvalidRequest) {
		t.Fatalf("invalid id err = %v", err)
	}
	if len(disabled.AccessLog()) != 0 {
		t.Fatal("unavailable attempt recorded")
	}
}

func TestSecretAccessLogIsBounded(t *testing.T) {
	service := newTestSecretRetrieval(&fakeSecretRetrievalClient{values: map[int]string{0: "x"}})
	for range secretAccessLogLimit + 5 {
		service.Reveal(retrievalRequest("v", 0))
	}
	if got := len(service.AccessLog()); got != secretAccessLogLimit {
		t.Fatalf("log length = %d", got)
	}
}
