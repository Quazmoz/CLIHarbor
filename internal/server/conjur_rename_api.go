package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

// Rename requests never carry a value or browser-authored policy.
type SecretRenameRequest struct {
	Target       SecretRetrievalRequest `json:"target"`
	Destination  string                 `json:"destination"`
	ApprovalID   string                 `json:"approvalId"`
	Confirmation string                 `json:"confirmation"`
}

type SecretVersionMapping struct {
	Source      int `json:"source"`
	Destination int `json:"destination"`
}

type SecretRenameResponse struct {
	ApprovalID  string                 `json:"approvalId,omitempty"`
	ExpiresAt   string                 `json:"expiresAt,omitempty"`
	Source      string                 `json:"source"`
	Destination string                 `json:"destination"`
	Owner       string                 `json:"owner,omitempty"`
	Policy      string                 `json:"policy,omitempty"`
	Grants      int                    `json:"grants"`
	Annotations int                    `json:"annotations"`
	Versions    []SecretVersionMapping `json:"versions"`
	RunIDs      []string               `json:"runIds"`
	Status      string                 `json:"status"`
	FailureCode string                 `json:"failureCode,omitempty"`
}

type SecretRenameService interface {
	Rename(context.Context, string, SecretRenameRequest) (SecretRenameResponse, error)
}

func (s *Server) handleSecretRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(w)
		return
	}
	var request SecretRenameRequest
	if decodeStrictJSON(w, r, &request) != nil ||
		ValidateSecretRetrievalRequest(request.Target) != nil || request.Target.Version != 0 ||
		!validSecretRetrievalText(request.Destination, 2048) {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
		return
	}
	action := r.URL.Path[len("/api/v1/conjur/secrets/rename/"):]
	if action != "review" && action != "copy" && action != "delete" && action != "discard" {
		http.NotFound(w, r)
		return
	}
	// A bounded multi-step copy can outlive the ordinary 30-second response.
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(slowResponseWriteTimeout)); err != nil {
		writeAPIError(w, http.StatusInternalServerError, apperror.CodeInternalError)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	response, err := s.secretRename.Rename(ctx, action, request)
	switch {
	case errors.Is(err, ErrSecretRetrievalInvalidRequest):
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
	case err != nil:
		writeAPIError(w, http.StatusConflict, apperror.CodeToolUnavailable)
	default:
		writeJSON(w, http.StatusOK, response)
	}
}
