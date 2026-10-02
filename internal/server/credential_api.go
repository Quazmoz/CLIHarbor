package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

const maxCredentialLoginRequestBytes = 8 << 10

type CredentialLoginMethod string

const (
	CredentialLoginMethodConjurPassword    CredentialLoginMethod = "conjur-password"
	CredentialLoginMethodConjurVendorLogin CredentialLoginMethod = "conjur-vendor-login"
)

type CredentialLoginCapability struct {
	Method        CredentialLoginMethod `json:"method"`
	SetupRequired bool                  `json:"setupRequired,omitempty"`
}

type CredentialLoginRequest struct {
	PackID   string
	ToolID   string
	Identity string
	Secret   string
}

type CredentialLoginErrorCode string

const (
	CredentialLoginUnsupported CredentialLoginErrorCode = "unsupported"
	CredentialLoginRejected    CredentialLoginErrorCode = "rejected"
	CredentialLoginUnavailable CredentialLoginErrorCode = "unavailable"
	CredentialLoginBusy        CredentialLoginErrorCode = "busy"
)

type CredentialLoginError struct {
	Code CredentialLoginErrorCode
}

func (e *CredentialLoginError) Error() string {
	if e == nil {
		return "credential login failed"
	}
	return "credential login " + string(e.Code)
}

type CredentialLoginService interface {
	Login(context.Context, CredentialLoginRequest) error
}

type credentialLoginRequestDTO struct {
	PackID   string `json:"packId"`
	ToolID   string `json:"toolId"`
	Identity string `json:"identity"`
	Secret   string `json:"secret"`
}

func (s *Server) handleCredentialLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(w)
		return
	}

	request, err := decodeCredentialLoginRequest(w, r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
		return
	}

	err = s.credentialLogin.Login(r.Context(), CredentialLoginRequest{
		PackID:   request.PackID,
		ToolID:   request.ToolID,
		Identity: request.Identity,
		Secret:   request.Secret,
	})
	if err != nil {
		writeCredentialLoginError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func decodeCredentialLoginRequest(w http.ResponseWriter, r *http.Request) (credentialLoginRequestDTO, error) {
	var zero credentialLoginRequestDTO
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return zero, fmt.Errorf("content type must be application/json")
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxCredentialLoginRequestBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return zero, err
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return zero, fmt.Errorf("request body is empty")
	}
	if !utf8.Valid(data) {
		return zero, fmt.Errorf("request body must be valid UTF-8")
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return zero, err
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var request credentialLoginRequestDTO
	if err := decoder.Decode(&request); err != nil {
		return zero, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return zero, err
	}

	request.Identity = strings.TrimSpace(request.Identity)
	if !validCredentialTargetID(request.PackID) || !validCredentialTargetID(request.ToolID) {
		return zero, fmt.Errorf("invalid credential target")
	}
	if request.Identity == "" || len(request.Identity) > 256 || containsControlCharacter(request.Identity) {
		return zero, fmt.Errorf("invalid identity")
	}
	if request.Secret == "" || len(request.Secret) > 4096 || strings.ContainsRune(request.Secret, '\x00') {
		return zero, fmt.Errorf("invalid secret")
	}

	return request, nil
}

func validCredentialTargetID(value string) bool {
	if len(value) == 0 || len(value) > 63 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, r := range value[1:] {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return true
}

func containsControlCharacter(value string) bool {
	for _, r := range value {
		if r <= 0x1f || r == 0x7f {
			return true
		}
	}
	return false
}

func writeCredentialLoginError(w http.ResponseWriter, err error) {
	var loginErr *CredentialLoginError
	if !errors.As(err, &loginErr) {
		writeAPIError(w, http.StatusInternalServerError, apperror.CodeInternalError)
		return
	}

	switch loginErr.Code {
	case CredentialLoginUnsupported:
		writeAPIError(w, http.StatusConflict, apperror.CodeAuthenticationUnsupported)
	case CredentialLoginRejected:
		writeAPIError(w, http.StatusUnprocessableEntity, apperror.CodeAuthenticationFailed)
	case CredentialLoginUnavailable:
		writeAPIError(w, http.StatusServiceUnavailable, apperror.CodeAuthenticationUnavailable)
	case CredentialLoginBusy:
		writeAPIError(w, http.StatusTooManyRequests, apperror.CodeAuthenticationBusy)
	default:
		writeAPIError(w, http.StatusInternalServerError, apperror.CodeInternalError)
	}
}
