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
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/diagnostics"
	"github.com/Quazmoz/CLIHarbor/internal/platform/browser"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

func TestRunHTTPAPIExecutesTypedFixtureThroughAuthenticatedBoundary(t *testing.T) {
	fixture := executionFixtureConfigForTest(t)
	fixture.options.AuditPath = filepath.Join(t.TempDir(), "audit", "audit.jsonl")
	alternatePackPath, alternateRef := alternateExecutionFixturePackForTest(t, fixture.executable)
	fixture.options.PackFiles = append(fixture.options.PackFiles, alternatePackPath)
	fixture.options.ToolOverrides[alternateRef] = fixture.executable
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
	case err := <-done:
		t.Fatalf("application startup: %v", err)
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
	transport := http.DefaultTransport.(*http.Transport).Clone()
	client := &http.Client{Jar: jar, Transport: transport}
	t.Cleanup(transport.CloseIdleConnections)
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

	toolResponse, err := client.Get(baseURL + "/api/v1/tools")
	if err != nil {
		t.Fatal(err)
	}
	toolBody, err := io.ReadAll(toolResponse.Body)
	toolResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if toolResponse.StatusCode != http.StatusOK {
		t.Fatalf("tool diagnostics HTTP = %d", toolResponse.StatusCode)
	}
	if bytes.Contains(toolBody, []byte(fixture.executable)) || bytes.Contains(bytes.ToLower(toolBody), []byte("executable")) || bytes.Contains(bytes.ToLower(toolBody), []byte("candidate")) {
		t.Fatalf("tool diagnostics leaked executable authority: %s", toolBody)
	}
	var toolPayload struct {
		Tools []struct {
			PackID  string `json:"packId"`
			ToolID  string `json:"toolId"`
			Status  string `json:"status"`
			Version string `json:"version"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(toolBody, &toolPayload); err != nil {
		t.Fatal(err)
	}
	seenTools := make(map[string]string, len(toolPayload.Tools))
	for _, tool := range toolPayload.Tools {
		seenTools[tool.PackID+"/"+tool.ToolID] = tool.Status + "@" + tool.Version
	}
	if got := seenTools["integration/fixture"]; got != "ready@1.2.3" {
		t.Fatalf("primary tool diagnostic = %q, want ready@1.2.3", got)
	}
	if got := seenTools["integration-alt/alternate"]; got != "ready@3.4.5" {
		t.Fatalf("alternate tool diagnostic = %q, want ready@3.4.5", got)
	}
	diagnosticResponse, err := client.Get(baseURL + "/api/v1/diagnostics")
	if err != nil {
		t.Fatal(err)
	}
	diagnosticBody, err := io.ReadAll(diagnosticResponse.Body)
	diagnosticResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var report diagnostics.Bundle
	if diagnosticResponse.StatusCode != http.StatusOK || json.Unmarshal(diagnosticBody, &report) != nil || diagnostics.Validate(report) != nil ||
		report.CLIHarbor.Version != fixture.options.Version || report.Health.ToolsReady != 2 {
		t.Fatalf("invalid running-app diagnostics: %d %s", diagnosticResponse.StatusCode, diagnosticBody)
	}
	for _, forbidden := range []string{fixture.executable, status.CSRFToken, parsedBootstrap.Query().Get("token"), `"argv":`, `"stdout":`, `"stderr":`, `"message":`, `"path":`} {
		if forbidden != "" && bytes.Contains(diagnosticBody, []byte(forbidden)) {
			t.Fatalf("support report leaked forbidden runtime evidence %q", forbidden)
		}
	}

	taskResponse, err := client.Get(baseURL + "/api/v1/tasks")
	if err != nil {
		t.Fatal(err)
	}
	var taskPayload struct {
		Tasks []struct {
			PackID      string `json:"packId"`
			CommandID   string `json:"commandId"`
			ToolID      string `json:"toolId"`
			ToolVersion string `json:"toolVersion"`
		} `json:"tasks"`
	}
	if err := json.NewDecoder(taskResponse.Body).Decode(&taskPayload); err != nil {
		taskResponse.Body.Close()
		t.Fatal(err)
	}
	taskResponse.Body.Close()
	if taskResponse.StatusCode != http.StatusOK {
		t.Fatalf("task catalog HTTP = %d", taskResponse.StatusCode)
	}
	seenTasks := make(map[string]string, len(taskPayload.Tasks))
	for _, task := range taskPayload.Tasks {
		seenTasks[task.PackID+"/"+task.CommandID] = task.ToolID + "@" + task.ToolVersion
	}
	if got := seenTasks["integration/inspect"]; got != "fixture@1.2.3" {
		t.Fatalf("primary task metadata = %q, want fixture@1.2.3", got)
	}
	if got := seenTasks["integration-alt/summarize"]; got != "alternate@3.4.5" {
		t.Fatalf("alternate task metadata = %q, want alternate@3.4.5", got)
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

	postJSON := func(path string, payload map[string]any) (int, []byte) {
		t.Helper()
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequest(http.MethodPost, baseURL+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", baseURL)
		request.Header.Set("X-CLIHarbor-CSRF", status.CSRFToken)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, raw
	}

	// The preview shows exactly the argv that ran, without executable path authority.
	validValues := map[string]any{"query": query, "limit": 0, "verbose": true, "mode": "safe"}
	code, raw := postJSON("/api/v1/runs/preview", map[string]any{"packId": "integration", "commandId": "inspect", "values": validValues})
	var preview runs.Preview
	if err := json.Unmarshal(raw, &preview); err != nil || code != http.StatusOK {
		t.Fatalf("preview = HTTP %d %s (%v)", code, raw, err)
	}
	// The fixture is this test binary, so the pack declares its helper-process literals first.
	want := []string{"-test.run=^TestExecutionFixtureProcess$", "--", "--cliharbor-phase4b-fixture", "inspect", "--query", query, "--limit", "0", "--verbose", "--safe-mode"}
	if !reflect.DeepEqual(preview.Args, want) {
		t.Fatalf("preview args = %q, want the executed argv %q", preview.Args, want)
	}
	if bytes.Contains(raw, []byte(fixture.executable)) {
		t.Fatalf("preview leaked executable path: %s", raw)
	}

	// Undeclared commands, inputs, flag-shaped values and off-enum choices are
	// refused at the API boundary and never become runs.
	withValue := func(key string, value any) map[string]any {
		values := map[string]any{"query": "ok", "mode": "safe"}
		values[key] = value
		return values
	}
	for _, rejected := range []struct {
		name    string
		command string
		values  map[string]any
		field   string
	}{
		{"undeclared command", "rm", map[string]any{}, "commandId"},
		{"undeclared input", "inspect", withValue("exec", "rm -rf /"), "values.exec"},
		{"flag-shaped value", "inspect", withValue("query", "--output=/etc/passwd"), "values.query"},
		{"off-enum choice", "inspect", withValue("mode", "--detailed-mode --other"), "values.mode"},
	} {
		for _, path := range []string{"/api/v1/runs/preview", "/api/v1/runs"} {
			code, raw := postJSON(path, map[string]any{"packId": "integration", "commandId": rejected.command, "values": rejected.values})
			if code != http.StatusBadRequest || !bytes.Contains(raw, []byte(`"field":"`+rejected.field+`"`)) {
				t.Fatalf("%s via %s = HTTP %d %s, want 400 on %s", rejected.name, path, code, raw, rejected.field)
			}
		}
	}
	listResponse, err := client.Get(baseURL + "/api/v1/runs")
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Runs []struct {
			RunID string `json:"runId"`
		} `json:"runs"`
	}
	err = json.NewDecoder(listResponse.Body).Decode(&listed)
	listResponse.Body.Close()
	if err != nil || len(listed.Runs) != 1 || listed.Runs[0].RunID != created.RunID {
		t.Fatalf("retained runs = %+v (%v), want only the accepted run", listed.Runs, err)
	}

	transport.CloseIdleConnections()
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
