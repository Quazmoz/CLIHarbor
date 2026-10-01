package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

const maxCredentialInteractiveLoginRequestBytes = 4 << 10

type CredentialInteractiveLoginRequest struct {
	PackID string
	ToolID string
}

type CredentialInteractiveLoginService interface {
	LaunchInteractive(context.Context, CredentialInteractiveLoginRequest) error
}

type credentialInteractiveLoginRequestDTO struct {
	PackID string `json:"packId"`
	ToolID string `json:"toolId"`
}

func (s *Server) handleCredentialInteractiveLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(w)
		return
	}

	request, err := decodeCredentialInteractiveLoginRequest(w, r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
		return
	}

	err = s.credentialInteractiveLogin.LaunchInteractive(r.Context(), CredentialInteractiveLoginRequest{
		PackID: request.PackID,
		ToolID: request.ToolID,
	})
	if err != nil {
		writeCredentialLoginError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func decodeCredentialInteractiveLoginRequest(w http.ResponseWriter, r *http.Request) (credentialInteractiveLoginRequestDTO, error) {
	var zero credentialInteractiveLoginRequestDTO
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return zero, fmt.Errorf("content type must be application/json")
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxCredentialInteractiveLoginRequestBytes)
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
	var request credentialInteractiveLoginRequestDTO
	if err := decoder.Decode(&request); err != nil {
		return zero, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return zero, err
	}
	if !validCredentialTargetID(request.PackID) || !validCredentialTargetID(request.ToolID) {
		return zero, fmt.Errorf("invalid credential target")
	}
	return request, nil
}
