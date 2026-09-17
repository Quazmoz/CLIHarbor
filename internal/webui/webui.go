package webui

import (
	"embed"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

// static contains generated Vite production output. Update it only through the
// repository task tooling so the embedded assets stay synchronized with web/.
//
//go:embed static
var embedded embed.FS

// ProductionHandler serves the generated frontend from the executable.
// No SPA fallback is used yet: only / and generated /assets/* files exist.
func ProductionHandler() (http.Handler, error) {
	assets, err := fs.Sub(embedded, "static")
	if err != nil {
		return nil, fmt.Errorf("open embedded frontend: %w", err)
	}
	if _, err := fs.Stat(assets, "index.html"); err != nil {
		return nil, fmt.Errorf("embedded frontend missing index.html: %w", err)
	}
	return staticHandler{assets: assets}, nil
}

type staticHandler struct {
	assets fs.FS
}

func (h staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name := ""
	switch {
	case r.URL.Path == "/":
		name = "index.html"
	case strings.HasPrefix(r.URL.Path, "/assets/"):
		name = strings.TrimPrefix(r.URL.Path, "/")
	default:
		http.NotFound(w, r)
		return
	}

	if !fs.ValidPath(name) {
		http.NotFound(w, r)
		return
	}
	data, err := fs.ReadFile(h.assets, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	contentType := mime.TypeByExtension(ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(data)
	}
}

func ext(name string) string {
	if dot := strings.LastIndexByte(name, '.'); dot >= 0 {
		return name[dot:]
	}
	return ""
}

// NewDevProxy creates a reverse proxy for a loopback-only Vite development
// server. The browser continues to talk only to CLIHarbor's authenticated
// origin, so the production Host/session boundary is not weakened for dev.
func NewDevProxy(rawURL string) (http.Handler, error) {
	target, err := validateDevURL(rawURL)
	if err != nil {
		return nil, err
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = target.Host
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "frontend development server unavailable", http.StatusBadGateway)
	}
	return proxy, nil
}

func validateDevURL(rawURL string) (*url.URL, error) {
	target, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse frontend development URL: %w", err)
	}
	if target.Scheme != "http" || target.Hostname() != "127.0.0.1" || target.User != nil || target.Fragment != "" || target.RawQuery != "" {
		return nil, fmt.Errorf("frontend development URL must be an http://127.0.0.1:<port> origin")
	}
	if target.Path != "" && target.Path != "/" {
		return nil, fmt.Errorf("frontend development URL must not contain a path")
	}
	port, err := strconv.Atoi(target.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("frontend development URL must contain a valid port")
	}
	target.Path = ""
	return target, nil
}
