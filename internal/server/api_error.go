package server

import (
	"net/http"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

type apiErrorResponse struct {
	Error apperror.Detail `json:"error"`
}

func writeAPIError(w http.ResponseWriter, status int, code apperror.Code) {
	writeAPIDetail(w, status, apperror.DetailFor(code))
}

func writeAPIFieldError(w http.ResponseWriter, status int, code apperror.Code, field string) {
	writeAPIDetail(w, status, apperror.WithField(apperror.DetailFor(code), field))
}

func writeAPIDetail(w http.ResponseWriter, status int, detail apperror.Detail) {
	writeJSON(w, status, apiErrorResponse{Error: detail})
}

func writeRequestBoundaryError(w http.ResponseWriter, r *http.Request, status int, code apperror.Code) {
	detail := apperror.DetailFor(code)
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeAPIDetail(w, status, detail)
		return
	}
	http.Error(w, detail.Message, status)
}

func writeMethodNotAllowed(w http.ResponseWriter) {
	writeAPIError(w, http.StatusMethodNotAllowed, apperror.CodeMethodNotAllowed)
}

func writeResourceNotFound(w http.ResponseWriter) {
	writeAPIError(w, http.StatusNotFound, apperror.CodeResourceNotFound)
}
