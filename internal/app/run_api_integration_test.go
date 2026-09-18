package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/platform/browser"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

func TestRunHTTPAPIExecutesTypedFixtureThroughAuthenticatedBoundary(t *testing.T) {
	fixture := executionFixtureConfigForTest(t)
	launched := make(chan string, 1)
	fixture.options.Out = io.Discard
	fixture.options.Version = "phase4c-test"
	fixture.options.Browser = browser.LauncherFunc(func(rawURL string) error {
		launched <- rawURL
		return nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, fixture.options)
	}()

	var bootstrapURL string
	select {
	case bootstrapURL = <-launched:
	case <-time.After(5 * time.Second):
		t.Fatal("application did not publish bootstrap URL")
	}
	parsedBootstrap, err := url.Parse(bootstrapURL)
	if err != nil {
		t.Fatal(err)
	}
	baseURL := parsedBootstrap.Scheme + "://" + parsedBootstrap.Host

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	bootstrapResponse, err := client.Get(bootstrapURL)
	if err != nil {
		t.Fatal(err)
	}
	bootstrapResponse.Body.Close()
	if bootstrapResponse.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap status = %d, want %d", bootstrapResponse.StatusCode, http.StatusOK)
	}

	statusResponse, err := client.Get(baseURL + "/api/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		Name      string `json:"name"`
		Version   string `json:"version"`
		Session   string `json:"session"`
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.NewDecoder(statusResponse.Body).Decode(&status); err != nil {
		statusResponse.Body.Close()
		t.Fatal(err)
	}
	statusResponse.Body.Close()
	if statusResponse.StatusCode != http.StatusOK || status.Session != "active" || status.CSRFToken == "" {
		t.Fatalf("status response = HTTP %d %+v", statusResponse.StatusCode, status)
	}

	query := "api snow 雪 & | ;"
	requestBody, err := json.Marshal(map[string]any{
		"packId":    "integration",
		"commandId": "inspect",
		"values": map[string]any{
			"query":   query,
			"limit":   0,
			"verbose": true,
			"mode":    "safe",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	createRequest, err := http.NewRequest(http.MethodPost, baseURL+"/api/v1/runs", bytes.NewReader(requestBody))
	if err != nil {
		t.Fatal(err)
	}
	createRequest.Header.Set("Content-Type", "application/json")
	createRequest.Header.Set("Origin", baseURL)
	createRequest.Header.Set("X-CLIHarbor-CSRF", status.CSRFToken)
	createResponse, err := client.Do(createRequest)
	if err != nil {
		t.Fatal(err)
	}
	var created runs.Snapshot
	if err := json.NewDecoder(createResponse.Body).Decode(&created); err != nil {
		createResponse.Body.Close()
		t.Fatal(err)
	}
	createResponse.Body.Close()
	if createResponse.StatusCode != http.StatusAccepted || created.RunID == "" || created.PackID != "integration" || created.CommandID != "inspect" {
		t.Fatalf("create response = HTTP %d %#v", createResponse.StatusCode, created)
	}

	streamRequest, err := http.NewRequestWithContext(t.Context(), http.MethodGet, baseURL+"/api/v1/runs/"+created.RunID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	streamResponse, err := client.Do(streamRequest)
	if err != nil {
		t.Fatal(err)
	}
	streamBody, err := io.ReadAll(streamResponse.Body)
	streamResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if streamResponse.StatusCode != http.StatusOK {
		t.Fatalf("run stream HTTP = %d", streamResponse.StatusCode)
	}
	if !bytes.Contains(streamBody, []byte("event: run-event\n")) || !bytes.Contains(streamBody, []byte("event: run-complete\n")) {
		t.Fatalf("run stream missing event/completion frames: %q", streamBody)
	}
	if bytes.Contains(streamBody, []byte(fixture.executable)) || bytes.Contains(streamBody, []byte("-test.run")) {
		t.Fatalf("run stream leaked executable or argv authority: %q", streamBody)
	}

	runResponse, err := client.Get(baseURL + "/api/v1/runs/" + created.RunID)
	if err != nil {
		t.Fatal(err)
	}
	var finished runs.Snapshot
	if err := json.NewDecoder(runResponse.Body).Decode(&finished); err != nil {
		runResponse.Body.Close()
		t.Fatal(err)
	}
	runResponse.Body.Close()
	if runResponse.StatusCode != http.StatusOK {
		t.Fatalf("run status HTTP = %d", runResponse.StatusCode)
	}

	if finished.Status != runs.StatusExited || finished.ExitCode == nil || *finished.ExitCode != 0 {
		t.Fatalf("finished run = %#v", finished)
	}
	stdout := decodeRunSnapshotOutput(t, finished, "stdout.chunk")
	wantStdout := "inspect:--query\x1f" + query + "\x1f--limit\x1f0\x1f--verbose\x1f--safe-mode"
	if string(stdout) != wantStdout {
		t.Fatalf("stdout = %q, want %q", stdout, wantStdout)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() shutdown error = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("application did not shut down with run manager")
	}
}

func decodeRunSnapshotOutput(t *testing.T, snapshot runs.Snapshot, eventType string) []byte {
	t.Helper()
	var output []byte
	for _, event := range snapshot.Events {
		if event.Type != eventType || event.DataBase64 == "" {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(event.DataBase64)
		if err != nil {
			t.Fatal(err)
		}
		output = append(output, data...)
	}
	return output
}
