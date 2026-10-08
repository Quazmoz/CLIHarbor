package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
)

const maxCredentialConfigurationRequestBytes = 8 << 10

type CredentialConfigurationRequest struct {
	PackID               string
	ToolID               string
	Environment          string
	ApplianceURL         string
	ExpectedApplianceURL string
	Account              string
	AuthnType            string
	ServiceID            string
}

// Read-only, sanitized vendor connection metadata. Credentials and filesystem
// paths never cross this browser boundary.
type CredentialConnection struct {
	Environment  string `json:"environment"`
	ApplianceURL string `json:"applianceUrl"`
	Account      string `json:"account"`
	Configurable bool   `json:"configurable"`
}

type CredentialConnectionReader interface {
	Connection() (CredentialConnection, error)
}

type CredentialConfigurationService interface {
	Configure(context.Context, CredentialConfigurationRequest) error
}

type credentialConfigurationRequestDTO struct {
	PackID               string `json:"packId"`
	ToolID               string `json:"toolId"`
	Environment          string `json:"environment,omitempty"`
	ApplianceURL         string `json:"applianceUrl"`
	ExpectedApplianceURL string `json:"expectedApplianceUrl,omitempty"`
	Account              string `json:"account"`
	AuthnType            string `json:"authnType"`
	ServiceID            string `json:"serviceId,omitempty"`
}

func (s *Server) handleCredentialConfiguration(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		reader, ok := s.credentialConfiguration.(CredentialConnectionReader)
		if !ok {
			writeAPIError(w, http.StatusConflict, apperror.CodeAuthenticationUnsupported)
			return
		}
		connection, err := reader.Connection()
		if err != nil {
			writeCredentialLoginError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, connection)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeMethodNotAllowed(w)
		return
	}

	request, err := decodeCredentialConfigurationRequest(w, r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, apperror.CodeInvalidRequest)
		return
	}

	// Vendor connection setup may legitimately outlast the server-wide 30s
	// WriteTimeout; without this the browser sees a reset for a setup that succeeded.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(slowResponseWriteTimeout))
	err = s.credentialConfiguration.Configure(r.Context(), CredentialConfigurationRequest{
		PackID:               request.PackID,
		ToolID:               request.ToolID,
		Environment:          request.Environment,
		ApplianceURL:         request.ApplianceURL,
		ExpectedApplianceURL: request.ExpectedApplianceURL,
		Account:              request.Account,
		AuthnType:            request.AuthnType,
		ServiceID:            request.ServiceID,
	})
	if err != nil {
		writeCredentialLoginError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func decodeCredentialConfigurationRequest(w http.ResponseWriter, r *http.Request) (credentialConfigurationRequestDTO, error) {
	var zero credentialConfigurationRequestDTO
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return zero, fmt.Errorf("content type must be application/json")
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxCredentialConfigurationRequestBytes)
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
	var request credentialConfigurationRequestDTO
	if err := decoder.Decode(&request); err != nil {
		return zero, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return zero, err
	}

	request.ApplianceURL = strings.TrimSpace(request.ApplianceURL)
	request.ExpectedApplianceURL = strings.TrimSpace(request.ExpectedApplianceURL)
	request.Environment = strings.ToLower(strings.TrimSpace(request.Environment))
	request.Account = strings.TrimSpace(request.Account)
	request.AuthnType = strings.ToLower(strings.TrimSpace(request.AuthnType))
	request.ServiceID = strings.TrimSpace(request.ServiceID)

	if !validCredentialTargetID(request.PackID) || !validCredentialTargetID(request.ToolID) {
		return zero, fmt.Errorf("invalid credential target")
	}
	if err := validateCredentialConfigurationURL(request.ApplianceURL); err != nil {
		return zero, err
	}
	if request.ExpectedApplianceURL != "" {
		if err := validateCredentialConfigurationURL(request.ExpectedApplianceURL); err != nil {
			return zero, fmt.Errorf("invalid expected connection URL")
		}
	}
	if request.Environment == "saas" {
		if request.Account != "conjur" || request.AuthnType != "cloud" || request.ServiceID != "" {
			return zero, fmt.Errorf("invalid SaaS connection parameters")
		}
		return request, nil
	}
	if request.Environment != "" {
		return zero, fmt.Errorf("unsupported environment")
	}
	if request.ExpectedApplianceURL != "" {
		return zero, fmt.Errorf("self-hosted connection replacement is not supported")
	}
	if request.Account == "" || len(request.Account) > 256 || containsControlCharacter(request.Account) {
		return zero, fmt.Errorf("invalid account")
	}
	switch request.AuthnType {
	case "authn":
		if request.ServiceID != "" {
			return zero, fmt.Errorf("standard authentication must not include a service ID")
		}
	case "ldap":
		if request.ServiceID == "" || len(request.ServiceID) > 256 || containsControlCharacter(request.ServiceID) {
			return zero, fmt.Errorf("LDAP authentication requires a valid service ID")
		}
	default:
		return zero, fmt.Errorf("unsupported authentication type")
	}

	return request, nil
}

func validateCredentialConfigurationURL(value string) error {
	if value == "" || len(value) > 2048 || containsControlCharacter(value) {
		return fmt.Errorf("invalid appliance URL")
	}
	parsed, err := url.Parse(value)
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.Host == "" || parsed.User != nil {
		return fmt.Errorf("appliance URL must be an HTTPS URL without user information")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("appliance URL must not include a query or fragment")
	}
	return nil
}
