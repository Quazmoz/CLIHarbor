package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type statusResponse struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Session string `json:"session"`
}

func TestServerRequiresFrontendHandler(t *testing.T) {
	t.Parallel()
	if _, err := New(Config{}); err == nil {
		t.Fatal("New accepted nil frontend handler")
	}
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
	if response.StatusCode != http.StatusOK || response.Request.URL.Path != "/" || response.Request.URL.RawQuery != "" {
		t.Fatalf("bootstrap final request = %s status=%d, want clean / with 200", response.Request.URL.String(), response.StatusCode)
	}
	status := fetchStatus(t, client, s)
	if status.Name != "CLIHarbor" || status.Version != "test-version" || status.Session != "active" {
		t.Fatalf("unexpected status payload: %+v", status)
	}

	noRedirect := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
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
	s := newTestServer(t, Config{BootstrapTTL: time.Minute, Now: func() time.Time { return now }})
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

func TestRejectsForgedHostForAPIAndFrontend(t *testing.T) {
	t.Parallel()
	s := newTestServer(t, Config{})
	for _, path := range []string{"/api/v1/status", "/"} {
		req, err := http.NewRequest(http.MethodGet, s.BaseURL()+path, nil)
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
			t.Fatalf("path %s forged host status = %d, want %d", path, response.StatusCode, http.StatusForbidden)
		}
	}
}

func TestStateChangingRequestsRequireOriginAndCSRF(t *testing.T) {
	t.Parallel()
	s := newTestServer(t, Config{})
	client := sessionClient(t)
	bootstrap(t, client, s)
	tests := []struct {
		name       string
		origin     string
		csrf       string
		wantStatus int
	}{
		{name: "wrong origin", origin: "https://attacker.invalid", csrf: s.csrfToken, wantStatus: http.StatusForbidden},
		{name: "missing csrf", origin: s.BaseURL(), wantStatus: http.StatusForbidden},
		{name: "valid boundary then method rejected", origin: s.BaseURL(), csrf: s.csrfToken, wantStatus: http.StatusMethodNotAllowed},
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

func TestAPIRoutesAreNotSwallowedByFrontend(t *testing.T) {
	t.Parallel()
	frontend := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("FRONTEND-MARKER"))
	})
	s := newTestServer(t, Config{Frontend: frontend})
	client := sessionClient(t)
	bootstrap(t, client, s)
	for _, path := range []string{"/api/v1/unknown", "/api/other", "/bootstrap/extra"} {
		response, err := client.Get(s.BaseURL() + path)
		if err != nil {
			t.Fatalf("request %s: %v", path, err)
		}
		body, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil {
			t.Fatalf("read %s response: %v", path, readErr)
		}
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("path %s status = %d, want %d", path, response.StatusCode, http.StatusNotFound)
		}
		if strings.Contains(string(body), "FRONTEND-MARKER") {
			t.Fatalf("path %s was swallowed by frontend handler", path)
		}
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
	for _, header := range []string{"Cache-Control", "Content-Security-Policy", "Cross-Origin-Opener-Policy", "Referrer-Policy", "X-Content-Type-Options", "X-Frame-Options"} {
		if response.Header.Get(header) == "" {
			t.Errorf("missing security header %s", header)
		}
	}
	csp := response.Header.Get("Content-Security-Policy")
	if strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "unsafe-eval") {
		t.Fatalf("CSP contains unsafe execution directive: %q", csp)
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
	if status := fetchStatus(t, client, s); status.Session != "active" {
		t.Fatalf("session = %q, want active", status.Session)
	}
}

func TestBootstrapCookieIsHttpOnlyStrictAndHostScoped(t *testing.T) {
	t.Parallel()
	s := newTestServer(t, Config{})
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
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
	if cookie.Name != sessionCookieName || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.Domain != "" {
		t.Fatalf("unexpected session cookie attributes: %+v", cookie)
	}
}

func TestBootstrapURLUsesExpectedOrigin(t *testing.T) {
	t.Parallel()
	s := newTestServer(t, Config{})
	parsed, err := url.Parse(s.BootstrapURL())
	if err != nil {
		t.Fatalf("parse bootstrap URL: %v", err)
	}
	if parsed.Scheme != "http" || parsed.Host != s.listener.Addr().String() || parsed.Path != "/bootstrap" || parsed.Query().Get("token") == "" {
		t.Fatalf("bootstrap URL has unexpected shape")
	}
}

func TestShutdownDeadlineForceClosesActiveConnections(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var startOnce sync.Once
	var releaseOnce sync.Once
	releaseHandler := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseHandler()

	frontend := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		startOnce.Do(func() { close(started) })
		<-release
		_, _ = w.Write([]byte("done"))
	})
	s, err := New(Config{Frontend: frontend, ShutdownTimeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatalf("new server: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	client := &http.Client{
		Jar: jar,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	bootstrapResponse, err := client.Get(s.BootstrapURL())
	if err != nil {
		t.Fatalf("bootstrap request: %v", err)
	}
	bootstrapResponse.Body.Close()
	if bootstrapResponse.StatusCode != http.StatusSeeOther {
		t.Fatalf("bootstrap status = %d, want %d", bootstrapResponse.StatusCode, http.StatusSeeOther)
	}

	requestDone := make(chan error, 1)
	go func() {
		response, requestErr := client.Get(s.BaseURL() + "/")
		if response != nil {
			response.Body.Close()
		}
		requestDone <- requestErr
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("frontend request did not become active")
	}

	cancel()
	select {
	case runErr := <-done:
		if runErr == nil || !strings.Contains(runErr.Error(), "context deadline exceeded") {
			t.Fatalf("run error = %v, want graceful-shutdown deadline error", runErr)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not force-close after shutdown deadline")
	}

	releaseHandler()
	select {
	case <-requestDone:
	case <-time.After(time.Second):
		t.Fatal("active client request did not unblock after forced close")
	}

	connection, dialErr := net.DialTimeout("tcp", s.listener.Addr().String(), 100*time.Millisecond)
	if dialErr == nil {
		connection.Close()
		t.Fatal("listener still accepted connections after shutdown deadline")
	}
}

func newTestServer(t *testing.T, config Config) *Server {
	t.Helper()
	if config.Frontend == nil {
		config.Frontend = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte("<!doctype html><title>CLIHarbor</title>"))
		})
	}
	s, err := New(config)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	// Most request-boundary tests are not testing HTTP keep-alive behavior.
	// Disable it in the shared harness so parallel/race runs do not leave
	// unrelated persistent connections competing with lifecycle assertions.
	s.httpServer.SetKeepAlivesEnabled(false)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("server shutdown: %v", err)
			}
		case <-time.After(shutdownTimeout + 2*time.Second):
			t.Error("server did not shut down within configured shutdown bound")
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
