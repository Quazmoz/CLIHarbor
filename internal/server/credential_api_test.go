package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

type fakeCredentialLoginService struct {
	mu      sync.Mutex
	request CredentialLoginRequest
	err     error
	calls   int
}

func (f *fakeCredentialLoginService) Login(_ context.Context, request CredentialLoginRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.request = request
	return f.err
}

func TestCredentialLoginRequiresAuthenticatedCSRFProtectedLoopbackRequest(t *testing.T) {
	service := &fakeCredentialLoginService{}
	s := newTestServer(t, Config{CredentialLogin: service})

	unauthenticated, err := http.Post(
		s.BaseURL()+"/api/v1/auth/login",
		"application/json",
		strings.NewReader(`{"packId":"cyberark-conjur-v9","toolId":"conjur","identity":"alice","secret":"never-log-me"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	unauthenticated.Body.Close()
	if unauthenticated.StatusCode != http.StatusForbidden && unauthenticated.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want boundary rejection", unauthenticated.StatusCode)
	}

	client := sessionClient(t)
	bootstrap(t, client, s)
	request, err := http.NewRequest(
		http.MethodPost,
		s.BaseURL()+"/api/v1/auth/login",
		strings.NewReader(`{"packId":"cyberark-conjur-v9","toolId":"conjur","identity":"alice","secret":"never-log-me"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", s.BaseURL())
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("missing CSRF status = %d, want %d", response.StatusCode, http.StatusForbidden)
	}

	if service.calls != 0 {
		t.Fatalf("service calls = %d, want 0", service.calls)
	}
}

func TestCredentialLoginHandsSecretOnlyToServiceAndReturnsNoContent(t *testing.T) {
	service := &fakeCredentialLoginService{}
	s := newTestServer(t, Config{CredentialLogin: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	const secret = "p@ss word with spaces"
	request, err := http.NewRequest(
		http.MethodPost,
		s.BaseURL()+"/api/v1/auth/login",
		strings.NewReader(`{"packId":"cyberark-conjur-v9","toolId":"conjur","identity":"  alice  ","secret":"`+secret+`"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Origin", s.BaseURL())
	request.Header.Set(csrfHeaderName, csrf)

	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	response.Body.Close()
	if readErr != nil {
		t.Fatal(readErr)
	}
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d: %s", response.StatusCode, http.StatusNoContent, body)
	}
	if len(body) != 0 {
		t.Fatalf("response body must be empty, got %q", body)
	}
	if service.calls != 1 {
		t.Fatalf("service calls = %d, want 1", service.calls)
	}
	if service.request.PackID != "cyberark-conjur-v9" || service.request.ToolID != "conjur" || service.request.Identity != "alice" || service.request.Secret != secret {
		t.Fatalf("service request = %#v", service.request)
	}
}

func TestCredentialLoginRejectsMalformedOrOversizedRequestsBeforeService(t *testing.T) {
	service := &fakeCredentialLoginService{}
	s := newTestServer(t, Config{CredentialLogin: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	cases := []string{
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","identity":"","secret":"x"}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","identity":"alice","secret":""}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","identity":"alice","secret":"x","extra":true}`,
		`{"packId":"cyberark-conjur-v9","packId":"other","toolId":"conjur","identity":"alice","secret":"x"}`,
	}
	for _, body := range cases {
		request, err := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/auth/login", strings.NewReader(body))
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
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("body %q status = %d, want %d", body, response.StatusCode, http.StatusBadRequest)
		}
	}

	oversized := strings.Repeat("x", maxCredentialLoginRequestBytes+1)
	request, err := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/auth/login", strings.NewReader(oversized))
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
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversized status = %d, want %d", response.StatusCode, http.StatusBadRequest)
	}
	if service.calls != 0 {
		t.Fatalf("service calls = %d, want 0", service.calls)
	}
}

func TestCredentialLoginSanitizesVendorFailure(t *testing.T) {
	const vendorSecret = "vendor-said-password-is-super-secret"
	service := &fakeCredentialLoginService{err: &CredentialLoginError{Code: CredentialLoginRejected}}
	s := newTestServer(t, Config{CredentialLogin: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	request, err := http.NewRequest(
		http.MethodPost,
		s.BaseURL()+"/api/v1/auth/login",
		strings.NewReader(`{"packId":"cyberark-conjur-v9","toolId":"conjur","identity":"alice","secret":"`+vendorSecret+`"}`),
	)
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
	body, readErr := io.ReadAll(response.Body)
	response.Body.Close()
	if readErr != nil {
		t.Fatal(readErr)
	}
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d: %s", response.StatusCode, http.StatusUnprocessableEntity, body)
	}
	if strings.Contains(string(body), vendorSecret) || strings.Contains(string(body), "password") {
		t.Fatalf("credential failure leaked sensitive detail: %s", body)
	}
	if !strings.Contains(string(body), string(apperror.CodeAuthenticationFailed)) {
		t.Fatalf("response missing stable authentication error code: %s", body)
	}
}
