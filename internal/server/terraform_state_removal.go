package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

// Terraform state removal ("forget") is a two-step, backend-enforced flow:
//
//  1. POST /api/v1/terraform/state-removal/preview runs `terraform state rm
//     -dry-run` against a pinned snapshot and returns a one-use previewId bound
//     to the project, the state file's identity and SHA-256, and the exact
//     address set.
//  2. POST /api/v1/terraform/state-removal/execute consumes that previewId
//     once, with a typed confirmation of the state file name, and performs the
//     removal only if the snapshot is still byte-identical.
//
// Both routes sit behind the session, Origin and CSRF boundary like every
// other state-changing request. Neither accepts a filesystem path, flag or
// free-form argument from the browser.
type TerraformStateRemovalService interface {
	PreviewStateRemoval(ctx context.Context, request TerraformStateRemovalPreviewRequest) (TerraformStateRemovalPreview, error)
	ExecuteStateRemoval(ctx context.Context, request TerraformStateRemovalExecuteRequest) (TerraformStateRemovalResult, error)
}

const (
	maxTerraformRemovalAddresses    = 50
	maxTerraformRemovalRequestBytes = 64 << 10
)

type TerraformStateRemovalPreviewRequest struct {
	ProjectID string   `json:"project"`
	StateID   string   `json:"state"`
	Addresses []string `json:"addresses"`
}

type TerraformStateRemovalExecuteRequest struct {
	PreviewID string `json:"previewId"`
	// Confirm must equal the previewed state file name exactly.
	Confirm string `json:"confirm"`
}

type TerraformStateRemovalPreview struct {
	PreviewID        string   `json:"previewId"`
	ProjectID        string   `json:"projectId"`
	StateID          string   `json:"stateId"`
	StateName        string   `json:"stateName"`
	Addresses        []string `json:"addresses"`
	Serial           int64    `json:"serial"`
	TerraformVersion string   `json:"terraformVersion"`
	ExpiresAt        string   `json:"expiresAt"`
}

// TerraformStateRemovalResult is returned once Terraform was started. Outcome
// "removed" means the post-check proved exactly the previewed addresses left
// the state and nothing else changed. "unverified" means the state may have
// changed and must be inspected; the backups are named so the operator can
// recover.
type TerraformStateRemovalResult struct {
	Outcome         string   `json:"outcome"`
	ProjectID       string   `json:"projectId"`
	StateID         string   `json:"stateId"`
	StateName       string   `json:"stateName"`
	Removed         []string `json:"removed"`
	Serial          int64    `json:"serial"`
	Backup          string   `json:"backup"`
	TerraformBackup string   `json:"terraformBackup,omitempty"`
	Problem         string   `json:"problem,omitempty"`
	CompletedAt     string   `json:"completedAt"`
}

// TerraformStateRemovalErrorCode classifies refusals that happened before any
// state change. Anything after Terraform starts is reported as a result.
type TerraformStateRemovalErrorCode string

const (
	TerraformRemovalInvalid     TerraformStateRemovalErrorCode = "invalid"
	TerraformRemovalStale       TerraformStateRemovalErrorCode = "stale"
	TerraformRemovalBusy        TerraformStateRemovalErrorCode = "busy"
	TerraformRemovalUnavailable TerraformStateRemovalErrorCode = "unavailable"
	TerraformRemovalToolChanged TerraformStateRemovalErrorCode = "tool-changed"
	TerraformRemovalRejected    TerraformStateRemovalErrorCode = "rejected"
	TerraformRemovalAudit       TerraformStateRemovalErrorCode = "audit"
)

type TerraformStateRemovalError struct {
	Code TerraformStateRemovalErrorCode
}

func (e *TerraformStateRemovalError) Error() string {
	if e == nil {
		return "terraform state removal refused"
	}
	return "terraform state removal refused: " + string(e.Code)
}

