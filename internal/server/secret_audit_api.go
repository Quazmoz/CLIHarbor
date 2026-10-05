package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

const maxSecretAuditRequestBytes = 4 << 10

// SecretAuditRequest starts the fixed, read-only Conjur secret-value reference
// audit. The browser chooses only the reviewed target identity and the
// reporting threshold; everything else is backend-controlled.
type SecretAuditRequest struct {
	PackID            string
	ToolID            string
	MinimumConfidence string
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

type SecretAuditService interface {
	Snapshot() SecretAuditSnapshot
	Start(SecretAuditRequest) (SecretAuditSnapshot, error)
	Cancel() SecretAuditSnapshot
}

type secretAuditRequestDTO struct {
	PackID            string `json:"packId"`
	ToolID            string `json:"toolId"`
	MinimumConfidence string `json:"minimumConfidence"`
}

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
		snapshot, err := s.secretAudit.Start(SecretAuditRequest{
			PackID:            request.PackID,
			ToolID:            request.ToolID,
			MinimumConfidence: request.MinimumConfidence,
		})
		if err != nil {
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
	if !validCredentialTargetID(request.PackID) || !validCredentialTargetID(request.ToolID) {
		return zero, fmt.Errorf("invalid audit target")
	}
	if request.MinimumConfidence != "high" && request.MinimumConfidence != "medium" {
		return zero, fmt.Errorf("invalid minimum confidence")
	}
	return request, nil
}
