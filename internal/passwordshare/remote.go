package passwordshare

import (
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// The LAN listener serves only these static files and a one-use POST. It never
// mounts the application router, sessions, CLI APIs or a filesystem handler.
//
//go:embed sender.html sender.js sender.css
var senderFiles embed.FS

func (s *Service) remote(id, origin, mode string, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
	w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	u, _ := url.Parse(origin)
	if err != nil || !s.permittedIP(host) || r.TLS == nil || r.Host != u.Host || r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.RawPath != "" {
		http.Error(w, "Request refused.", http.StatusForbidden)
		return
	}
	if r.Header.Get("Origin") != "" && (len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != origin) {
		http.Error(w, "Request refused.", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodGet && mode == "browser" {
		name, contentType := "", ""
		switch r.URL.Path {
		case "/":
			name, contentType = "sender.html", "text/html; charset=utf-8"
		case "/sender.js":
			name, contentType = "sender.js", "text/javascript; charset=utf-8"
		case "/sender.css":
			name, contentType = "sender.css", "text/css; charset=utf-8"
		}
		if name != "" {
			data, err := senderFiles.ReadFile(name)
			if err != nil {
				http.Error(w, "Unavailable.", 503)
				return
			}
			w.Header().Set("Content-Type", contentType)
			_, _ = w.Write(data)
			return
		}
	}
	if r.URL.Path != "/deliver" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "POST required.", 405)
		return
	}
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "text/plain" || len(params) > 1 || (params["charset"] != "" && !strings.EqualFold(params["charset"], "utf-8")) {
		http.Error(w, "Invalid password format.", 400)
		return
	}
	authorization := r.Header.Values("Authorization")
	if len(authorization) != 1 || !strings.HasPrefix(authorization[0], "Bearer ") || len(authorization[0]) != len("Bearer ")+43 {
		http.Error(w, "Invitation unavailable.", 403)
		return
	}
	hash := sha256.Sum256([]byte(strings.TrimPrefix(authorization[0], "Bearer ")))
	// Check the invitation before reading a potentially slow request body, then
	// check it again under the same lock as consumption after the bounded read.
	s.mu.Lock()
	s.expireLocked()
	valid := !s.closed && s.id == id && s.state == "waiting" && subtle.ConstantTimeCompare(hash[:], s.tokenHash[:]) == 1
	s.mu.Unlock()
	if !valid {
		http.Error(w, "Invitation unavailable.", 403)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxPasswordBytes))
	defer clear(data)
	if err != nil || !validPassword(data) {
		http.Error(w, "Use a single-line password of 1 to 4096 UTF-8 bytes.", 400)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	if s.closed || s.id != id || s.state != "waiting" || subtle.ConstantTimeCompare(hash[:], s.tokenHash[:]) != 1 {
		http.Error(w, "Invitation unavailable.", 403)
		return
	}
	s.password = append([]byte(nil), data...)
	s.state = "received"
	s.tokenHash = [32]byte{}
	// Stop accepting LAN connections now; this response still completes.
	_ = s.listener.Close()
	w.WriteHeader(http.StatusNoContent)
}
