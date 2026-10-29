package server

import (
	"crypto/sha256"
	"fmt"
	"net/http"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
	"github.com/Quazmoz/CLIHarbor/internal/diagnostics"
)

func (s *Server) handleDiagnostics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(w)
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
		return
	}
	// Reuse the CLI export's allowlist, validation and byte limit before writing.
	payload, err := diagnostics.MarshalBundle(s.diagnostics())
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, apperror.CodeInternalError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-CLIHarbor-Diagnostics-SHA256", fmt.Sprintf("%x", sha256.Sum256(payload)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}
