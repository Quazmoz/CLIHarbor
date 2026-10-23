package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeTerraformRemoval struct {
	fakeTerraformInventory
	previewErr  error
	executeErr  error
	previews    []TerraformStateRemovalPreviewRequest
	executes    []TerraformStateRemovalExecuteRequest
	executeCtx  context.Context
	executeResp TerraformStateRemovalResult
}

func (f *fakeTerraformRemoval) PreviewStateRemoval(_ context.Context, request TerraformStateRemovalPreviewRequest) (TerraformStateRemovalPreview, error) {
	f.previews = append(f.previews, request)
	if f.previewErr != nil {
		return TerraformStateRemovalPreview{}, f.previewErr
	}
	return TerraformStateRemovalPreview{PreviewID: strings.Repeat("a", 43), ProjectID: request.ProjectID, StateID: request.StateID,
		StateName: "terraform.tfstate", Addresses: request.Addresses, Serial: 7, TerraformVersion: "1.9.8", ExpiresAt: "2026-10-23T12:05:00Z"}, nil
}

func (f *fakeTerraformRemoval) ExecuteStateRemoval(ctx context.Context, request TerraformStateRemovalExecuteRequest) (TerraformStateRemovalResult, error) {
	f.executes = append(f.executes, request)
	f.executeCtx = ctx
	return f.executeResp, f.executeErr
}

func removalRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestTerraformRemovalPreviewValidatesStrictly(t *testing.T) {
	fake := &fakeTerraformRemoval{}
	s := &Server{terraform: fake}
	for name, body := range map[string]string{
		"path project":    `{"project":"../etc","state":"state-a","addresses":["a.b"]}`,
		"flag address":    `{"project":"project-1","state":"state-a","addresses":["-lock=false"]}`,
		"control char":    `{"project":"project-1","state":"state-a","addresses":["a.b\n"]}`,
		"duplicate":       `{"project":"project-1","state":"state-a","addresses":["a.b","a.b"]}`,
		"empty":           `{"project":"project-1","state":"state-a","addresses":[]}`,
		"unknown field":   `{"project":"project-1","state":"state-a","addresses":["a.b"],"backup":"/tmp/x"}`,
		"duplicate key":   `{"project":"project-1","project":"project-2","state":"state-a","addresses":["a.b"]}`,
		"trailing data":   `{"project":"project-1","state":"state-a","addresses":["a.b"]} {}`,
		"too many":        `{"project":"project-1","state":"state-a","addresses":[` + strings.TrimSuffix(strings.Repeat(`"a.b",`, 51), ",") + `]}`,
		"bidi line break": `{"project":"project-1","state":"state-a","addresses":["a.b\u2028"]}`,
	} {
		w := httptest.NewRecorder()
		s.handleTerraformStateRemovalPreview(w, removalRequest(http.MethodPost, "/api/v1/terraform/state-removal/preview", body))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s => %d", name, w.Code)
		}
	}
	if len(fake.previews) != 0 {
		t.Fatalf("invalid requests reached the service: %#v", fake.previews)
	}
	w := httptest.NewRecorder()
	r := removalRequest(http.MethodPost, "/api/v1/terraform/state-removal/preview?project=project-1", `{"project":"project-1","state":"state-a","addresses":["a.b"]}`)
	s.handleTerraformStateRemovalPreview(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("query string accepted => %d", w.Code)
	}
	w = httptest.NewRecorder()
	s.handleTerraformStateRemovalPreview(w, httptest.NewRequest(http.MethodGet, "/api/v1/terraform/state-removal/preview", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET => %d", w.Code)
	}
}

