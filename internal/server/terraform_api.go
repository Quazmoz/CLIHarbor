package server

import (
	"net/http"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
	"regexp"
)

// TerraformStateService is a read-only, backend-authorized view of explicitly
// approved local projects. It never accepts browser-supplied filesystem paths.
type TerraformStateService interface {
	Projects() ([]TerraformProject, error)
	Resources(projectID, stateID string) ([]TerraformResource, error)
}

type TerraformProject struct {
	ID     string           `json:"id"`
	Name   string           `json:"name"`
	States []TerraformState `json:"states"`
}
type TerraformState struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type TerraformResource struct {
	Address  string `json:"address"`
	Type     string `json:"type"`
	Module   string `json:"module"`
	Category string `json:"category"`
}

var terraformSelector = regexp.MustCompile("^[a-z0-9-]{1,80}$")

func (s *Server) handleTerraformProjects(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(w)
		return
	}
	projects, err := s.terraform.Projects()
	if err != nil {
		writeAPIError(w, http.StatusConflict, apperror.CodeExecutionContextUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": projects})
}

func (s *Server) handleTerraformResources(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(w)
		return
	}
	project, state := r.URL.Query().Get("project"), r.URL.Query().Get("state")
	if !terraformSelector.MatchString(project) || !terraformSelector.MatchString(state) ||
		len(r.URL.Query()) != 2 || len(r.URL.Query()["project"]) != 1 || len(r.URL.Query()["state"]) != 1 {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidInput)
		return
	}
	resources, err := s.terraform.Resources(project, state)
	if err != nil {
		// Never return raw filesystem errors: paths and state may be sensitive.
		writeAPIError(w, http.StatusConflict, apperror.CodeExecutionContextUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"resources": resources})
}