var terraformPreviewID = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func (s *Server) handleTerraformStateRemovalPreview(w http.ResponseWriter, r *http.Request) {
	service, ok := s.terraform.(TerraformStateRemovalService)
	if !ok {
		writeResourceNotFound(w)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(w)
		return
	}
	var request TerraformStateRemovalPreviewRequest
	if err := decodeStrictJSON(w, r, &request); err != nil || !validRemovalPreviewRequest(request) {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidInput)
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(timeNowPlus(slowResponseWriteTimeout))
	preview, err := service.PreviewStateRemoval(r.Context(), request)
	if err != nil {
		writeTerraformRemovalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func (s *Server) handleTerraformStateRemovalExecute(w http.ResponseWriter, r *http.Request) {
	service, ok := s.terraform.(TerraformStateRemovalService)
	if !ok {
		writeResourceNotFound(w)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(w)
		return
	}
	var request TerraformStateRemovalExecuteRequest
	if err := decodeStrictJSON(w, r, &request); err != nil || !terraformPreviewID.MatchString(request.PreviewID) ||
		request.Confirm == "" || len(request.Confirm) > 255 || !safeLine(request.Confirm) {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidInput)
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(timeNowPlus(slowResponseWriteTimeout))
	// The client disconnecting must not abandon a mutation half way: the
	// service owns its own bounded deadline once it has consumed the preview.
	result, err := service.ExecuteStateRemoval(context.WithoutCancel(r.Context()), request)
	if err != nil {
		writeTerraformRemovalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func validRemovalPreviewRequest(request TerraformStateRemovalPreviewRequest) bool {
	if !terraformSelector.MatchString(request.ProjectID) || !terraformSelector.MatchString(request.StateID) {
		return false
	}
	if len(request.Addresses) == 0 || len(request.Addresses) > maxTerraformRemovalAddresses {
		return false
	}
	seen := make(map[string]bool, len(request.Addresses))
	for _, address := range request.Addresses {
		// Exact inventory membership is enforced by the service; this is the
		// cheap syntactic gate. No address may look like a flag.
		if address == "" || len(address) > 512 || address[0] == '-' || !safeLine(address) || seen[address] {
			return false
		}
		seen[address] = true
	}
	return true
}

func safeLine(value string) bool {
	if !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == 0x2028 || r == 0x2029 {
			return false
		}
	}
	return true
}

func decodeStrictJSON(w http.ResponseWriter, r *http.Request, target any) error {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return errors.New("content type must be application/json")
	}
	if len(r.URL.Query()) != 0 {
		return errors.New("unexpected query")
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxTerraformRemovalRequestBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil || len(bytes.TrimSpace(data)) == 0 || !utf8.Valid(data) {
		return errors.New("invalid request body")
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}

func writeTerraformRemovalError(w http.ResponseWriter, err error) {
	var removalErr *TerraformStateRemovalError
	if !errors.As(err, &removalErr) {
		// Never serialize filesystem paths, executable paths, or vendor output.
		writeAPIError(w, http.StatusConflict, apperror.CodeExecutionContextUnavailable)
		return
	}
	switch removalErr.Code {
	case TerraformRemovalInvalid:
		writeAPIFieldError(w, http.StatusUnprocessableEntity, apperror.CodeInvalidInput, "addresses")
	case TerraformRemovalStale:
		writeAPIError(w, http.StatusConflict, apperror.CodeApprovalRequired)
	case TerraformRemovalBusy:
		writeAPIError(w, http.StatusConflict, apperror.CodeRunCapacity)
	case TerraformRemovalUnavailable:
		writeAPIError(w, http.StatusServiceUnavailable, apperror.CodeToolUnavailable)
	case TerraformRemovalToolChanged:
		writeAPIError(w, http.StatusConflict, apperror.CodeToolChanged)
	case TerraformRemovalRejected:
		writeAPIError(w, http.StatusConflict, apperror.CodeExecutionFailed)
	case TerraformRemovalAudit:
		writeAPIError(w, http.StatusServiceUnavailable, apperror.CodeAuditUnavailable)
	default:
		writeAPIError(w, http.StatusConflict, apperror.CodeExecutionContextUnavailable)
	}
}

func timeNowPlus(d time.Duration) time.Time { return time.Now().Add(d) }
