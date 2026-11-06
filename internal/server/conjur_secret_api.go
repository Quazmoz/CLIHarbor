package server

import (
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

// SecretRetrievalRequest names one variable on the target the operator sees
// (ADR-043). Version 0 selects the current value; on the versions endpoint it
// must be 0.
type SecretRetrievalRequest struct {
	PackID       string `json:"packId"`
	ToolID       string `json:"toolId"`
	Account      string `json:"account"`
	ApplianceURL string `json:"applianceUrl"`
	VariableID   string `json:"variableId"`
	Version      int    `json:"version"`
}

// SecretVersion is non-secret metadata from the Conjur resource record.
type SecretVersion struct {
	Version   int    `json:"version"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

type SecretVersionsResponse struct {
	VariableID  string          `json:"variableId"`
	Versions    []SecretVersion `json:"versions"`
	FailureCode string          `json:"failureCode,omitempty"`
}

// SecretRevealResponse is the only CLIHarbor response that carries a secret
// value. It is returned once, never stored, and never logged.
type SecretRevealResponse struct {
	VariableID  string `json:"variableId"`
	Version     int    `json:"version,omitempty"`
	Value       string `json:"value,omitempty"`
	FailureCode string `json:"failureCode,omitempty"`
}

// SecretAccessEntry is metadata only: never value bytes, length, or hash.
type SecretAccessEntry struct {
	At           string `json:"at"`
	Account      string `json:"account"`
	ApplianceURL string `json:"applianceUrl"`
	VariableID   string `json:"variableId"`
	Version      int    `json:"version,omitempty"`
	Outcome      string `json:"outcome"`
}

var ErrSecretRetrievalUnavailable = errors.New("secret retrieval unavailable")
var ErrSecretRetrievalInvalidRequest = errors.New("invalid secret retrieval request")

type SecretRetrievalService interface {
	Versions(SecretRetrievalRequest) (SecretVersionsResponse, error)
	Reveal(SecretRetrievalRequest) (SecretRevealResponse, error)
	AccessLog() []SecretAccessEntry
}

const maxSecretVersion = 1 << 20

func (s *Server) handleSecretVersions(w http.ResponseWriter, r *http.Request) {
	request, ok := s.decodeSecretRetrieval(w, r)
	if !ok {
		return
	}
	if request.Version != 0 {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
		return
	}
	response, err := s.secretRetrieval.Versions(request)
	writeSecretRetrieval(w, response, err)
}

func (s *Server) handleSecretReveal(w http.ResponseWriter, r *http.Request) {
	request, ok := s.decodeSecretRetrieval(w, r)
	if !ok {
		return
	}
	response, err := s.secretRetrieval.Reveal(request)
	writeSecretRetrieval(w, response, err)
}

func (s *Server) handleSecretAccessLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Entries []SecretAccessEntry `json:"entries"`
	}{append([]SecretAccessEntry{}, s.secretRetrieval.AccessLog()...)})
}

func (s *Server) decodeSecretRetrieval(w http.ResponseWriter, r *http.Request) (SecretRetrievalRequest, bool) {
	var request SecretRetrievalRequest
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(w)
		return request, false
	}
	if decodeStrictJSON(w, r, &request) != nil || ValidateSecretRetrievalRequest(request) != nil {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
		return request, false
	}
	return request, true
}

func writeSecretRetrieval(w http.ResponseWriter, response any, err error) {
	switch {
	case errors.Is(err, ErrSecretRetrievalInvalidRequest):
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
	case err != nil:
		writeAPIError(w, http.StatusConflict, apperror.CodeToolUnavailable)
	default:
		// securityHeaders already sets Cache-Control: no-store on every response.
		writeJSON(w, http.StatusOK, response)
	}
}

// ValidateSecretRetrievalRequest also protects service callers outside HTTP.
func ValidateSecretRetrievalRequest(request SecretRetrievalRequest) error {
	if !validCredentialTargetID(request.PackID) || !validCredentialTargetID(request.ToolID) ||
		!validSecretRetrievalText(request.Account, 256) || strings.Contains(request.Account, ":") ||
		!validSecretRetrievalText(request.VariableID, 2048) ||
		strings.TrimSpace(request.ApplianceURL) != request.ApplianceURL ||
		validateCredentialConfigurationURL(request.ApplianceURL) != nil ||
		request.Version < 0 || request.Version > maxSecretVersion {
		return ErrSecretRetrievalInvalidRequest
	}
	return nil
}

func validSecretRetrievalText(value string, max int) bool {
	return value != "" && len(value) <= max && utf8.ValidString(value) && strings.TrimSpace(value) == value &&
		strings.IndexFunc(value, func(r rune) bool {
			return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == '\u2028' || r == '\u2029'
		}) < 0
}
