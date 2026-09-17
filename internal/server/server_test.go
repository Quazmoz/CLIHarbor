package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"testing"
	"time"
)

type statusResponse struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	Session   string `json:"session"`
	CSRFToken string `json:"csrfToken"`
}

func TestServerBindsIPv4Loopback(t *testing.T) {
	t.Parallel()

	s := newTestServer(t, Config{})
	addr, ok := s.listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("listener address type = %T, want *net.TCPAddr", s.listener.Addr())
	}
	if !addr.IP.IsLoopback() || addr.IP.To4() == nil {
		t.Fatalf("listener address = %v, want IPv4 loopback", addr)
	}
}

func TestBootstrapIsSingleUseAndEstablishesSession(t *testing.T) {
	t.Parallel()

	s := newTestServer(t, Config{Version: "test-version"})
	client := sessionClient(t)

	response, err := client.Get(s.BootstrapURL())
	if err != nil {
		t.Fatalf("bootstrap request: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap final status = %d, want %d", response.StatusCode, http.StatusOK)
	}
	if response.Request.URL.Path != "/" {
		t.Fatalf("bootstrap final path = %q, want /", response.Request.URL.Path)
	}

	status := fetchStatus(t, client, s)
	if status.Name != "CLIHarbor" || status.Version != "test-version" || status.Session != "active" {
		t.Fatalf("unexpected status payload: %+v", status)
	}
	if status.CSRFToken == "" {
		t.Fatal("status CSRF token is empty")
	}

	noRedirect := &http.Client{
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	second, err := noRedirect.Get(s.BootstrapURL())
	if err != nil {
		t.Fatalf("second bootstrap request: %v", err)
	}
	second.Body.Close()
	if second.StatusCode != http.StatusGone {
		t.Fatalf("second bootstrap status = %d, want %d", second.StatusCode, http.StatusGone)
	}
}

func TestBootstrapExpires(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	s := newTestServer(t, Config{
		BootstrapTTL: time.Minute,
		Now: func() time.Time {
			return now
		},
	})

	now = now.Add(2 * time.Minute)
	response, err := (&http.Client{}).Get(s.BootstrapURL())
	if err != nil {
		t.Fatalf("expired bootstrap request: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusGone {
		t.Fatalf("expired bootstrap status = %d, want %d", response.StatusCode, http.StatusGone)
	}
}

func TestRejectsForgedHost(t *testing.T) {
	t.Parallel()

	s := newTestServer(t, Config{})
	req, err := http.NewRequest(http.MethodGet, s.BaseURL()+"/api/v1/status", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = "attacker.invalid"

	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("forged host request: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("forged host status = %d, want %d", response.StatusCode, http.StatusForbidden)
	}
}

func TestStateChangingRequestsRequireOriginAndCSRF(t *testing.T) {
	t.Parallel()

	s := newTestServer(t, Config{})
	client := sessionClient(t)
	bootstrap(t, client, s)
	status := fetchStatus(t, client, s)

	tests := []struct {
		name       string
		origin     string
		csrf       string
		wantStatus int
	}{
		{name: "wrong origin", origin: "https://attacker.invalid", csrf: status.CSRFToken, wantStatus: http.StatusForbidden},
		{name: "missing csrf", origin: s.BaseURL(), wantStatus: http.StatusForbidden},
		{name: "valid boundary then method rejected", origin: s.BaseURL(), csrf: status.CSRFToken, wantStatus: http.StatusMethodNotAllowed},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/status", nil)
			if err != nil {
				t.Fatalf("new request: %v", err)
			}
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.csrf != "" {
				req.Header.Set(csrfHeaderName, tc.csrf)
			}

			response, err := client.Do(req)
			if err != nil {
				t.Fatalf("state-changing request: %v", err)
			}
			response.Body.Close()
			if response.StatusCode != tc.wantStatus {
				t.Fatalf("status = %d, want %d", response.StatusCode, tc.wantStatus)
			}
		})
	}
}

func TestSecurityHeadersArePresent(t *testing.T) {
	t.Parallel()

	s := newTestServer(t, Config{})
	client := sessionClient(t)
	bootstrap(t, client, s)

	response, err := client.Get(s.BaseURL() + "/")
	if err != nil {
		t.Fatalf("index request: %v", err)
	}
	response.Body.Close()

	for _, header := range []string{
		"Cache-Control",
		"Content-Security-Policy",
		"Cross-Origin-Opener-Policy",
		"Referrer-Policy",
		"X-Content-Type-Options",
		"X-Frame-Options",
	} {
		if response.Header.Get(header) == "" {
			t.Errorf("missing security header %s", header)
		}
	}
}

func newTestServer(t *testing.T, config Config) *Server {
	t.Helper()

	s, err := New(config)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- s.Run(ctx)
	}()

	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("server shutdown: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Error("server did not shut down")
		}
	})

	return s
}

