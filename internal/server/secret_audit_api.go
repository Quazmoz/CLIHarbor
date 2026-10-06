package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

const maxSecretAuditRequestBytes = 4 << 10

// SecretAuditRequest selects a read-only value scan. Patterns are ephemeral
// input: never copy them into snapshots, errors, logs, or exported reports.
type SecretAuditRequest struct {
	PackID            string `json:"packId"`
	ToolID            string `json:"toolId"`
	MinimumConfidence string `json:"minimumConfidence"`
	ApplianceURL      string `json:"applianceUrl"`
	ScanType          string `json:"scanType"`
	Pattern           string `json:"pattern"`
}

type SecretAuditTarget struct {
	ApplianceURL string `json:"applianceUrl"`
	Account      string `json:"account"`
}

// SecretAuditFinding and SecretAuditFailure carry identifiers and closed
// reason codes only. There is deliberately no field that could hold a value.
type SecretAuditFinding struct {
	VariableID string `json:"variableId"`
	Confidence string `json:"confidence"`
	Reason     string `json:"reason"`
}

type SecretAuditFailure struct {
	VariableID string `json:"variableId"`
	Code       string `json:"code"`
}

type SecretAuditSnapshot struct {
	Available         bool                 `json:"available"`
	PackID            string               `json:"packId,omitempty"`
	ToolID            string               `json:"toolId,omitempty"`
	Target            *SecretAuditTarget   `json:"target,omitempty"`
	State             string               `json:"state"`
	Phase             string               `json:"phase,omitempty"`
	MinimumConfidence string               `json:"minimumConfidence,omitempty"`
	ScanType          string               `json:"scanType,omitempty"`
	StartedAt         string               `json:"startedAt,omitempty"`
	FinishedAt        string               `json:"finishedAt,omitempty"`
	Total             int                  `json:"total"`
	Processed         int                  `json:"processed"`
	Inspected         int                  `json:"inspected"`
	FailureCode       string               `json:"failureCode,omitempty"`
	Findings          []SecretAuditFinding `json:"findings"`
	Failures          []SecretAuditFailure `json:"failures"`
}

var ErrSecretAuditUnavailable = errors.New("secret audit unavailable")
var ErrSecretAuditInvalidRequest = errors.New("invalid secret audit request")

type SecretAuditService interface {
	Snapshot() SecretAuditSnapshot
	Start(SecretAuditRequest) (SecretAuditSnapshot, error)
	Cancel() SecretAuditSnapshot
}

type secretAuditRequestDTO = SecretAuditRequest

func (s *Server) handleSecretAudit(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.secretAudit.Snapshot())
	case http.MethodPost:
		request, err := decodeSecretAuditRequest(w, r)
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
			return
		}
		snapshot, err := s.secretAudit.Start(request)
		if err != nil {
			if errors.Is(err, ErrSecretAuditInvalidRequest) {
				writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
				return
			}
			writeAPIError(w, http.StatusConflict, apperror.CodeToolUnavailable)
			return
		}
		writeJSON(w, http.StatusAccepted, snapshot)
	case http.MethodDelete:
		writeJSON(w, http.StatusOK, s.secretAudit.Cancel())
	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		writeMethodNotAllowed(w)
	}
}

func decodeSecretAuditRequest(w http.ResponseWriter, r *http.Request) (secretAuditRequestDTO, error) {
	var zero secretAuditRequestDTO
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return zero, fmt.Errorf("content type must be application/json")
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxSecretAuditRequestBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return zero, err
	}
	if len(bytes.TrimSpace(data)) == 0 || !utf8.Valid(data) {
		return zero, fmt.Errorf("request body must be non-empty valid UTF-8")
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return zero, err
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var request secretAuditRequestDTO
	if err := decoder.Decode(&request); err != nil {
		return zero, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return zero, err
	}
	if err := ValidateSecretAuditRequest(request); err != nil {
		return zero, err
	}
	return request, nil
}

// ValidateSecretAuditRequest also protects service callers outside HTTP.
// Go's regexp engine has bounded, linear-time matching; no scripts execute.
func ValidateSecretAuditRequest(request SecretAuditRequest) error {
	if !validCredentialTargetID(request.PackID) || !validCredentialTargetID(request.ToolID) ||
		(request.MinimumConfidence != "high" && request.MinimumConfidence != "medium") {
		return ErrSecretAuditInvalidRequest
	}
	if request.ApplianceURL != "" && (strings.TrimSpace(request.ApplianceURL) != request.ApplianceURL || validateCredentialConfigurationURL(request.ApplianceURL) != nil) {
		return ErrSecretAuditInvalidRequest
	}
	if !utf8.ValidString(request.Pattern) || len(request.Pattern) > 1024 || strings.IndexFunc(request.Pattern, func(r rune) bool {
		return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == '\u2028' || r == '\u2029'
	}) >= 0 {
		return ErrSecretAuditInvalidRequest
	}
	switch request.ScanType {
	case "", "references":
		if request.Pattern != "" {
			return ErrSecretAuditInvalidRequest
		}
	case "contains", "exact", "regex":
		if request.Pattern == "" {
			return ErrSecretAuditInvalidRequest
		}
		if request.ScanType == "regex" {
			if _, err := regexp.Compile(request.Pattern); err != nil {
				return ErrSecretAuditInvalidRequest
			}
		}
	default:
		return ErrSecretAuditInvalidRequest
	}
	return nil
}
