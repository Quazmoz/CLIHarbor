package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

type fakeCredentialInteractiveLoginService struct {
	mu      sync.Mutex
	request CredentialInteractiveLoginRequest
	err     error
	calls   int
}

func (f *fakeCredentialInteractiveLoginService) LaunchInteractive(_ context.Context, request CredentialInteractiveLoginRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.request = request
	return f.err
}

func TestCredentialInteractiveLoginRequiresAuthenticatedCSRFProtectedLoopbackRequest(t *testing.T) {
	service := &fakeCredentialInteractiveLoginService{}
	s := newTestServer(t, Config{CredentialInteractiveLogin: service})

	unauthenticated, err := http.Post(
		s.BaseURL()+"/api/v1/auth/interactive",
		"application/json",
		strings.NewReader(`{"packId":"cyberark-conjur-v9","toolId":"conjur"}`),
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
		s.BaseURL()+"/api/v1/auth/interactive",
		strings.NewReader(`{"packId":"cyberark-conjur-v9","toolId":"conjur"}`),
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

func TestCredentialInteractiveLoginAcceptsOnlyReviewedTargetIdentity(t *testing.T) {
	service := &fakeCredentialInteractiveLoginService{}
	s := newTestServer(t, Config{CredentialInteractiveLogin: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	request, err := http.NewRequest(
		http.MethodPost,
		s.BaseURL()+"/api/v1/auth/interactive",
		strings.NewReader(`{"packId":"cyberark-conjur-v9","toolId":"conjur"}`),
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
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d: %s", response.StatusCode, http.StatusNoContent, body)
	}
	if service.calls != 1 {
		t.Fatalf("service calls = %d, want 1", service.calls)
	}
	if service.request != (CredentialInteractiveLoginRequest{PackID: "cyberark-conjur-v9", ToolID: "conjur"}) {
		t.Fatalf("service request = %#v", service.request)
	}
}

func TestCredentialInteractiveLoginRejectsMalformedAuthorityBeforeService(t *testing.T) {
	service := &fakeCredentialInteractiveLoginService{}
	s := newTestServer(t, Config{CredentialInteractiveLogin: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	cases := []string{
		`{}`,
		`{"packId":"CyberArk","toolId":"conjur"}`,
		`{"packId":"cyberark-conjur-v9","toolId":"../conjur"}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","args":["login","-p","secret"]}`,
		`{"packId":"cyberark-conjur-v9","packId":"other","toolId":"conjur"}`,
	}
	for _, body := range cases {
		request, err := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/auth/interactive", strings.NewReader(body))
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
	if service.calls != 0 {
		t.Fatalf("service calls = %d, want 0", service.calls)
	}
}

func TestCredentialInteractiveLoginSanitizesServiceFailure(t *testing.T) {
	service := &fakeCredentialInteractiveLoginService{
		err: &CredentialLoginError{Code: CredentialLoginUnavailable},
	}
	s := newTestServer(t, Config{CredentialInteractiveLogin: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	request, err := http.NewRequest(
		http.MethodPost,
		s.BaseURL()+"/api/v1/auth/interactive",
		strings.NewReader(`{"packId":"cyberark-conjur-v9","toolId":"conjur"}`),
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
	response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusServiceUnavailable)
	}
}
