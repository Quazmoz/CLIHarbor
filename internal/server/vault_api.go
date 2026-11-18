package server

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

// VaultSecretRequest names one KV location on the Vault server the vendor CLI
// is configured for (ADR-045). Browser input never selects the server.
type VaultSecretRequest struct {
	Mount string `json:"mount"`
	Path  string `json:"path"`
}

// VaultContext is the operator-visible target taken from the vendor CLI's
// own environment. It carries no token or credential material.
type VaultContext struct {
	Address   string `json:"address"`
	Namespace string `json:"namespace,omitempty"`
	Ready     bool   `json:"ready"`
}

type VaultListResponse struct {
	Mount       string   `json:"mount"`
	Path        string   `json:"path"`
	Keys        []string `json:"keys"`
	FailureCode string   `json:"failureCode,omitempty"`
}

type VaultSecretField struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// VaultRevealResponse carries secret values. It is returned once, never
// stored, and never logged.
type VaultRevealResponse struct {
	Mount       string             `json:"mount"`
	Path        string             `json:"path"`
	Version     int                `json:"version,omitempty"`
	Fields      []VaultSecretField `json:"fields,omitempty"`
	FailureCode string             `json:"failureCode,omitempty"`
}

// VaultAccessEntry is metadata only: never value bytes, length, or hash.
type VaultAccessEntry struct {
	At      string `json:"at"`
	Address string `json:"address"`
	Mount   string `json:"mount"`
	Path    string `json:"path"`
	Outcome string `json:"outcome"`
}

type VaultService interface {
	Context() VaultContext
	List(context.Context, VaultSecretRequest) (VaultListResponse, error)
	Reveal(context.Context, VaultSecretRequest) (VaultRevealResponse, error)
	AccessLog() []VaultAccessEntry
}

var (
	ErrVaultUnavailable    = errors.New("vault platform unavailable")
	ErrVaultInvalidRequest = errors.New("invalid vault request")
)

// A conservative subset of Vault path characters. The mount always starts
// with an alphanumeric, so the single rendered argv element can never be
// parsed as a flag; "." and ".." segments are refused.
var vaultSegment = regexp.MustCompile(`^[A-Za-z0-9_.@+=:,-]{1,128}$`)

func validVaultPath(value string, max int, first bool) bool {
	if len(value) > max {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if !vaultSegment.MatchString(segment) || segment == "." || segment == ".." {
			return false
		}
	}
	return !first || (value[0] >= 'a' && value[0] <= 'z') || (value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= '0' && value[0] <= '9')
}

// ValidateVaultSecretRequest also protects service callers outside HTTP. An
// empty path is only valid for listing the mount root.
func ValidateVaultSecretRequest(request VaultSecretRequest, allowEmptyPath bool) error {
	if !validVaultPath(request.Mount, 256, true) ||
		(request.Path == "" && !allowEmptyPath) ||
		(request.Path != "" && !validVaultPath(request.Path, 1024, false)) {
		return ErrVaultInvalidRequest
	}
	return nil
}

func (s *Server) handleVaultContext(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, s.vault.Context())
}

func (s *Server) handleVaultList(w http.ResponseWriter, r *http.Request) {
	if request, ok := decodeVaultRequest(w, r, true); ok {
		response, err := s.vault.List(r.Context(), request)
		writeVaultResponse(w, response, err)
	}
}

func (s *Server) handleVaultReveal(w http.ResponseWriter, r *http.Request) {
	if request, ok := decodeVaultRequest(w, r, false); ok {
		response, err := s.vault.Reveal(r.Context(), request)
		writeVaultResponse(w, response, err)
	}
}

func (s *Server) handleVaultAccessLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Entries []VaultAccessEntry `json:"entries"`
	}{append([]VaultAccessEntry{}, s.vault.AccessLog()...)})
}

func decodeVaultRequest(w http.ResponseWriter, r *http.Request, allowEmptyPath bool) (VaultSecretRequest, bool) {
	var request VaultSecretRequest
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(w)
		return request, false
	}
	if decodeStrictJSON(w, r, &request) != nil || ValidateVaultSecretRequest(request, allowEmptyPath) != nil {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
		return request, false
	}
	return request, true
}

func writeVaultResponse(w http.ResponseWriter, response any, err error) {
	switch {
	case errors.Is(err, ErrVaultInvalidRequest):
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
	case err != nil:
		writeAPIError(w, http.StatusConflict, apperror.CodeToolUnavailable)
	default:
		// securityHeaders already sets Cache-Control: no-store on every response.
		writeJSON(w, http.StatusOK, response)
	}
}
