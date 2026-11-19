package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type fakeRenameService struct{ calls int }

func (s *fakeRenameService) Rename(_ context.Context, action string, r SecretRenameRequest) (SecretRenameResponse, error) {
	s.calls++
	return SecretRenameResponse{Source: r.Target.VariableID, Destination: r.Destination, Status: action}, nil
}

func TestRenameAPIBoundary(t *testing.T) {
	service := &fakeRenameService{}
	s := newTestServer(t, Config{SecretRename: service})
	client := sessionClient(t)
	valid := `{"target":{"packId":"cyberark-conjur-v9","toolId":"conjur","account":"acct","applianceUrl":"https://conjur.example.test","variableId":"apps/old"},"destination":"apps/new"}`
	send := func(method, path, body, origin, csrf string) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, s.BaseURL()+"/api/v1/conjur/secrets/rename/"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		r.Header.Set(csrfHeaderName, csrf)
		resp, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("rename response must not be cached")
		}
		return resp.StatusCode, string(data)
	}
	if status, _ := send("POST", "copy", valid, s.BaseURL(), ""); status != 403 {
		t.Fatalf("no session = %d", status)
	}
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken
	for _, action := range []string{"review", "copy", "delete", "discard"} {
		if status, _ := send("POST", action, valid, s.BaseURL(), ""); status != 403 {
			t.Fatalf("no csrf = %d", status)
		}
		if status, _ := send("POST", action, valid, "https://foreign.example.test", csrf); status != 403 {
			t.Fatalf("foreign origin = %d", status)
		}
		if status, _ := send("GET", action, "", s.BaseURL(), csrf); status != 405 {
			t.Fatalf("GET = %d", status)
		}
	}
	for _, body := range []string{
		strings.Replace(valid, `"destination":"apps/new"`, `"destination":"apps/new","argv":["delete"]`, 1),
		strings.Replace(valid, `"destination":"apps/new"`, `"destination":"apps/new","destination":"apps/other"`, 1),
		strings.Replace(valid, `"variableId":"apps/old"`, `"variableId":"apps/old","version":1`, 1),
		strings.Replace(valid, `"destination":"apps/new"`, `"destination":"spoof\u202enew"`, 1),
		strings.Replace(valid, `"destination":"apps/new"`, `"destination":""`, 1),
	} {
		if status, _ := send("POST", "review", body, s.BaseURL(), csrf); status != 400 {
			t.Fatalf("invalid request = %d", status)
		}
	}
	if service.calls != 0 {
		t.Fatal("rejected request reached service")
	}
	if status, body := send("POST", "review", valid, s.BaseURL(), csrf); status != 200 || !strings.Contains(body, `"source":"apps/old"`) {
		t.Fatalf("valid review = %d %s", status, body)
	}
}
