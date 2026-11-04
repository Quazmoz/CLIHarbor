package server

import (
	"errors"
	"net/http"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
	"github.com/Quazmoz/CLIHarbor/internal/passwordshare"
)

func (s *Server) handlePasswordSharing(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		writeAPIError(w, 400, apperror.CodeInvalidRequest)
		return
	}
	if r.URL.Path == "/api/v1/password-sharing" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeMethodNotAllowed(w)
			return
		}
		writeJSON(w, 200, s.passwordSharing.Status())
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeMethodNotAllowed(w)
		return
	}
	var err error
	switch r.URL.Path {
	case "/api/v1/password-sharing/create":
		var request struct {
			Address string `json:"address"`
			Mode    string `json:"mode"`
		}
		if decodeStrictJSON(w, r, &request) != nil {
			writeAPIError(w, 400, apperror.CodeInvalidRequest)
			return
		}
		var invitation passwordshare.Invitation
		invitation, err = s.passwordSharing.Create(request.Address, request.Mode)
		if err == nil {
			writeJSON(w, 201, invitation)
			return
		}
	case "/api/v1/password-sharing/cancel", "/api/v1/password-sharing/reveal":
		var request struct {
			ID string `json:"id"`
		}
		if decodeStrictJSON(w, r, &request) != nil || len(request.ID) != 22 {
			writeAPIError(w, 400, apperror.CodeInvalidRequest)
			return
		}
		if r.URL.Path == "/api/v1/password-sharing/cancel" {
			err = s.passwordSharing.Cancel(request.ID)
			if err == nil {
				w.WriteHeader(204)
				return
			}
		} else {
			var password []byte
			password, err = s.passwordSharing.Take(request.ID)
			defer clear(password)
			if err == nil {
				writeJSON(w, 200, struct {
					Password string `json:"password"`
				}{string(password)})
				return
			}
		}
	case "/api/v1/password-sharing/inspect":
		var request struct {
			Invitation string `json:"invitation"`
		}
		if decodeStrictJSON(w, r, &request) != nil {
			writeAPIError(w, 400, apperror.CodeInvalidRequest)
			return
		}
		u, _, pin, parseErr := s.passwordSharing.ParseInvitation(request.Invitation)
		err = parseErr
		if err == nil {
			writeJSON(w, 200, struct {
				Origin      string `json:"origin"`
				Fingerprint string `json:"fingerprint"`
			}{u.String(), pin})
			return
		}
	case "/api/v1/password-sharing/send":
		var request struct {
			Invitation string `json:"invitation"`
			Password   string `json:"password"`
			Confirmed  bool   `json:"confirmed"`
		}
		if decodeStrictJSON(w, r, &request) != nil || !request.Confirmed {
			writeAPIError(w, 400, apperror.CodeInvalidRequest)
			return
		}
		password := []byte(request.Password)
		request.Password = ""
		defer clear(password)
		err = s.passwordSharing.Send(r.Context(), request.Invitation, password)
		if err == nil {
			w.WriteHeader(204)
			return
		}
	default:
		writeAPIError(w, 404, apperror.CodeResourceNotFound)
		return
	}
	switch {
	case errors.Is(err, passwordshare.ErrInvalid):
		writeAPIError(w, 400, apperror.CodeInvalidRequest)
	case errors.Is(err, passwordshare.ErrBusy):
		writeAPIError(w, 409, apperror.CodePasswordShareBusy)
	case errors.Is(err, passwordshare.ErrGone):
		writeAPIError(w, 410, apperror.CodePasswordShareGone)
	case errors.Is(err, passwordshare.ErrUnconfirmed):
		writeAPIError(w, 502, apperror.CodePasswordDeliveryUnconfirmed)
	default:
		writeAPIError(w, 503, apperror.CodePasswordShareUnavailable)
	}
}
