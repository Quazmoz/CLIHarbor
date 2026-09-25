package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

type previewServiceStub struct {
	request runs.Request
	preview runs.Preview
	err     error
}

func (s *previewServiceStub) Start(runs.Request) (runs.Snapshot, error) { return runs.Snapshot{}, nil }
func (s *previewServiceStub) Get(string) (runs.Snapshot, bool)        { return runs.Snapshot{}, false }
func (s *previewServiceStub) Cancel(string) error                     { return nil }
func (s *previewServiceStub) Preview(request runs.Request) (runs.Preview, error) {
	s.request = request
	return s.preview, s.err
}

func TestHandleRunPreviewReturnsPlannerRepresentationWithoutPathAuthority(t *testing.T) {
	stub := &previewServiceStub{preview: runs.Preview{
		PackID: "fixture", CommandID: "inspect", ToolID: "fixture", ToolVersion: "1.2.3",
		ExecutableName: "fixture.exe", Args: []string{"inspect", "--query", "hello world"},
	}}
	server := &Server{runs: stub}
	body := []byte(`{"packId":"fixture","commandId":"inspect","values":{"query":"hello world"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/runs/preview", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.handleRunPreview(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if stub.request.PackID != "fixture" || stub.request.CommandID != "inspect" {
		t.Fatalf("request = %#v", stub.request)
	}
	if _, ok := stub.request.Values["query"]; !ok {
		t.Fatalf("request values = %#v", stub.request.Values)
	}
	if strings.Contains(recorder.Body.String(), "ExecutablePath") || strings.Contains(recorder.Body.String(), "executablePath") {
		t.Fatalf("preview leaked path authority: %s", recorder.Body.String())
	}
	var got runs.Preview
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.ExecutableName != "fixture.exe" || len(got.Args) != 3 {
		t.Fatalf("preview response = %#v", got)
	}
}

func TestHandleRunPreviewRejectsUnknownRequestAuthority(t *testing.T) {
	stub := &previewServiceStub{}
	server := &Server{runs: stub}
	body := []byte(`{"packId":"fixture","commandId":"inspect","values":{},"executablePath":"C:\\bad.exe"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/runs/preview", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.handleRunPreview(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}
