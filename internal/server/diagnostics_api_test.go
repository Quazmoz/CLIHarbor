package server

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/diagnostics"
)

func diagnosticFixture() diagnostics.Bundle {
	return diagnostics.Bundle{
		SchemaVersion: diagnostics.SchemaVersion,
		CLIHarbor:     diagnostics.BuildInfo{Version: "test", Commit: "abc123", BuildMode: "test"},
		Runtime:       diagnostics.RuntimeInfo{GoVersion: "go1.27.3", OS: "windows", Architecture: "amd64"},
		Configuration: diagnostics.Configuration{PackSourceMode: "none", PackCount: 1},
		Health:        diagnostics.Health{ToolsUnavailable: 1},
		Packs:         []diagnostics.PackRecord{{ID: "fixture", Version: "1.0.0"}},
		Tools:         []diagnostics.ToolRecord{{PackID: "fixture", PackVersion: "1.0.0", ToolID: "fixture", Status: "missing"}},
	}
}

func TestDiagnosticsAPIRequiresSessionAndReturnsDeterministicAllowlistedBytes(t *testing.T) {
	bundle := diagnosticFixture()
	var calls atomic.Int32
	s := newTestServer(t, Config{Diagnostics: func() diagnostics.Bundle { calls.Add(1); return bundle }})
	unauth, err := http.Get(s.BaseURL() + "/api/v1/diagnostics")
	if err != nil {
		t.Fatal(err)
	}
	unauth.Body.Close()
	if unauth.StatusCode != http.StatusUnauthorized || calls.Load() != 0 {
		t.Fatal("unauthenticated diagnostics was not blocked")
	}
	client := sessionClient(t)
	bootstrap(t, client, s)
	expected, err := diagnostics.MarshalBundle(bundle)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		response, err := client.Get(s.BaseURL() + "/api/v1/diagnostics")
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK || !bytes.Equal(body, expected) {
			t.Fatalf("diagnostics response = %d %s", response.StatusCode, body)
		}
		if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("X-CLIHarbor-Diagnostics-SHA256") != fmt.Sprintf("%x", sha256.Sum256(body)) {
			t.Fatal("missing private-cache or exact-byte checksum contract")
		}
	}
	status := fetchStatus(t, client, s)
	for _, test := range []struct {
		method, query, origin, host string
		want                        int
	}{
		{method: "GET", origin: "https://hostile.invalid", want: http.StatusForbidden},
		{method: "GET", host: "hostile.invalid", want: http.StatusForbidden},
		{method: "POST", origin: s.BaseURL(), want: http.StatusMethodNotAllowed},
		{method: "HEAD", want: http.StatusMethodNotAllowed},
		{method: "GET", query: "?include=credentials", want: http.StatusBadRequest},
	} {
		before := calls.Load()
		request, err := http.NewRequest(test.method, s.BaseURL()+"/api/v1/diagnostics"+test.query, nil)
		if err != nil {
			t.Fatal(err)
		}
		if test.origin != "" {
			request.Header.Set("Origin", test.origin)
		}
		if test.host != "" {
			request.Host = test.host
		}
		request.Header.Set(csrfHeaderName, status.CSRFToken)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != test.want || calls.Load() != before {
			t.Fatalf("%s%s status = %d, calls = %d", test.method, test.query, response.StatusCode, calls.Load())
		}
	}
}

func TestDiagnosticsAPIRejectsInvalidOrOversizedMetadataBeforeWriting(t *testing.T) {
	for _, test := range []string{"invalid-token", "oversized"} {
		t.Run(test, func(t *testing.T) {
			bundle := diagnosticFixture()
			if test == "invalid-token" {
				bundle.CLIHarbor.Commit = "PRIVATE/path/token=value"
			} else {
				bundle.Tools = nil
				bundle.Health.ToolsUnavailable = 256
				for i := range 256 {
					bundle.Tools = append(bundle.Tools, diagnostics.ToolRecord{PackID: strings.Repeat("p", 128), PackVersion: strings.Repeat("v", 128), ToolID: fmt.Sprintf("tool-%03d", i), Status: "missing", Version: strings.Repeat("v", 128)})
				}
			}
			s := newTestServer(t, Config{Diagnostics: func() diagnostics.Bundle { return bundle }})
			client := sessionClient(t)
			bootstrap(t, client, s)
			response, err := client.Get(s.BaseURL() + "/api/v1/diagnostics")
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusInternalServerError || response.Header.Get("X-CLIHarbor-Diagnostics-SHA256") != "" ||
				bytes.Contains(body, []byte("PRIVATE")) || bytes.Contains(body, []byte("schemaVersion")) || !bytes.Contains(body, []byte("internal_error")) {
				t.Fatalf("unsafe diagnostics response: %d %s", response.StatusCode, body)
			}
		})
	}
}