func TestTerraformRemovalPreviewAndExecuteHappyPath(t *testing.T) {
	fake := &fakeTerraformRemoval{executeResp: TerraformStateRemovalResult{Outcome: "removed", Removed: []string{`a.b["x"]`}, Backup: "terraform.tfstate.cliharbor-x.backup"}}
	s := &Server{terraform: fake}
	w := httptest.NewRecorder()
	s.handleTerraformStateRemovalPreview(w, removalRequest(http.MethodPost, "/api/v1/terraform/state-removal/preview",
		`{"project":"project-1","state":"state-a","addresses":["a.b[\"x\"]"]}`))
	if w.Code != http.StatusOK {
		t.Fatalf("preview => %d %s", w.Code, w.Body.String())
	}
	var preview TerraformStateRemovalPreview
	if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil || preview.PreviewID == "" {
		t.Fatalf("preview body %q", w.Body.String())
	}
	w = httptest.NewRecorder()
	parent, cancel := context.WithCancel(context.Background())
	r := removalRequest(http.MethodPost, "/api/v1/terraform/state-removal/execute",
		`{"previewId":"`+preview.PreviewID+`","confirm":"terraform.tfstate"}`).WithContext(parent)
	cancel() // a disconnected browser must not abort the mutation mid-way
	s.handleTerraformStateRemovalExecute(w, r)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"outcome":"removed"`) {
		t.Fatalf("execute => %d %s", w.Code, w.Body.String())
	}
	if fake.executeCtx.Err() != nil {
		t.Fatal("execute context inherited the request cancellation")
	}
}

func TestTerraformRemovalExecuteValidatesPreviewIDAndConfirmation(t *testing.T) {
	fake := &fakeTerraformRemoval{}
	s := &Server{terraform: fake}
	for _, body := range []string{
		`{"previewId":"short","confirm":"terraform.tfstate"}`,
		`{"previewId":"` + strings.Repeat("a", 43) + `","confirm":""}`,
		`{"previewId":"` + strings.Repeat("a", 43) + `","confirm":"x\u0000"}`,
		`{"previewId":"` + strings.Repeat("a", 43) + `"}`,
		`{"previewId":"` + strings.Repeat("/", 43) + `","confirm":"terraform.tfstate"}`,
	} {
		w := httptest.NewRecorder()
		s.handleTerraformStateRemovalExecute(w, removalRequest(http.MethodPost, "/api/v1/terraform/state-removal/execute", body))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s => %d", body, w.Code)
		}
	}
	if len(fake.executes) != 0 {
		t.Fatal("invalid execute reached the service")
	}
}

func TestTerraformRemovalErrorsAreSanitizedAndClassified(t *testing.T) {
	cases := map[TerraformStateRemovalErrorCode]struct {
		status int
		code   string
	}{
		TerraformRemovalInvalid:     {http.StatusUnprocessableEntity, "invalid_input"},
		TerraformRemovalStale:       {http.StatusConflict, "approval_required"},
		TerraformRemovalBusy:        {http.StatusConflict, "run_capacity"},
		TerraformRemovalUnavailable: {http.StatusServiceUnavailable, "tool_unavailable"},
		TerraformRemovalToolChanged: {http.StatusConflict, "tool_changed"},
		TerraformRemovalRejected:    {http.StatusConflict, "execution_failed"},
		TerraformRemovalAudit:       {http.StatusServiceUnavailable, "audit_unavailable"},
	}
	for code, want := range cases {
		fake := &fakeTerraformRemoval{executeErr: &TerraformStateRemovalError{Code: code}}
		s := &Server{terraform: fake}
		w := httptest.NewRecorder()
		s.handleTerraformStateRemovalExecute(w, removalRequest(http.MethodPost, "/api/v1/terraform/state-removal/execute",
			`{"previewId":"`+strings.Repeat("a", 43)+`","confirm":"terraform.tfstate"}`))
		if w.Code != want.status || !strings.Contains(w.Body.String(), `"code":"`+want.code+`"`) {
			t.Fatalf("%s => %d %s", code, w.Code, w.Body.String())
		}
	}
	fake := &fakeTerraformRemoval{previewErr: &pathLeakError{}}
	s := &Server{terraform: fake}
	w := httptest.NewRecorder()
	s.handleTerraformStateRemovalPreview(w, removalRequest(http.MethodPost, "/api/v1/terraform/state-removal/preview",
		`{"project":"project-1","state":"state-a","addresses":["a.b"]}`))
	if w.Code != http.StatusConflict || strings.Contains(w.Body.String(), "/home/") {
		t.Fatalf("untyped error leaked: %d %s", w.Code, w.Body.String())
	}
}

type pathLeakError struct{}

func (*pathLeakError) Error() string {
	return "open /home/user/infra/terraform.tfstate: permission denied"
}

func TestTerraformRemovalRoutesOnlyExistWhenServiceSupportsIt(t *testing.T) {
	s := &Server{terraform: fakeTerraformInventory{}}
	w := httptest.NewRecorder()
	s.handleTerraformStateRemovalPreview(w, removalRequest(http.MethodPost, "/api/v1/terraform/state-removal/preview", `{}`))
	if w.Code != http.StatusNotFound {
		t.Fatalf("read-only service exposed removal => %d", w.Code)
	}
}
