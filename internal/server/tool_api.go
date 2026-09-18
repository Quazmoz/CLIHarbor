package server

import "net/http"

type ToolDiagnostic struct {
	PackID            string `json:"packId"`
	PackName          string `json:"packName"`
	PackVersion       string `json:"packVersion"`
	ToolID            string `json:"toolId"`
	Status            string `json:"status"`
	Version           string `json:"version,omitempty"`
	VersionConstraint string `json:"versionConstraint,omitempty"`
	Message           string `json:"message,omitempty"`
}

type ToolService interface {
	ListTools() []ToolDiagnostic
}

func (s *Server) handleTools(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	tools := s.tools.ListTools()
	if tools == nil {
		tools = []ToolDiagnostic{}
	}
	writeJSON(w, http.StatusOK, struct {
		Tools []ToolDiagnostic `json:"tools"`
	}{Tools: tools})
}
