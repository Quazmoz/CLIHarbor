package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type fakeVaultService struct{ requests []VaultSecretRequest }

func (f *fakeVaultService) Context() VaultContext {
	return VaultContext{Address: "https://vault.example.test", Ready: true}
}
func (f *fakeVaultService) List(_ context.Context, r VaultSecretRequest) (VaultListResponse, error) {
	f.requests = append(f.requests, r)
	return VaultListResponse{Mount: r.Mount, Path: r.Path, Keys: []string{"db"}}, nil
}
func (f *fakeVaultService) Reveal(_ context.Context, r VaultSecretRequest) (VaultRevealResponse, error) {
	f.requests = append(f.requests, r)
	return VaultRevealResponse{Mount: r.Mount, Path: r.Path, Fields: []VaultSecretField{{Key: "k", Value: "SENTINEL"}}}, nil
}
func (f *fakeVaultService) AccessLog() []VaultAccessEntry { return nil }

func TestVaultEndpointsEnforceBoundary(t *testing.T) {
	service := &fakeVaultService{}
	s := newTestServer(t, Config{Vault: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken
	send := func(method, path, body, token string) (int, string, string) {
		t.Helper()
		request, err := http.NewRequest(method, s.BaseURL()+"/api/v1/vault/"+path, strings.NewReader(body))
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

	valid := `{"mount":"secret","path":"apps/db"}`
	if status, _, _ := send(http.MethodPost, "kv/reveal", valid, ""); status != http.StatusForbidden {
		t.Fatalf("reveal without CSRF = %d", status)
	}
	for _, body := range []string{
		`{"mount":"secret","path":""}`, `{"mount":"-flag","path":"x"}`, `{"mount":"secret","path":"../x"}`,
		`{"mount":"secret","path":"x","address":"https://evil"}`,
	} {
		if status, _, _ := send(http.MethodPost, "kv/reveal", body, csrf); status != http.StatusBadRequest {
			t.Fatalf("reveal %s = %d, want 400", body, status)
		}
	}
	if len(service.requests) != 0 {
		t.Fatalf("invalid requests reached the service: %#v", service.requests)
	}
	if status, body, cache := send(http.MethodPost, "kv/reveal", valid, csrf); status != http.StatusOK || !strings.Contains(body, "SENTINEL") || !strings.Contains(cache, "no-store") {
		t.Fatalf("reveal = %d %s cache=%q", status, body, cache)
	}
	if status, body, _ := send(http.MethodPost, "kv/list", `{"mount":"secret","path":""}`, csrf); status != http.StatusOK || !strings.Contains(body, `"keys":["db"]`) {
		t.Fatalf("root list = %d %s", status, body)
	}
	if status, body, _ := send(http.MethodGet, "context", "", ""); status != http.StatusOK || !strings.Contains(body, "vault.example.test") {
		t.Fatalf("context = %d %s", status, body)
	}
}
