package app

import (
	"context"
	"net/url"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/cyberark/conjur-api-go/conjurapi"
)

const (
	conjurCredentialPackID             = "cyberark-conjur-v9"
	conjurCredentialToolID             = "conjur"
	credentialLoginHTTPTimeoutSeconds  = 20
)

type conjurLoginClient interface {
	Login(string, string) ([]byte, error)
}

type conjurCredentialLoginService struct {
	enabled    bool
	loginGate  chan struct{}
	loadConfig func() (conjurapi.Config, error)
	newClient  func(conjurapi.Config) (conjurLoginClient, error)
}

func newConjurCredentialLoginService(snapshot discovery.Snapshot) *conjurCredentialLoginService {
	state, ok := snapshot.Find(discovery.ToolRef{PackID: conjurCredentialPackID, ToolID: conjurCredentialToolID})
	return &conjurCredentialLoginService{
		enabled:   ok && state.Healthy(),
		loginGate: make(chan struct{}, 1),
		loadConfig: conjurapi.LoadConfig,
		newClient: func(config conjurapi.Config) (conjurLoginClient, error) {
			return conjurapi.NewClient(config)
		},
	}
}

func (s *conjurCredentialLoginService) Capability() (string, string, server.CredentialLoginCapability, bool) {
	if s == nil || !s.enabled {
		return "", "", server.CredentialLoginCapability{}, false
	}
	config, err := s.loadConfig()
	if err != nil || !supportsConjurPasswordLogin(config) {
		return "", "", server.CredentialLoginCapability{}, false
	}
	return conjurCredentialPackID, conjurCredentialToolID, server.CredentialLoginCapability{
		Method: server.CredentialLoginMethodConjurPassword,
	}, true
}

func (s *conjurCredentialLoginService) Login(ctx context.Context, request server.CredentialLoginRequest) error {
	if s == nil || !s.enabled || request.PackID != conjurCredentialPackID || request.ToolID != conjurCredentialToolID {
		return &server.CredentialLoginError{Code: server.CredentialLoginUnsupported}
	}

	select {
	case s.loginGate <- struct{}{}:
		defer func() { <-s.loginGate }()
	default:
		return &server.CredentialLoginError{Code: server.CredentialLoginBusy}
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
	for i := range apiKey {
		apiKey[i] = 0
	}
	if err != nil {
		return &server.CredentialLoginError{Code: server.CredentialLoginRejected}
	}
	return nil
}

func supportsConjurPasswordLogin(config conjurapi.Config) bool {
	if config.IsSaaS() {
		return false
	}
	applianceURL, err := url.Parse(config.ApplianceURL)
	if err != nil || !strings.EqualFold(applianceURL.Scheme, "https") || applianceURL.Host == "" {
		return false
	}

	authnType := strings.ToLower(strings.TrimSpace(config.AuthnType))
	switch authnType {
	case "", "authn", "ldap":
	default:
		return false
	}
	if config.CredentialStorage == conjurapi.CredentialStorageNone {
		return false
	}
	return config.CredentialStorageMode != conjurapi.CredentialStorageModeReadOnly
}
