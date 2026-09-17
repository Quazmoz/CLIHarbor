package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

const (
	defaultBootstrapTTL = 2 * time.Minute
	shutdownTimeout     = 5 * time.Second
	sessionCookieName   = "cliharbor_session"
	csrfHeaderName      = "X-CLIHarbor-CSRF"
)

// Config contains the small set of runtime values needed by the local server.
// Random and Now are injectable to keep security-sensitive behavior deterministic in tests.
type Config struct {
	Version      string
	BootstrapTTL time.Duration
	Random       io.Reader
	Now          func() time.Time
	Frontend     http.Handler
}

// Server owns one loopback listener and one in-memory browser session.
// It intentionally has no persistence: restarting CLIHarbor invalidates the session.
type Server struct {
	listener   net.Listener
	httpServer *http.Server
	baseURL    string
	version    string

	mu                sync.Mutex
	now               func() time.Time
	bootstrapToken    string
	bootstrapExpires  time.Time
	bootstrapConsumed bool
	sessionToken      string
	csrfToken         string
}

// New creates a server bound to an ephemeral IPv4 loopback port. It does not
// start accepting requests until Run is called.
func New(config Config) (*Server, error) {
	if config.Frontend == nil {
		return nil, fmt.Errorf("frontend handler is required")
	}
	if config.Version == "" {
		config.Version = "dev"
	}
	if config.BootstrapTTL <= 0 {
		config.BootstrapTTL = defaultBootstrapTTL
	}
	if config.Random == nil {
		config.Random = rand.Reader
	}
	if config.Now == nil {
		config.Now = time.Now
	}

	bootstrapToken, err := randomToken(config.Random)
	if err != nil {
		return nil, fmt.Errorf("generate bootstrap token: %w", err)
	}
	sessionToken, err := randomToken(config.Random)
	if err != nil {
		return nil, fmt.Errorf("generate session token: %w", err)
	}
	csrfToken, err := randomToken(config.Random)
	if err != nil {
		return nil, fmt.Errorf("generate CSRF token: %w", err)
	}

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("bind loopback listener: %w", err)
	}

	s := &Server{
		listener:         listener,
		baseURL:          "http://" + listener.Addr().String(),
		version:          config.Version,
		now:              config.Now,
		bootstrapToken:   bootstrapToken,
		bootstrapExpires: config.Now().Add(config.BootstrapTTL),
		sessionToken:     sessionToken,
		csrfToken:        csrfToken,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/bootstrap", s.handleBootstrap)
	mux.HandleFunc("/bootstrap/", http.NotFound)
	mux.Handle("/api/v1/status", s.requireSession(http.HandlerFunc(s.handleStatus)))
	mux.Handle("/api/", s.requireSession(http.HandlerFunc(http.NotFound)))
	mux.Handle("/", s.requireSession(config.Frontend))

	s.httpServer = &http.Server{
		Handler:           s.securityHeaders(s.validateRequestBoundary(mux)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}

	return s, nil
}

// BaseURL returns the exact loopback origin used by the runtime.
func (s *Server) BaseURL() string {
	return s.baseURL
}

// BootstrapURL returns the one-time URL used to establish a browser session.
// The caller should treat this URL as short-lived sensitive material.
func (s *Server) BootstrapURL() string {
	s.mu.Lock()
	defer s.mu.Unlock()

	values := url.Values{}
	values.Set("token", s.bootstrapToken)
	return s.baseURL + "/bootstrap?" + values.Encode()
}

// Close immediately releases the listener. It is primarily used when startup
// fails before Run takes ownership of the lifecycle.
func (s *Server) Close() error {
	return s.httpServer.Close()
}

// Run serves until the context is cancelled or the HTTP server fails.
func (s *Server) Run(ctx context.Context) error {
	errCh := make(chan error, 1)
	go func() {
		errCh <- s.httpServer.Serve(s.listener)
	}()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve loopback HTTP: %w", err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()

		shutdownErr := s.httpServer.Shutdown(shutdownCtx)
		serveErr := <-errCh
		if shutdownErr != nil {
			return fmt.Errorf("shutdown loopback HTTP: %w", shutdownErr)
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			return fmt.Errorf("serve loopback HTTP during shutdown: %w", serveErr)
		}
		return nil
	}
}

func randomToken(reader io.Reader) (string, error) {
	var raw [32]byte
	if _, err := io.ReadFull(reader, raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func (s *Server) validateRequestBoundary(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.listener.Addr().String() {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}

		if isStateChangingMethod(r.Method) {
			if r.Header.Get("Origin") != s.baseURL {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
			if !constantTimeEqual(r.Header.Get(csrfHeaderName), s.csrfToken) {
				http.Error(w, "invalid CSRF token", http.StatusForbidden)
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}

func isStateChangingMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	provided := r.URL.Query().Get("token")

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.bootstrapConsumed {
		http.Error(w, "bootstrap token already used", http.StatusGone)
		return
	}
	if !s.now().Before(s.bootstrapExpires) {
		http.Error(w, "bootstrap token expired", http.StatusGone)
		return
	}
	if !constantTimeEqual(provided, s.bootstrapToken) {
		http.Error(w, "invalid bootstrap token", http.StatusUnauthorized)
		return
	}

	s.bootstrapConsumed = true
	s.bootstrapToken = ""

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    s.sessionToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookieName)
		if err != nil || !constantTimeEqual(cookie.Value, s.sessionToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Session string `json:"session"`
	}{
		Name:    "CLIHarbor",
		Version: s.version,
		Session: "active",
	})
}

func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
