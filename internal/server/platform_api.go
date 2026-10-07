package server

import "net/http"

// PlatformFeature is one dedicated, platform-specific capability the browser
// can surface (for example "security-audit"). IDs are a closed set the
// frontend maps to its own routes; the backend never sends URLs.
type PlatformFeature struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Platform describes a dedicated CLI integration: behavior built and tested
// for one vendor CLI on top of the generic pack engine.
type Platform struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Summary  string            `json:"summary"`
	PackID   string            `json:"packId"`
	ToolID   string            `json:"toolId"`
	Ready    bool              `json:"ready"`
	Features []PlatformFeature `json:"features"`
}

type PlatformService interface {
	ListPlatforms() []Platform
}

func (s *Server) handlePlatforms(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(w)
		return
	}
	platforms := s.platforms.ListPlatforms()
	if platforms == nil {
		platforms = []Platform{}
	}
	writeJSON(w, http.StatusOK, struct {
		Platforms []Platform `json:"platforms"`
	}{Platforms: platforms})
}
