package conjur

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/platform/terminal"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/cyberark/conjur-api-go/conjurapi"
	"github.com/cyberark/conjur-api-go/conjurapi/response"
)

const (
	PackID                            = "cyberark-conjur-v9"
	ToolID                            = "conjur"
	credentialLoginHTTPTimeoutSeconds = 20
	conjurConnectionSetupTimeout      = 45 * time.Second
	conjurConnectionSetupWaitDelay    = 2 * time.Second
)

type conjurLoginClient interface {
	Login(string, string) ([]byte, error)
}

type CredentialLoginService struct {
	mu                   sync.RWMutex
	enabled              bool
	toolPath             string
	toolIdentity         discovery.ExecutableIdentity
	authGate             chan struct{}
	loadConfig           func() (conjurapi.Config, error)
	newClient            func(conjurapi.Config) (conjurLoginClient, error)
	runInit              func(context.Context, string, []string) error
	interactiveSupported func() bool
	launchInteractive    func(string, []string) error
	launchBackground     func(string, []string) error
}

func NewCredentialLoginService(snapshot discovery.Snapshot) *CredentialLoginService {
	state, ok := snapshot.Find(discovery.ToolRef{PackID: PackID, ToolID: ToolID})
	service := &CredentialLoginService{
		enabled:    ok && state.Healthy(),
		authGate:   make(chan struct{}, 1),
		loadConfig: conjurapi.LoadConfig,
		newClient: func(config conjurapi.Config) (conjurLoginClient, error) {
			return conjurapi.NewClient(config)
		},
		runInit:              runConjurConnectionInit,
		interactiveSupported: terminal.Supported,
		launchBackground:     terminal.LaunchHidden,
	}
	if ok {
		service.toolPath = state.Path
		service.toolIdentity = state.ExecutableIdentity
	}
	service.launchInteractive = func(executable string, args []string) error {
		return terminal.Launch(executable, args, service.toolIdentity)
	}
	return service
}

func (s *CredentialLoginService) Capability() (string, string, server.CredentialLoginCapability, bool) {
	if s == nil {
		return "", "", server.CredentialLoginCapability{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.enabled {
		return "", "", server.CredentialLoginCapability{}, false
	}
	config, err := s.loadConfig()
	if err != nil {
		return "", "", server.CredentialLoginCapability{}, false
	}
	if supportsConjurPasswordLogin(config) {
		return PackID, ToolID, server.CredentialLoginCapability{
			Method: server.CredentialLoginMethodConjurPassword,
		}, true
	}
	if conjurConnectionSetupRequired(config) {
		return PackID, ToolID, server.CredentialLoginCapability{
			Method:        server.CredentialLoginMethodConjurPassword,
			SetupRequired: true,
		}, true
	}
	if s.interactiveSupported != nil && s.interactiveSupported() && supportsConjurVendorLogin(config) {
		return PackID, ToolID, server.CredentialLoginCapability{
			Method: server.CredentialLoginMethodConjurVendorLogin,
		}, true
	}
	return "", "", server.CredentialLoginCapability{}, false
}

func (s *CredentialLoginService) Configure(ctx context.Context, request server.CredentialConfigurationRequest) error {
	if s == nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.enabled || request.PackID != PackID || request.ToolID != ToolID {
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
	// Idempotent only for the same connection; a different server/account against
	// an existing configuration must not be reported as saved.
	if conjurConfigMatchesConnectionRequest(config, request) {
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

	if initErr := s.runInit(ctx, s.toolPath, args); initErr != nil {
		// Reconcile authoritative vendor configuration before reporting failure.
		// The CLI may have durably written configuration immediately before a
		// cancellation/timeout or a later output/lifecycle failure.
		config, loadErr := s.loadConfig()
		if loadErr == nil && conjurConfigMatchesConnectionRequest(config, request) {
			return nil
		}
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}

	config, err = s.loadConfig()
	if err != nil || !conjurConfigMatchesConnectionRequest(config, request) {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}
	return nil
}

func (s *CredentialLoginService) Login(ctx context.Context, request server.CredentialLoginRequest) error {
	if s == nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.enabled || request.PackID != PackID || request.ToolID != ToolID {
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

func (s *CredentialLoginService) LaunchInteractive(ctx context.Context, request server.CredentialInteractiveLoginRequest) error {
	if s == nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.enabled || request.PackID != PackID || request.ToolID != ToolID {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	if s.interactiveSupported == nil || !s.interactiveSupported() || s.launchInteractive == nil {
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
	if err != nil || !supportsConjurVendorLogin(config) {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	if s.toolPath == "" || !s.toolIdentity.Valid() || !s.toolIdentity.Matches(s.toolPath) {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}
	// The reviewed upstream Conjur 9.x login command owns OIDC/JWT/SaaS
	// interaction and vendor credential persistence. CLIHarbor supplies no
	// identity, password, token, URL, or browser-auth data in argv.
	//
	// OIDC opens its own browser callback flow and JWT consumes its configured
	// JWT source, so neither needs a visible console. SaaS/cloud authentication
	// can legitimately prompt for passwords, MFA mechanisms, OTP/PIN values,
	// security questions, or other interactive challenges; keep that flow in a
	// separate vendor-owned terminal instead of routing those secrets through
	// CLIHarbor.
	launcher := s.launchInteractive
	authnType := strings.ToLower(strings.TrimSpace(config.AuthnType))
	if authnType == "oidc" || authnType == "jwt" {
		launcher = s.launchBackground
	}
	if launcher == nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	if err := launcher(s.toolPath, []string{"login"}); err != nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}
	return nil
}

func (s *CredentialLoginService) activateTool(state discovery.ToolState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.enabled = state.Healthy()
	s.toolPath, s.toolIdentity = state.Path, state.ExecutableIdentity
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

func (s *CredentialLoginService) acquireAuthGate() bool {
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

func (s *CredentialLoginService) releaseAuthGate() {
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

func supportsConjurVendorLogin(config conjurapi.Config) bool {
	if config.CredentialStorage == conjurapi.CredentialStorageNone ||
		config.CredentialStorageMode == conjurapi.CredentialStorageModeReadOnly ||
		!validConjurHTTPSURL(config.ApplianceURL) ||
		!validConjurConfigScalar(config.Account) {
		return false
	}

	authnType := strings.ToLower(strings.TrimSpace(config.AuthnType))
	switch authnType {
	case "cloud":
		return config.IsSaaS()
	case "oidc":
		return validConjurConfigScalar(config.Account) && validConjurConfigScalar(config.ServiceID)
	case "jwt":
		return validConjurConfigScalar(config.Account) &&
			validConjurConfigScalar(config.ServiceID) &&
			(config.JWTContent != "" || strings.TrimSpace(config.JWTFilePath) != "")
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
