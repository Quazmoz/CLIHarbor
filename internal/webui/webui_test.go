package webui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProductionHandlerServesEmbeddedIndex(t *testing.T) {
	t.Parallel()

	handler, err := ProductionHandler()
	if err != nil {
		t.Fatalf("production handler: %v", err)
	}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "http://127.0.0.1/", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if !strings.Contains(recorder.Body.String(), "CLIHarbor") {
		t.Fatal("embedded index does not contain CLIHarbor")
	}
}

func TestProductionHandlerServesReviewedApplicationRoutes(t *testing.T) {
	t.Parallel()

	handler, err := ProductionHandler()
	if err != nil {
		t.Fatalf("production handler: %v", err)
	}

	for _, path := range []string{"/", "/authentication", "/tasks", "/runs", "/diagnostics"} {
		t.Run(path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+path, nil))
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
			}
			if !strings.Contains(recorder.Body.String(), "CLIHarbor") {
				t.Fatal("application route did not serve embedded index")
			}
		})
	}
}

func TestProductionHandlerRejectsUnknownAndTraversalPaths(t *testing.T) {
	t.Parallel()

	handler, err := ProductionHandler()
	if err != nil {
		t.Fatalf("production handler: %v", err)
	}

	for _, path := range []string{"/unknown", "/index.html", "/assets/../index.html"} {
		t.Run(path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/", nil)
			request.URL.Path = path
			handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNotFound)
			}
		})
	}
}

func TestProductionHandlerServesGeneratedAssets(t *testing.T) {
	t.Parallel()

	entries, err := fsReadDir("assets")
	if err != nil {
		t.Fatalf("read generated assets: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("embedded frontend has no generated assets")
	}

	handler, err := ProductionHandler()
	if err != nil {
		t.Fatalf("production handler: %v", err)
	}
	path := "/assets/" + entries[0]
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("asset status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if body, err := io.ReadAll(recorder.Result().Body); err != nil || len(body) == 0 {
		t.Fatalf("asset body length = %d, err = %v", len(body), err)
	}
}

func fsReadDir(name string) ([]string, error) {
	entries, err := embedded.ReadDir("static/" + name)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			result = append(result, entry.Name())
		}
	}
	return result, nil
}

func TestValidateDevURLAllowsOnlyIPv4LoopbackOrigin(t *testing.T) {
	t.Parallel()

	valid, err := validateDevURL("http://127.0.0.1:5173")
	if err != nil {
		t.Fatalf("valid URL rejected: %v", err)
	}
	if valid.String() != "http://127.0.0.1:5173" {
		t.Fatalf("normalized URL = %q", valid.String())
	}

	for _, raw := range []string{
		"https://127.0.0.1:5173",
		"http://localhost:5173",
		"http://0.0.0.0:5173",
		"http://127.0.0.1",
		"http://127.0.0.1:0",
		"http://127.0.0.1:5173/path",
		"http://user@127.0.0.1:5173",
		"http://127.0.0.1:5173?x=1",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := validateDevURL(raw); err == nil {
				t.Fatalf("URL %q unexpectedly accepted", raw)
			}
		})
	}
}

func TestDevProxyDoesNotExposeRuntimeCredentialsToVite(t *testing.T) {
	seen := make(chan http.Header, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
		w.Header().Add("Set-Cookie", "vite=value; Path=/")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()

	proxy, err := NewDevProxy(target.URL)
	if err != nil {
		t.Fatalf("new dev proxy: %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/assets/app.js", nil)
	request.Header.Set("Cookie", "cliharbor_session=secret-session")
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("Proxy-Authorization", "Basic secret")
	request.Header.Set("X-CLIHarbor-CSRF", "secret-csrf")
	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, request)

	forwarded := <-seen
	for _, name := range []string{"Cookie", "Authorization", "Proxy-Authorization", "X-CLIHarbor-CSRF"} {
		if value := forwarded.Get(name); value != "" {
			t.Errorf("development proxy forwarded %s=%q", name, value)
		}
	}
	if cookie := recorder.Header().Get("Set-Cookie"); cookie != "" {
		t.Fatalf("development proxy forwarded Set-Cookie response %q", cookie)
	}
}
