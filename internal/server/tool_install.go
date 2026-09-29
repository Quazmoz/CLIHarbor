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
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

const maxToolInstallRequestBytes = 4 << 10

type ToolInstallCapability struct {
	Version        string `json:"version"`
	CustomLocation bool   `json:"customLocation"`
}

type ToolInstallRequest struct {
	PackID      string
	ToolID      string
	InstallRoot string
}

type ToolInstallResult struct {
	Installed       bool   `json:"installed"`
	Version         string `json:"version"`
	RestartRequired bool   `json:"restartRequired"`
	Message         string `json:"message"`
}

type ToolInstallErrorCode string

const (
	ToolInstallUnsupported     ToolInstallErrorCode = "unsupported"
	ToolInstallUnavailable     ToolInstallErrorCode = "unavailable"
	ToolInstallInvalidLocation ToolInstallErrorCode = "invalid-location"
)

type ToolInstallError struct {
	Code ToolInstallErrorCode
}

func (e *ToolInstallError) Error() string {
	if e == nil {
		return "tool install failed"
	}
	return "tool install " + string(e.Code)
}

type ToolInstallService interface {
	InstallTool(context.Context, ToolInstallRequest) (ToolInstallResult, error)
}

type toolInstallRequestDTO struct {
	PackID      string `json:"packId"`
	ToolID      string `json:"toolId"`
	InstallRoot string `json:"installRoot,omitempty"`
}

func (s *Server) handleToolInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(w)
		return
	}
	request, err := decodeToolInstallRequest(w, r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
		return
	}
	result, err := s.toolInstaller.InstallTool(r.Context(), ToolInstallRequest{
		PackID:      request.PackID,
		ToolID:      request.ToolID,
		InstallRoot: request.InstallRoot,
	})
	if err != nil {
		writeToolInstallError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func decodeToolInstallRequest(w http.ResponseWriter, r *http.Request) (toolInstallRequestDTO, error) {
	var zero toolInstallRequestDTO
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return zero, fmt.Errorf("content type must be application/json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxToolInstallRequestBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return zero, err
	}
	if len(bytes.TrimSpace(data)) == 0 || !utf8.Valid(data) {
		return zero, fmt.Errorf("invalid request body")
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return zero, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var request toolInstallRequestDTO
	if err := decoder.Decode(&request); err != nil {
		return zero, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return zero, err
	}
	if !validCredentialTargetID(request.PackID) || !validCredentialTargetID(request.ToolID) {
		return zero, fmt.Errorf("invalid tool target")
	}
	if len(request.InstallRoot) > 4096 {
		return zero, fmt.Errorf("install root is too long")
	}
	for _, character := range request.InstallRoot {
		if character <= 0x1f || character == 0x7f {
			return zero, fmt.Errorf("install root contains control characters")
		}
	}
	return request, nil
}

func writeToolInstallError(w http.ResponseWriter, err error) {
	var installErr *ToolInstallError
	if !errors.As(err, &installErr) {
		writeAPIError(w, http.StatusInternalServerError, apperror.CodeInternalError)
		return
	}
	switch installErr.Code {
	case ToolInstallUnsupported:
		writeAPIError(w, http.StatusConflict, apperror.CodeCommandBlocked)
	case ToolInstallUnavailable:
		writeAPIError(w, http.StatusServiceUnavailable, apperror.CodeToolUnavailable)
	case ToolInstallInvalidLocation:
		writeAPIFieldError(w, http.StatusUnprocessableEntity, apperror.CodeInvalidInput, "installRoot")
	default:
		writeAPIError(w, http.StatusInternalServerError, apperror.CodeInternalError)
	}
}
