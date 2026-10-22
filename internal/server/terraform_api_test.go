package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeTerraformInventory struct{}

func (fakeTerraformInventory) FormatCheck(_ context.Context, projectID string) (TerraformFormatReport, error) {
	return TerraformFormatReport{ProjectID: projectID, CheckedAt: "2026-10-22T00:00:00Z", Files: []TerraformFormatFile{{Name: "main.tf", Status: "formatted"}}}, nil
}

func (fakeTerraformInventory) Projects() ([]TerraformProject, error) {
	return []TerraformProject{{ID: "project-1", Name: "demo", States: []TerraformState{{ID: "state-a", Name: "terraform.tfstate"}}}}, nil
}
func (fakeTerraformInventory) Resources(project, state string) ([]TerraformResource, error) {
	return []TerraformResource{{Address: "aws_instance.example", Type: "aws_instance", Category: "managed"}}, nil
}
func TestTerraformAPIRefusesBrowserPathsAndDuplicateParameters(t *testing.T) {
	s := &Server{terraform: fakeTerraformInventory{}}
	for _, path := range []string{
		"/api/v1/terraform/resources?project=..%2Fetc&state=state-a",
		"/api/v1/terraform/resources?project=project-1&state=..%2Fstate",
		"/api/v1/terraform/resources?project=project-1&state=state-a&state=state-b",
		"/api/v1/terraform/resources?project=project-1&state=state-a&path=secret",
	} {
		w := httptest.NewRecorder()
		s.handleTerraformResources(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s returned %d", path, w.Code)
		}
	}
}
func TestTerraformAPIReadOnlyResponses(t *testing.T) {
	s := &Server{terraform: fakeTerraformInventory{}}
	for _, path := range []string{"/api/v1/terraform/projects", "/api/v1/terraform/resources?project=project-1&state=state-a"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		if path == "/api/v1/terraform/projects" {
			s.handleTerraformProjects(w, r)
		} else {
			s.handleTerraformResources(w, r)
		}
		if w.Code != http.StatusOK || w.Body.Len() == 0 {
			t.Fatalf("bad response for %s: %d", path, w.Code)
		}
	}
	w := httptest.NewRecorder()
	s.handleTerraformResources(w, httptest.NewRequest(http.MethodPost, "/api/v1/terraform/resources", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatal("mutation method was accepted")
	}
}

func TestTerraformFormatAPIRefusesPathsAndMethods(t *testing.T) {
	s := &Server{terraform: fakeTerraformInventory{}}
	for _, path := range []string{
		"/api/v1/terraform/format-check?project=../../tmp",
		"/api/v1/terraform/format-check?project=project-1&path=outside",
		"/api/v1/terraform/format-check?project=project-1&project=project-2",
	} {
		w := httptest.NewRecorder()
		s.handleTerraformFormatCheck(w, httptest.NewRequest(http.MethodPost, path, nil))
		if w.Code != http.StatusBadRequest { t.Fatalf("%s => %d", path, w.Code) }
	}
	w := httptest.NewRecorder()
	s.handleTerraformFormatCheck(w, httptest.NewRequest(http.MethodGet, "/api/v1/terraform/format-check?project=project-1", nil))
	if w.Code != http.StatusMethodNotAllowed { t.Fatalf("GET format check => %d", w.Code) }
	w = httptest.NewRecorder()
	s.handleTerraformFormatCheck(w, httptest.NewRequest(http.MethodPost, "/api/v1/terraform/format-check?project=project-1", nil))
	if w.Code != http.StatusOK { t.Fatalf("approved format check => %d", w.Code) }
}
