package app

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/cyberark/conjur-api-go/conjurapi"
	"github.com/cyberark/conjur-api-go/conjurapi/response"
)

const (
	conjurCredentialPackID            = "cyberark-conjur-v9"
	conjurCredentialToolID            = "conjur"
	credentialLoginHTTPTimeoutSeconds = 20
	conjurConnectionSetupTimeout      = 45 * time.Second
	conjurConnectionSetupWaitDelay    = 2 * time.Second
)

type conjurLoginClient interface {
	Login(string, string) ([]byte, error)
}

type conjurCredentialLoginService struct {
	enabled      bool
	toolPath     string
	toolIdentity discovery.ExecutableIdentity
	authGate     chan struct{}
	loadConfig   func() (conjurapi.Config, error)
	newClient    func(conjurapi.Config) (conjurLoginClient, error)
	runInit      func(context.Context, string, []string) error
}

func newConjurCredentialLoginService(snapshot discovery.Snapshot) *conjurCredentialLoginService {
	state, ok := snapshot.Find(discovery.ToolRef{PackID: conjurCredentialPackID, ToolID: conjurCredentialToolID})
	service := &conjurCredentialLoginService{
		enabled:    ok && state.Healthy(),
		authGate:   make(chan struct{}, 1),
		loadConfig: conjurapi.LoadConfig,
		newClient: func(config conjurapi.Config) (conjurLoginClient, error) {
			return conjurapi.NewClient(config)
		},
		runInit: runConjurConnectionInit,
	}
	if ok {
		service.toolPath = state.Path
		service.toolIdentity = state.ExecutableIdentity
	}
	return service
}

func (s *conjurCredentialLoginService) Capability() (string, string, server.CredentialLoginCapability, bool) {
	if s == nil || !s.enabled {
		return "", "", server.CredentialLoginCapability{}, false
	}
	config, err := s.loadConfig()
	if err != nil {
		return "", "", server.CredentialLoginCapability{}, false
	}
	if supportsConjurPasswordLogin(config) {
		return conjurCredentialPackID, conjurCredentialToolID, server.CredentialLoginCapability{
			Method: server.CredentialLoginMethodConjurPassword,
		}, true
	}
	if conjurConnectionSetupRequired(config) {
		return conjurCredentialPackID, conjurCredentialToolID, server.CredentialLoginCapability{
			Method:        server.CredentialLoginMethodConjurPassword,
			SetupRequired: true,
		}, true
	}
	return "", "", server.CredentialLoginCapability{}, false
}

func (s *conjurCredentialLoginService) Configure(ctx context.Context, request server.CredentialConfigurationRequest) error {
	if s == nil || !s.enabled || request.PackID != conjurCredentialPackID || request.ToolID != conjurCredentialToolID {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	if !validConjurConnectionRequest(request) {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	if !s.acquireAuthGate() {
		return &server.CredentialLoginError{Code: server.CredentialLoginBusy}
	}
	defer s.releaseAuthGate()

	select {
	case <-ctx.Done():
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	default:
	}

	config, err := s.loadConfig()
	if err != nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}
	if supportsConjurPasswordLogin(config) {
		return nil
	}
	if !conjurConnectionSetupRequired(config) || s.toolPath == "" || !s.toolIdentity.Valid() || !s.toolIdentity.Matches(s.toolPath) {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}

	args := []string{
		"init",
		"self-hosted",
		"--url", request.ApplianceURL,
		"--account", request.Account,
	}
	if request.AuthnType == "ldap" {
		args = append(args, "--authn-type", "ldap", "--service-id", request.ServiceID)
	}

	initErr := s.runInit(ctx, s.toolPath, args)

	// Reconcile authoritative vendor configuration even when the process reports
	// an error. The CLI may have durably written configuration immediately
	// before a cancellation/timeout or a later output/lifecycle failure.
	config, loadErr := s.loadConfig()
	if loadErr == nil && conjurConfigMatchesConnectionRequest(config, request) {
		return nil
	}
	if initErr != nil || loadErr != nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}
	return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
}

func (s *conjurCredentialLoginService) Login(ctx context.Context, request server.CredentialLoginRequest) error {
	if s == nil || !s.enabled || request.PackID != conjurCredentialPackID || request.ToolID != conjurCredentialToolID {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	if !s.acquireAuthGate() {
		return &server.CredentialLoginError{Code: server.CredentialLoginBusy}
	}
	defer s.releaseAuthGate()

	select {
	case <-ctx.Done():
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	default:
	}

	config, err := s.loadConfig()
	if err != nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}
	if !supportsConjurPasswordLogin(config) {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	if config.HTTPTimeout <= 0 || config.HTTPTimeout > credentialLoginHTTPTimeoutSeconds {
		config.HTTPTimeout = credentialLoginHTTPTimeoutSeconds
	}

	client, err := s.newClient(config)
	if err != nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}

	apiKey, err := client.Login(request.Identity, request.Secret)
	hadAPIKey := len(apiKey) > 0
	for i := range apiKey {
		apiKey[i] = 0
	}
	if err != nil {
		return &server.CredentialLoginError{Code: classifyConjurCredentialLoginError(hadAPIKey, err)}
	}
	return nil
}

