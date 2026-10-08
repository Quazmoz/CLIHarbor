package server

import (
	"github.com/Quazmoz/CLIHarbor/internal/audittrail"
	"net/http"
)

func (s *Server) handleAuditTrail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(w)
		return
	}
	if s.audit == nil {
		writeResourceNotFound(w)
		return
	}
	entries := s.audit.List()
	if entries == nil {
		entries = []audittrail.Entry{}
	}
	writeJSON(w, http.StatusOK, struct {
		Entries []audittrail.Entry `json:"entries"`
	}{Entries: entries})
}
