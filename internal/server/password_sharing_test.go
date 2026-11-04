package server

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/passwordshare"
)

func TestPasswordSharingLocalBoundaryAndStrictRequests(t *testing.T) {
	sharing, err := passwordshare.New("", "")
	if err != nil {
		t.Fatal(err)
	}
	defer sharing.Close()
	s := newTestServer(t, Config{PasswordSharing: sharing})
	client := sessionClient(t)
	response, err := client.Get(s.BaseURL() + "/api/v1/password-sharing")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("unauthenticated status accepted")
	}
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken
	for _, test := range []struct {
		name, path, body, origin, token string
		want                            int
	}{
		{"missing CSRF", "/create", `{"address":"192.168.1.1","mode":"app"}`, s.BaseURL(), "", 403},
		{"foreign origin", "/reveal", `{"id":"aaaaaaaaaaaaaaaaaaaaaa"}`, "https://attacker.invalid", csrf, 403},
		{"missing origin", "/cancel", `{"id":"aaaaaaaaaaaaaaaaaaaaaa"}`, "", csrf, 403},
		{"wildcard bind", "/create", `{"address":"0.0.0.0","mode":"app"}`, s.BaseURL(), csrf, 400},
		{"loopback bind", "/create", `{"address":"127.0.0.1","mode":"app"}`, s.BaseURL(), csrf, 400},
		{"unknown mode", "/create", `{"address":"192.168.1.1","mode":"shell"}`, s.BaseURL(), csrf, 400},
		{"duplicate fields", "/create", `{"address":"192.168.1.1","address":"192.168.1.2","mode":"app"}`, s.BaseURL(), csrf, 400},
		{"unknown field", "/create", `{"address":"192.168.1.1","mode":"app","argv":["shell"]}`, s.BaseURL(), csrf, 400},
		{"query credentials", "/reveal?token=private-marker", `{"id":"aaaaaaaaaaaaaaaaaaaaaa"}`, s.BaseURL(), csrf, 400},
		{"reveal requires ID", "/reveal", `{}`, s.BaseURL(), csrf, 400},
		{"stale reveal", "/reveal", `{"id":"aaaaaaaaaaaaaaaaaaaaaa"}`, s.BaseURL(), csrf, 410},
		{"stale cancellation", "/cancel", `{"id":"aaaaaaaaaaaaaaaaaaaaaa"}`, s.BaseURL(), csrf, 410},
		{"send requires consent", "/send", `{"invitation":"private-marker","password":"private-value"}`, s.BaseURL(), csrf, 400},
		{"public target", "/send", `{"invitation":"https://8.8.8.8:443/","password":"private-value","confirmed":true}`, s.BaseURL(), csrf, 400},
		{"unknown route", "/other", `{}`, s.BaseURL(), csrf, 404},
		{"oversize", "/send", `{"password":"` + strings.Repeat("x", 70<<10) + `"}`, s.BaseURL(), csrf, 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			request, _ := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/password-sharing"+test.path, strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", test.origin)
			request.Header.Set(csrfHeaderName, test.token)
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != test.want {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.want)
			}
			if strings.Contains(string(body), "private-marker") || strings.Contains(string(body), "private-value") {
				t.Fatal("sharing error echoed input")
			}
			if response.Header.Get("Cache-Control") != "no-store" {
				t.Fatal("sharing response can be cached")
			}
		})
	}
	response, err = client.Get(s.BaseURL() + "/api/v1/password-sharing")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || strings.Contains(string(body), "invitation") || strings.Contains(string(body), "password") {
		t.Fatal("unsafe sharing status")
	}
}
