package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

const maxRunRequestBytes = 64 << 10

type RunService interface {
	Start(runs.Request) (runs.Snapshot, error)
	Get(string) (runs.Snapshot, bool)
	Cancel(string) error
}

type createRunRequest struct {
	PackID    string                     `json:"packId"`
	CommandID string                     `json:"commandId"`
	Values    map[string]json.RawMessage `json:"values,omitempty"`
}

func (s *Server) handleRuns(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	request, err := decodeCreateRunRequest(w, r)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeAPIError(w, http.StatusRequestEntityTooLarge, "request_too_large")
			return
		}
		writeAPIError(w, http.StatusBadRequest, "invalid_request")
		return
	}

	snapshot, err := s.runs.Start(runs.Request{
		PackID:    request.PackID,
		CommandID: request.CommandID,
		Values:    request.Values,
	})
	if err != nil {
		writeRunError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, snapshot)
}

func (s *Server) handleRunByID(w http.ResponseWriter, r *http.Request) {
	relative := strings.TrimPrefix(r.URL.Path, "/api/v1/runs/")
	if relative == "" {
		http.NotFound(w, r)
		return
	}
	parts := strings.Split(relative, "/")
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		snapshot, ok := s.runs.Get(parts[0])
		if !ok {
			writeAPIError(w, http.StatusNotFound, "not_found")
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	case len(parts) == 2 && parts[1] == "cancel" && r.Method == http.MethodPost:
		if err := s.runs.Cancel(parts[0]); err != nil {
			writeRunError(w, err)
			return
		}
		snapshot, ok := s.runs.Get(parts[0])
		if !ok {
			writeAPIError(w, http.StatusNotFound, "not_found")
			return
		}
		writeJSON(w, http.StatusAccepted, snapshot)
	default:
		if len(parts) == 1 || (len(parts) == 2 && parts[1] == "cancel") {
			if len(parts) == 1 {
				w.Header().Set("Allow", http.MethodGet)
			} else {
				w.Header().Set("Allow", http.MethodPost)
			}
			writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		http.NotFound(w, r)
	}
}

func decodeCreateRunRequest(w http.ResponseWriter, r *http.Request) (createRunRequest, error) {
	var zero createRunRequest
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return zero, fmt.Errorf("content type must be application/json")
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRunRequestBytes)
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
	var request createRunRequest
	if err := decoder.Decode(&request); err != nil {
		return zero, err
	}
	if request.PackID == "" || request.CommandID == "" {
		return zero, fmt.Errorf("packId and commandId are required")
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return zero, err
	}
	return request, nil
}

func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := walkJSONValue(decoder); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}

func walkJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}

	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return fmt.Errorf("object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("duplicate object key")
			}
			seen[key] = struct{}{}
			if err := walkJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return err
		}
		if end != json.Delim('}') {
			return fmt.Errorf("unterminated object")
		}
	case '[':
		for decoder.More() {
			if err := walkJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return err
		}
		if end != json.Delim(']') {
			return fmt.Errorf("unterminated array")
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter")
	}
	return nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return fmt.Errorf("trailing JSON value")
	}
	return err
}

func writeRunError(w http.ResponseWriter, err error) {
	var runErr *runs.Error
	if !errors.As(err, &runErr) {
		writeAPIError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	switch runErr.Code {
	case runs.ErrInvalidRequest:
		writeAPIError(w, http.StatusBadRequest, string(runErr.Code))
	case runs.ErrUnavailable:
		writeAPIError(w, http.StatusConflict, string(runErr.Code))
	case runs.ErrCapacity:
		writeAPIError(w, http.StatusTooManyRequests, string(runErr.Code))
	case runs.ErrNotFound:
		writeAPIError(w, http.StatusNotFound, string(runErr.Code))
	case runs.ErrClosed:
		writeAPIError(w, http.StatusServiceUnavailable, string(runErr.Code))
	default:
		writeAPIError(w, http.StatusInternalServerError, "internal_error")
	}
}

func writeAPIError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, struct {
		Error string `json:"error"`
	}{Error: code})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
