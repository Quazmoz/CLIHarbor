package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type fakeToolInstallService struct {
	request ToolInstallRequest
	result  ToolInstallResult
	err     error
}

func (f *fakeToolInstallService) InstallTool(_ context.Context, request ToolInstallRequest) (ToolInstallResult, error) {
	f.request = request
	return f.result, f.err
}

func TestToolInstallAPIRequiresSessionCSRFAndAcceptsOnlyToolIdentity(t *testing.T) {
	service := &fakeToolInstallService{result: ToolInstallResult{
		Installed: true, Version: "1.2.3", RestartRequired: true,
		Message: "Verified CLI installed for the current user. Restart CLIHarbor to activate it.",
	}}
	s := newTestServer(t, Config{ToolInstaller: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	status := fetchStatus(t, client, s)

	request, err := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/tools/install", strings.NewReader(`{"packId":"fixture","toolId":"fixture","installRoot":"C:\\Users\\alice\\Tools"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", s.BaseURL())
	request.Header.Set(csrfHeaderName, status.CSRFToken)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.StatusCode, body)
	}
	if service.request.PackID != "fixture" || service.request.ToolID != "fixture" || service.request.InstallRoot != `C:\Users\alice\Tools` {
		t.Fatalf("request = %#v", service.request)
	}
	if strings.Contains(strings.ToLower(string(body)), "path") || strings.Contains(strings.ToLower(string(body)), "url") || strings.Contains(strings.ToLower(string(body)), "sha256") {
		t.Fatalf("install response leaked backend authority: %s", body)
	}
}

func TestToolInstallAPIRejectsUnknownAuthorityFields(t *testing.T) {
	service := &fakeToolInstallService{}
	s := newTestServer(t, Config{ToolInstaller: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	status := fetchStatus(t, client, s)

	request, err := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/tools/install", strings.NewReader(`{"packId":"fixture","toolId":"fixture","url":"https://evil.invalid/tool.exe"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", s.BaseURL())
	request.Header.Set(csrfHeaderName, status.CSRFToken)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusBadRequest)
	}
	if service.request.PackID != "" {
		t.Fatalf("service unexpectedly invoked: %#v", service.request)
	}
}

func TestToolInstallAPIRejectsControlCharactersInInstallRoot(t *testing.T) {
	service := &fakeToolInstallService{}
	s := newTestServer(t, Config{ToolInstaller: service})
	client := sessionClient(t)
	bootstrap(t, client, s)
	status := fetchStatus(t, client, s)

	request, err := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/tools/install", strings.NewReader("{\"packId\":\"fixture\",\"toolId\":\"fixture\",\"installRoot\":\"bad\\npath\"}"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", s.BaseURL())
	request.Header.Set(csrfHeaderName, status.CSRFToken)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusBadRequest)
	}
}