func classifyConjurCredentialLoginError(hadAPIKey bool, err error) server.CredentialLoginErrorCode {
	// A returned API key means the remote credential exchange succeeded and a
	// later local step (for example credential persistence) failed. Never tell
	// the operator to re-enter a password for that condition.
	if hadAPIKey {
		return server.CredentialLoginUnavailable
	}

	var conjurErr *response.ConjurError
	if errors.As(err, &conjurErr) && conjurErr.Code == http.StatusUnauthorized {
		return server.CredentialLoginRejected
	}

	// Network/TLS/timeouts, non-401 server responses, malformed responses and
	// local storage/configuration failures are availability problems. Keep the
	// vendor error body private and avoid misclassifying them as bad passwords.
	return server.CredentialLoginUnavailable
}

func (s *conjurCredentialLoginService) acquireAuthGate() bool {
	if s == nil {
		return false
	}
	select {
	case s.authGate <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *conjurCredentialLoginService) releaseAuthGate() {
	<-s.authGate
}

func runConjurConnectionInit(ctx context.Context, executable string, args []string) error {
	runCtx, cancel := context.WithTimeout(ctx, conjurConnectionSetupTimeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, executable, args...)
	cmd.Stdin = nil
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	cmd.WaitDelay = conjurConnectionSetupWaitDelay
	return cmd.Run()
}

func validConjurConnectionRequest(request server.CredentialConfigurationRequest) bool {
	if !validConjurHTTPSURL(request.ApplianceURL) || !validConjurConfigScalar(request.Account) {
		return false
	}
	switch request.AuthnType {
	case "authn":
		return request.ServiceID == ""
	case "ldap":
		return validConjurConfigScalar(request.ServiceID)
	default:
		return false
	}
}

func conjurConnectionSetupRequired(config conjurapi.Config) bool {
	if config.IsSaaS() ||
		config.CredentialStorage == conjurapi.CredentialStorageNone ||
		config.CredentialStorageMode == conjurapi.CredentialStorageModeReadOnly {
		return false
	}

	applianceURL := strings.TrimSpace(config.ApplianceURL)
	account := strings.TrimSpace(config.Account)
	if applianceURL != "" && !validConjurHTTPSURL(config.ApplianceURL) {
		return false
	}
	if account != "" && !validConjurConfigScalar(config.Account) {
		return false
	}

	authnType := strings.ToLower(strings.TrimSpace(config.AuthnType))
	switch authnType {
	case "", "authn", "ldap":
	default:
		return false
	}
	if authnType == "ldap" {
		serviceID := strings.TrimSpace(config.ServiceID)
		if serviceID != "" && !validConjurConfigScalar(config.ServiceID) {
			return false
		}
		if serviceID == "" {
			return true
		}
	}

	return applianceURL == "" || account == ""
}

func conjurConfigMatchesConnectionRequest(config conjurapi.Config, request server.CredentialConfigurationRequest) bool {
	if !supportsConjurPasswordLogin(config) ||
		config.ApplianceURL != request.ApplianceURL ||
		config.Account != request.Account {
		return false
	}

	authnType := strings.ToLower(strings.TrimSpace(config.AuthnType))
	switch request.AuthnType {
	case "authn":
		return (authnType == "" || authnType == "authn") && strings.TrimSpace(config.ServiceID) == ""
	case "ldap":
		return authnType == "ldap" && config.ServiceID == request.ServiceID
	default:
		return false
	}
}

func supportsConjurPasswordLogin(config conjurapi.Config) bool {
	if config.IsSaaS() ||
		config.CredentialStorage == conjurapi.CredentialStorageNone ||
		config.CredentialStorageMode == conjurapi.CredentialStorageModeReadOnly ||
		!validConjurHTTPSURL(config.ApplianceURL) ||
		!validConjurConfigScalar(config.Account) {
		return false
	}

	authnType := strings.ToLower(strings.TrimSpace(config.AuthnType))
	switch authnType {
	case "", "authn":
		return true
	case "ldap":
		return validConjurConfigScalar(config.ServiceID)
	default:
		return false
	}
}

func validConjurHTTPSURL(value string) bool {
	if strings.TrimSpace(value) != value || value == "" || len(value) > 2048 {
		return false
	}
	for _, r := range value {
		if r <= 0x1f || r == 0x7f {
			return false
		}
	}

	applianceURL, err := url.Parse(value)
	return err == nil &&
		strings.EqualFold(applianceURL.Scheme, "https") &&
		applianceURL.Host != "" &&
		applianceURL.User == nil &&
		applianceURL.RawQuery == "" &&
		applianceURL.Fragment == ""
}

func validConjurConfigScalar(value string) bool {
	if strings.TrimSpace(value) != value || value == "" || len(value) > 256 {
		return false
	}
	for _, r := range value {
		if r <= 0x1f || r == 0x7f {
			return false
		}
	}
	return true
}
