package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"unicode"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

// Task preferences are navigation state only: favorite and recent task
// identities. Each launch uses a new loopback origin, so browser storage cannot
// keep them; the runtime stores the browser's validated document instead.
// They never grant execution authority: the browser reconciles them against the
// backend catalog on every load.
const maxTaskPreferencesBytes = 16 << 10

var emptyTaskPreferences = []byte(`{"version":1,"favorites":[],"recent":[]}`)

// TaskPreferencesStore persists one bounded per-user preference document.
type TaskPreferencesStore interface {
	Load() []byte
	Save([]byte) error
}

type taskIdentityDTO struct {
	PackID    string `json:"packId"`
	CommandID string `json:"commandId"`
}

type taskPreferencesDTO struct {
	Version   int               `json:"version"`
	Favorites []taskIdentityDTO `json:"favorites"`
	Recent    []taskIdentityDTO `json:"recent"`
}

func (s *Server) handleTaskPreferences(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		data := s.taskPreferences.Load()
		if validateTaskPreferences(data) != nil {
			data = emptyTaskPreferences
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
	case http.MethodPut:
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxTaskPreferencesBytes))
		if err != nil || validateTaskPreferences(data) != nil {
			writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
			return
		}
		if err := s.taskPreferences.Save(data); err != nil {
			writeAPIError(w, http.StatusInternalServerError, apperror.CodeInternalError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "GET, PUT")
		writeMethodNotAllowed(w)
	}
}

func validateTaskPreferences(data []byte) error {
	if len(data) == 0 || len(data) > maxTaskPreferencesBytes || !utf8.Valid(data) {
		return fmt.Errorf("preferences must be bounded UTF-8")
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var value taskPreferencesDTO
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return err
	}
	if value.Version != 1 || value.Favorites == nil || value.Recent == nil || len(value.Favorites) > 128 || len(value.Recent) > 128 {
		return fmt.Errorf("unsupported preference shape")
	}
	for _, identity := range append(value.Favorites, value.Recent...) {
		if !validPreferenceID(identity.PackID) || !validPreferenceID(identity.CommandID) {
			return fmt.Errorf("invalid task identity")
		}
	}
	return nil
}

func validPreferenceID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