func sessionClient(t *testing.T) *http.Client {
	t.Helper()

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	return &http.Client{Jar: jar}
}

func bootstrap(t *testing.T, client *http.Client, s *Server) {
	t.Helper()

	response, err := client.Get(s.BootstrapURL())
	if err != nil {
		t.Fatalf("bootstrap request: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap final status = %d, want %d", response.StatusCode, http.StatusOK)
	}
}

func fetchStatus(t *testing.T, client *http.Client, s *Server) statusResponse {
	t.Helper()

	response, err := client.Get(s.BaseURL() + "/api/v1/status")
	if err != nil {
		t.Fatalf("status request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusOK)
	}

	var status statusResponse
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	return status
}

func TestBootstrapURLUsesExpectedOrigin(t *testing.T) {
	t.Parallel()

	s := newTestServer(t, Config{})
	parsed, err := url.Parse(s.BootstrapURL())
	if err != nil {
		t.Fatalf("parse bootstrap URL: %v", err)
	}
	if parsed.Scheme != "http" || parsed.Host != s.listener.Addr().String() || parsed.Path != "/bootstrap" {
		t.Fatalf("bootstrap URL = %q, want exact loopback origin/bootstrap path", parsed.String())
	}
	if parsed.Query().Get("token") == "" {
		t.Fatal("bootstrap URL missing token")
	}
}

func TestStatusRequiresSession(t *testing.T) {
	t.Parallel()

	s := newTestServer(t, Config{})
	response, err := http.Get(s.BaseURL() + "/api/v1/status")
	if err != nil {
		t.Fatalf("status request: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusUnauthorized)
	}
}

func TestInvalidBootstrapDoesNotConsumeToken(t *testing.T) {
	t.Parallel()

	s := newTestServer(t, Config{})
	invalid, err := http.Get(s.BaseURL() + "/bootstrap?token=definitely-not-valid")
	if err != nil {
		t.Fatalf("invalid bootstrap request: %v", err)
	}
	invalid.Body.Close()
	if invalid.StatusCode != http.StatusUnauthorized {
		t.Fatalf("invalid bootstrap status = %d, want %d", invalid.StatusCode, http.StatusUnauthorized)
	}

	client := sessionClient(t)
	bootstrap(t, client, s)
	status := fetchStatus(t, client, s)
	if status.Session != "active" {
		t.Fatalf("session = %q, want active", status.Session)
	}
}

func TestBootstrapCookieIsHttpOnlyStrictAndHostScoped(t *testing.T) {
	t.Parallel()

	s := newTestServer(t, Config{})
	client := &http.Client{
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Get(s.BootstrapURL())
	if err != nil {
		t.Fatalf("bootstrap request: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusSeeOther {
		t.Fatalf("bootstrap status = %d, want %d", response.StatusCode, http.StatusSeeOther)
	}

	cookies := response.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookie count = %d, want 1", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != sessionCookieName {
		t.Fatalf("cookie name = %q, want %q", cookie.Name, sessionCookieName)
	}
	if !cookie.HttpOnly {
		t.Error("session cookie must be HttpOnly")
	}
	if cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("session cookie SameSite = %v, want Strict", cookie.SameSite)
	}
	if cookie.Path != "/" {
		t.Fatalf("session cookie path = %q, want /", cookie.Path)
	}
	if cookie.Domain != "" {
		t.Fatalf("session cookie domain = %q, want host-only", cookie.Domain)
	}
}
