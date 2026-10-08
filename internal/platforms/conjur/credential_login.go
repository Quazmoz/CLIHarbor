package conjur

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
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

var conjurSaaSTenantHost = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.secretsmgr\.cyberark\.cloud$`)

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
	if !s.executableReady() {
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

// Connection reports only non-secret configuration data from the vendor's
// authoritative config loader. It never invents a profile or stores a URL.
func (s *CredentialLoginService) Connection() (server.CredentialConnection, error) {
	if s == nil {
		return server.CredentialConnection{}, &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.executableReady() {
		return server.CredentialConnection{}, &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	config, err := s.loadConfig()
	if err != nil {
		return server.CredentialConnection{}, &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}
	environment := "other"
	configurable := false
	switch {
	case config.IsSaaS():
		environment = "saas"
		configurable = supportsConjurVendorLogin(config) && !conjurConfigEnvOverride()
	case conjurBlankConfig(config):
		environment = "unconfigured"
		configurable = !conjurConfigEnvOverride() && writableConjurCredentials(config)
	case supportsConjurPasswordLogin(config):
		environment = "self-hosted"
	}
	if config.ApplianceURL != "" && !validConjurHTTPSURL(config.ApplianceURL) {
		return server.CredentialConnection{}, &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}
	if config.Account != "" && !validConjurConfigScalar(config.Account) {
		return server.CredentialConnection{}, &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}
	return server.CredentialConnection{
		Environment: environment, ApplianceURL: config.ApplianceURL,
		Account: config.Account, Configurable: configurable,
	}, nil
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

	if !s.executableReady() {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}

	select {
	case <-ctx.Done():
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	default:
	}

	config, err := s.loadConfig()
	if err != nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}
	// An exact match is idempotent. Changes to an existing SaaS connection
	// require a browser-confirmed compare-and-swap target, never implicit force.
	if request.Environment == "saas" {
		return s.configureSaaS(ctx, config, request)
	}
	if conjurConfigMatchesConnectionRequest(config, request) {
		return nil
	}
	if !conjurConnectionSetupRequired(config) {
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

func writableConjurCredentials(config conjurapi.Config) bool {
	return config.CredentialStorage != conjurapi.CredentialStorageNone &&
		config.CredentialStorageMode != conjurapi.CredentialStorageModeReadOnly
}

func conjurBlankConfig(config conjurapi.Config) bool {
	return config.ApplianceURL == "" && config.Account == "" &&
		config.AuthnType == "" && config.ServiceID == "" && config.Environment == ""
}

// Environment overrides are not writable using conjur init; attempting to
// change them would write .conjurrc but leave the effective endpoint unchanged.
func conjurConfigEnvOverride() bool {
	for _, key := range []string{"CONJUR_APPLIANCE_URL", "CONJUR_ACCOUNT", "CONJUR_AUTHN_TYPE", "CONJUR_SERVICE_ID", "CONJUR_ENVIRONMENT"} {
		if _, present := os.LookupEnv(key); present {
			return true
		}
	}
	return false
}

func canonicalConjurSaaSURL(value string) (string, bool) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil ||
		u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" ||
		u.Host != u.Hostname() || !conjurSaaSTenantHost.MatchString(u.Hostname()) ||
		(u.Path != "" && u.Path != "/" && u.Path != "/api") || u.RawPath != "" {
		return "", false
	}
	return "https://" + u.Hostname() + "/api", true
}

func conjurSaaSMatches(config conjurapi.Config, expectedURL string) bool {
	return config.IsSaaS() && strings.EqualFold(strings.TrimSpace(config.AuthnType), "cloud") &&
		config.Account == "conjur" && config.ServiceID == "cyberark" &&
		config.ApplianceURL == expectedURL && writableConjurCredentials(config)
}

func (s *CredentialLoginService) configureSaaS(
	ctx context.Context, current conjurapi.Config, request server.CredentialConfigurationRequest,
) error {
	want, ok := canonicalConjurSaaSURL(request.ApplianceURL)
	if !ok || conjurConfigEnvOverride() || !writableConjurCredentials(current) {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}
	if conjurSaaSMatches(current, want) {
		return nil
	}
	replacing := current.IsSaaS()
	if replacing {
		oldURL, ok := canonicalConjurSaaSURL(request.ExpectedApplianceURL)
		if !ok || request.ExpectedApplianceURL != current.ApplianceURL ||
			!conjurSaaSMatches(current, oldURL) || want == oldURL {
			return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
		}
	} else if !conjurBlankConfig(current) || request.ExpectedApplianceURL != "" {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}

	args := []string{"init", "saas", "--url", strings.TrimSuffix(want, "/api")}
	if replacing {
		// Only exact, confirmed SaaS -> SaaS replacement uses vendor --force;
		// no arbitrary flags, local file edits, or silent overwrite.
		args = append(args, "--force")
	}
	initErr := s.runInit(ctx, s.toolPath, args)
	updated, err := s.loadConfig()
	if err == nil && conjurSaaSMatches(updated, want) {
		return nil // Reconcile timeout-after-durable vendor write.
	}
	if initErr != nil || err != nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}
	return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
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

	if !s.executableReady() {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}

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
	// A password exchanged for the previous Conjur account must not be treated
	// as a successful login to a different account after an external config edit.
	updated, loadErr := s.loadConfig()
	if loadErr != nil || !sameConjurPasswordAuthContext(config, updated) {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
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

	if !s.executableReady() {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	}

	select {
	case <-ctx.Done():
		return &server.CredentialLoginError{Code: server.CredentialLoginUnavailable}
	default:
	}

	config, err := s.loadConfig()
	if err != nil || !supportsConjurVendorLogin(config) {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
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

// executableReady is the same trusted executable-identity boundary for all
// browser credential capabilities, configuration, and sign-in operations.
// A previously healthy discovery snapshot does not authorize a replaced file.
func (s *CredentialLoginService) executableReady() bool {
	return s.enabled && s.toolPath != "" && s.toolIdentity.Valid() && s.toolIdentity.Matches(s.toolPath)
}

func sameConjurPasswordAuthContext(before, after conjurapi.Config) bool {
	return before.ApplianceURL == after.ApplianceURL &&
		before.Account == after.Account &&
		strings.EqualFold(strings.TrimSpace(before.AuthnType), strings.TrimSpace(after.AuthnType)) &&
		before.ServiceID == after.ServiceID &&
		before.Environment == after.Environment &&
		before.CredentialStorage == after.CredentialStorage &&
		before.CredentialStorageMode == after.CredentialStorageMode
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
	if request.Environment == "saas" {
		_, ok := canonicalConjurSaaSURL(request.ApplianceURL)
		return ok && request.Account == "conjur" && request.AuthnType == "cloud" && request.ServiceID == ""
	}
	if request.Environment != "" || request.ExpectedApplianceURL != "" ||
		!validConjurHTTPSURL(request.ApplianceURL) || !validConjurConfigScalar(request.Account) {
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
