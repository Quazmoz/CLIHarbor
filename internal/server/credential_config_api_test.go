package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

type fakeCredentialConfigurationService struct {
	mu      sync.Mutex
	request CredentialConfigurationRequest
	err     error
	calls   int
}

func (f *fakeCredentialConfigurationService) Configure(_ context.Context, request CredentialConfigurationRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.request = request
	return f.err
}

func TestCredentialConfigurationRequiresAuthenticatedCSRFProtectedLoopbackRequest(t *testing.T) {
	service := &fakeCredentialConfigurationService{}
	s := newTestServer(t, Config{CredentialConfiguration: service})

	unauthenticated, err := http.Post(
		s.BaseURL()+"/api/v1/auth/configure",
		"application/json",
		strings.NewReader(`{"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":"https://conjur.example.test","account":"engineering","authnType":"authn"}`),
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
		s.BaseURL()+"/api/v1/auth/configure",
		strings.NewReader(`{"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":"https://conjur.example.test","account":"engineering","authnType":"authn"}`),
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

func TestCredentialConfigurationAcceptsOnlyReviewedConnectionFields(t *testing.T) {
	service := &fakeCredentialConfigurationService{}
	s := newTestServer(t, Config{CredentialConfiguration: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	request, err := http.NewRequest(
		http.MethodPost,
		s.BaseURL()+"/api/v1/auth/configure",
		strings.NewReader(`{"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":" https://conjur.example.test ","account":" engineering ","authnType":"LDAP","serviceId":" corp "}`),
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
	want := CredentialConfigurationRequest{
		PackID:       "cyberark-conjur-v9",
		ToolID:       "conjur",
		ApplianceURL: "https://conjur.example.test",
		Account:      "engineering",
		AuthnType:    "ldap",
		ServiceID:    "corp",
	}
	if service.request != want {
		t.Fatalf("service request = %#v, want %#v", service.request, want)
	}
}

func TestCredentialConfigurationRejectsUnsafeOrAmbiguousRequestsBeforeService(t *testing.T) {
	service := &fakeCredentialConfigurationService{}
	s := newTestServer(t, Config{CredentialConfiguration: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	cases := []string{
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":"http://conjur.example.test","account":"engineering","authnType":"authn"}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":"https://user:pass@conjur.example.test","account":"engineering","authnType":"authn"}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":"https://conjur.example.test?target=x","account":"engineering","authnType":"authn"}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":"https://conjur.example.test","account":"","authnType":"authn"}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":"https://conjur.example.test","account":"engineering","authnType":"ldap","serviceId":""}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":"https://conjur.example.test","account":"engineering","authnType":"oidc"}`,
		`{"packId":"cyberark-conjur-v9","toolId":"conjur","applianceUrl":"https://conjur.example.test","account":"engineering","authnType":"authn","extra":true}`,
		`{"packId":"cyberark-conjur-v9","packId":"other","toolId":"conjur","applianceUrl":"https://conjur.example.test","account":"engineering","authnType":"authn"}`,
	}
	for _, body := range cases {
		request, err := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/auth/configure", strings.NewReader(body))
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
