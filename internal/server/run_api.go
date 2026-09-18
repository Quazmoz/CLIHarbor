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
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

const (
	maxRunRequestBytes   = 64 << 10
	sseHeartbeatInterval = 15 * time.Second
	sseWriteTimeout      = 5 * time.Second
)

type RunService interface {
	Start(runs.Request) (runs.Snapshot, error)
	Get(string) (runs.Snapshot, bool)
	Cancel(string) error
}

type RunEventService interface {
	WaitEvents(context.Context, string, uint64) (runs.EventBatch, error)
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
	case len(parts) == 2 && parts[1] == "events" && r.Method == http.MethodGet:
		s.handleRunEvents(w, r, parts[0])
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
		if len(parts) == 1 || (len(parts) == 2 && (parts[1] == "cancel" || parts[1] == "events")) {
			if len(parts) == 1 || parts[1] == "events" {
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

func (s *Server) handleRunEvents(w http.ResponseWriter, r *http.Request, runID string) {
	stream, ok := s.runs.(RunEventService)
	if !ok {
		writeAPIError(w, http.StatusServiceUnavailable, "stream_unavailable")
		return
	}
	cursor, err := parseLastEventID(r.Header.Get("Last-Event-ID"))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_cursor")
		return
	}
	if !s.acquireRunStream() {
		writeAPIError(w, http.StatusTooManyRequests, "stream_capacity")
		return
	}
	defer s.releaseRunStream()

	waitCtx, cancel := context.WithTimeout(r.Context(), sseHeartbeatInterval)
	batch, waitErr := stream.WaitEvents(waitCtx, runID, cursor)
	cancel()
	initialHeartbeat := false
	if waitErr != nil {
		if errors.Is(waitErr, context.DeadlineExceeded) && r.Context().Err() == nil {
			initialHeartbeat = true
		} else {
			writeRunStreamError(w, waitErr)
			return
		}
	}

	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Time{}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "stream_unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	if err := controller.Flush(); err != nil {
		return
	}

	if initialHeartbeat {
		if err := writeSSEHeartbeat(w, controller); err != nil {
			return
		}
	} else {
		var complete bool
		cursor, complete, err = writeSSEBatch(w, controller, batch, cursor)
		if err != nil || complete {
			return
		}
	}

	for {
		waitCtx, cancel := context.WithTimeout(r.Context(), sseHeartbeatInterval)
		batch, waitErr := stream.WaitEvents(waitCtx, runID, cursor)
		cancel()
		if waitErr != nil {
			if errors.Is(waitErr, context.DeadlineExceeded) && r.Context().Err() == nil {
				if err := writeSSEHeartbeat(w, controller); err != nil {
					return
				}
				continue
			}
			return
		}
		var complete bool
		cursor, complete, err = writeSSEBatch(w, controller, batch, cursor)
		if err != nil || complete {
			return
		}
	}
}

func writeRunStreamError(w http.ResponseWriter, err error) {
	var runErr *runs.Error
	if errors.As(err, &runErr) {
		switch runErr.Code {
		case runs.ErrNotFound:
			writeAPIError(w, http.StatusNotFound, string(runErr.Code))
		case runs.ErrInvalidCursor:
			writeAPIError(w, http.StatusBadRequest, string(runErr.Code))
		default:
			writeAPIError(w, http.StatusServiceUnavailable, "stream_unavailable")
		}
		return
	}
	writeAPIError(w, http.StatusServiceUnavailable, "stream_unavailable")
}

func writeSSEBatch(w http.ResponseWriter, controller *http.ResponseController, batch runs.EventBatch, cursor uint64) (uint64, bool, error) {
	for _, event := range batch.Events {
		if err := writeSSEEvent(w, controller, batch.RunID, event); err != nil {
			return cursor, false, err
		}
		cursor = event.Sequence
	}
	if batch.Complete {
		if err := writeSSEComplete(w, controller, batch, cursor); err != nil {
			return cursor, true, err
		}
		return cursor, true, nil
	}
	return cursor, false, nil
}

func (s *Server) acquireRunStream() bool {
	select {
	case s.runStreamSlots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *Server) releaseRunStream() {
	<-s.runStreamSlots
}

func parseLastEventID(value string) (uint64, error) {
	if value == "" {
		return 0, nil
	}
	if strings.TrimSpace(value) != value {
		return 0, fmt.Errorf("invalid cursor")
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, fmt.Errorf("invalid cursor")
		}
	}
	cursor, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid cursor")
	}
	return cursor, nil
}

func writeSSEEvent(w http.ResponseWriter, controller *http.ResponseController, runID string, event runs.Event) error {
	payload, err := json.Marshal(struct {
		RunID      string    `json:"runId"`
		Sequence   uint64    `json:"sequence"`
		Type       string    `json:"type"`
		Timestamp  time.Time `json:"timestamp"`
		DataBase64 string    `json:"dataBase64,omitempty"`
		ExitCode   *int      `json:"exitCode,omitempty"`
	}{
		RunID:      runID,
		Sequence:   event.Sequence,
		Type:       event.Type,
		Timestamp:  event.Timestamp,
		DataBase64: event.DataBase64,
		ExitCode:   event.ExitCode,
	})
	if err != nil {
		return err
	}
	return writeSSEFrame(w, controller, event.Sequence, "run-event", payload)
}

func writeSSEComplete(w http.ResponseWriter, controller *http.ResponseController, batch runs.EventBatch, sequence uint64) error {
	payload, err := json.Marshal(struct {
		RunID    string      `json:"runId"`
		Sequence uint64      `json:"sequence"`
		Status   runs.Status `json:"status"`
		ExitCode *int        `json:"exitCode,omitempty"`
	}{
		RunID:    batch.RunID,
		Sequence: sequence,
		Status:   batch.Status,
		ExitCode: batch.ExitCode,
	})
	if err != nil {
		return err
	}
	return writeSSEData(w, controller, "run-complete", payload)
}

func writeSSEFrame(w http.ResponseWriter, controller *http.ResponseController, sequence uint64, eventType string, payload []byte) error {
	if err := controller.SetWriteDeadline(time.Now().Add(sseWriteTimeout)); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", sequence, eventType, payload); err != nil {
		return err
	}
	if err := controller.Flush(); err != nil {
		return err
	}
	return controller.SetWriteDeadline(time.Time{})
}

func writeSSEData(w http.ResponseWriter, controller *http.ResponseController, eventType string, payload []byte) error {
	if err := controller.SetWriteDeadline(time.Now().Add(sseWriteTimeout)); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", eventType, payload); err != nil {
		return err
	}
	if err := controller.Flush(); err != nil {
		return err
	}
	return controller.SetWriteDeadline(time.Time{})
}

func writeSSEHeartbeat(w http.ResponseWriter, controller *http.ResponseController) error {
	if err := controller.SetWriteDeadline(time.Now().Add(sseWriteTimeout)); err != nil {
		return err
	}
	if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
		return err
	}
	if err := controller.Flush(); err != nil {
		return err
	}
	return controller.SetWriteDeadline(time.Time{})
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
	case runs.ErrInvalidCursor:
		writeAPIError(w, http.StatusBadRequest, string(runErr.Code))
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
