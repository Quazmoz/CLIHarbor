package server

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"runtime/debug"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

// panicLogf is replaceable in tests.
var panicLogf = log.Printf

// recoverPanics converts a handler panic into a sanitized 500 instead of a
// dropped connection, which the browser otherwise surfaces as an opaque
// network failure (and an SSE client as an endless reconnect loop).
//
// The panic value is deliberately NOT logged or returned: handlers touch
// vendor output, credential-adjacent request bodies and CLI arguments, and a
// formatted panic value could carry any of them. Only the value's type, the
// method, a bounded path and the stack are logged; the stack holds code
// locations, not runtime data.
//
// http.ErrAbortHandler is re-panicked so net/http keeps its documented
// "abort this response silently" semantics.
func (s *Server) recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tracked := &panicSafeWriter{ResponseWriter: w}
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			if err, ok := recovered.(error); ok && errors.Is(err, http.ErrAbortHandler) {
				panic(recovered)
			}
			panicLogf("cliharbor: recovered handler panic (%T) on %s %s\n%s",
				recovered, r.Method, boundedPath(r.URL.Path), debug.Stack())
			if tracked.wroteHeader {
				// Status and some body already went out; the only honest
				// signal left is to abort the connection.
				panic(http.ErrAbortHandler)
			}
			writeRequestBoundaryError(w, r, http.StatusInternalServerError, apperror.CodeInternalError)
		}()
		next.ServeHTTP(tracked, r)
	})
}

func boundedPath(path string) string {
	const max = 128
	path = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return '?'
		}
		return r
	}, path)
	if len(path) > max {
		return fmt.Sprintf("%s…(%d bytes)", path[:max], len(path))
	}
	return path
}

// panicSafeWriter records whether the response has started. Unwrap keeps
// http.ResponseController (Flush, SetWriteDeadline) working for SSE and the
// long-running install/login handlers.
type panicSafeWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func (w *panicSafeWriter) WriteHeader(status int) {
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *panicSafeWriter) Write(data []byte) (int, error) {
	w.wroteHeader = true
	return w.ResponseWriter.Write(data)
}

func (w *panicSafeWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *panicSafeWriter) Flush() {
	w.wroteHeader = true
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}
