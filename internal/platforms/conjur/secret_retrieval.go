package conjur

import (
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/cyberark/conjur-api-go/conjurapi"
	"github.com/cyberark/conjur-api-go/conjurapi/response"
)

// Explicit, one-at-a-time secret retrieval (ADR-043). Values bypass the
// generic run manager, History, SSE replay and the mutation journal.
const (
	secretRevealMaxBytes   = 16 << 10
	secretAccessLogLimit   = 200
	secretVersionListLimit = 100
)

type secretRetrievalClient interface {
	Resource(string) (map[string]interface{}, error)
	RetrieveSecretReader(string) (io.ReadCloser, error)
	RetrieveSecretWithVersionReader(string, int) (io.ReadCloser, error)
}

type SecretRetrievalService struct {
	loadConfig func() (conjurapi.Config, error)
	newClient  func(conjurapi.Config) (secretRetrievalClient, error)
	now        func() time.Time

	mu      sync.Mutex
	enabled bool
	log     []server.SecretAccessEntry
}

func NewSecretRetrievalService(snapshot discovery.Snapshot) *SecretRetrievalService {
	state, ok := snapshot.Find(discovery.ToolRef{PackID: PackID, ToolID: ToolID})
	return &SecretRetrievalService{
		enabled:    ok && state.Healthy(),
		loadConfig: loadConjurConfig,
		newClient: func(config conjurapi.Config) (secretRetrievalClient, error) {
			// Reuses the session the vendor CLI stored; CLIHarbor supplies no credential.
			return conjurapi.NewClientFromEnvironment(config)
		},
		now: time.Now,
	}
}

func (s *SecretRetrievalService) activate() {
	s.mu.Lock()
	s.enabled = true
	s.mu.Unlock()
}

func (s *SecretRetrievalService) Versions(request server.SecretRetrievalRequest) (server.SecretVersionsResponse, error) {
	out := server.SecretVersionsResponse{VariableID: request.VariableID, Versions: []server.SecretVersion{}}
	client, fullID, code, err := s.prepare(request)
	if err != nil || code != "" {
		out.FailureCode = code
		return out, err
	}
	resource, err := client.Resource(fullID)
	if err != nil {
		out.FailureCode = secretRetrievalCode(err)
		return out, nil
	}
	versions, ok := parseSecretVersions(resource["secrets"])
	if !ok {
		out.FailureCode = "invalid_response"
		return out, nil
	}
	out.Versions = versions
	return out, nil
}

func (s *SecretRetrievalService) Reveal(request server.SecretRetrievalRequest) (server.SecretRevealResponse, error) {
	out := server.SecretRevealResponse{VariableID: request.VariableID, Version: request.Version}
	client, fullID, code, err := s.prepare(request)
	if err != nil {
		return out, err
	}
	if code == "" {
		out.Value, code = readSecret(client, fullID, request.Version)
	}
	out.FailureCode = code
	outcome := code
	if outcome == "" {
		outcome = "revealed"
	}
	s.record(server.SecretAccessEntry{
		At: s.now().UTC().Format(time.RFC3339), Account: request.Account, ApplianceURL: request.ApplianceURL,
		VariableID: request.VariableID, Version: request.Version, Outcome: outcome,
	})
	return out, nil
}

func (s *SecretRetrievalService) AccessLog() []server.SecretAccessEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]server.SecretAccessEntry{}, s.log...)
}

func (s *SecretRetrievalService) record(entry server.SecretAccessEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log = append(s.log, entry)
	if len(s.log) > secretAccessLogLimit {
		s.log = append([]server.SecretAccessEntry{}, s.log[len(s.log)-secretAccessLogLimit:]...)
	}
}

// prepare re-resolves the vendor configuration and refuses unless it matches
// the account and endpoint the browser displayed. Browser input can never
// redirect vendor-owned tokens to another host.
func (s *SecretRetrievalService) prepare(request server.SecretRetrievalRequest) (secretRetrievalClient, string, string, error) {
	if err := server.ValidateSecretRetrievalRequest(request); err != nil {
		return nil, "", "", err
	}
	s.mu.Lock()
	enabled := s.enabled
	s.mu.Unlock()
	if !enabled || request.PackID != PackID || request.ToolID != ToolID {
		return nil, "", "", server.ErrSecretRetrievalUnavailable
	}
	config, err := s.loadConfig()
	if err != nil || !validConjurHTTPSURL(config.ApplianceURL) || !validConjurConfigScalar(config.Account) {
		return nil, "", "not_configured", nil
	}
	if strings.TrimRight(request.ApplianceURL, "/") != strings.TrimRight(config.ApplianceURL, "/") || request.Account != config.Account {
		return nil, "", "context_mismatch", nil
	}
	if config.HTTPTimeout <= 0 || config.HTTPTimeout > secretAuditHTTPTimeoutLimit {
		config.HTTPTimeout = secretAuditHTTPTimeoutLimit
	}
	client, err := s.newClient(config)
	if err != nil {
		return nil, "", "session_required", nil
	}
	// Always fully qualified: a bare ID shaped like "a:variable:b" would
	// otherwise be reinterpreted by the client library as another account.
	return client, config.Account + ":variable:" + request.VariableID, "", nil
}

func readSecret(client secretRetrievalClient, fullID string, version int) (string, string) {
	var reader io.ReadCloser
	var err error
	if version == 0 {
		reader, err = client.RetrieveSecretReader(fullID)
	} else {
		reader, err = client.RetrieveSecretWithVersionReader(fullID, version)
	}
	if err != nil {
		return "", secretRetrievalCode(err)
	}
	defer reader.Close()
	buf, err := io.ReadAll(io.LimitReader(reader, secretRevealMaxBytes+1))
	// Go cannot erase the string copy or vendor-library allocations; this drops what we own.
	defer clear(buf)
	switch {
	case err != nil:
		return "", "unavailable"
	case len(buf) > secretRevealMaxBytes:
		return "", "output_limit_exceeded"
	case !utf8.Valid(buf):
		return "", "not_text"
	}
	return string(buf), ""
}

// secretRetrievalCode classifies vendor failures without echoing their bodies.
// 403 stays "forbidden" so a denied read never looks like a missing secret.
func secretRetrievalCode(err error) string {
	var conjurErr *response.ConjurError
	if errors.As(err, &conjurErr) {
		switch conjurErr.Code {
		case http.StatusUnauthorized:
			return "session_required"
		case http.StatusForbidden:
			return "forbidden"
		case http.StatusNotFound:
			return "not_found"
		}
	}
	return "unavailable"
}

func parseSecretVersions(raw interface{}) ([]server.SecretVersion, bool) {
	if raw == nil {
		return []server.SecretVersion{}, true
	}
	items, ok := raw.([]interface{})
	if !ok {
		return nil, false
	}
	versions := make([]server.SecretVersion, 0, len(items))
	seen := map[int]bool{}
	for _, item := range items {
		record, ok := item.(map[string]interface{})
		if !ok {
			return nil, false
		}
		number, ok := record["version"].(float64)
		if !ok || number < 1 || number > (1<<20) || number != float64(int(number)) || seen[int(number)] {
			return nil, false
		}
		seen[int(number)] = true
		version := server.SecretVersion{Version: int(number)}
		switch expires := record["expires_at"].(type) {
		case nil:
		case string:
			if _, err := time.Parse(time.RFC3339, expires); err != nil {
				return nil, false
			}
			version.ExpiresAt = expires
		default:
			return nil, false
		}
		versions = append(versions, version)
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i].Version > versions[j].Version })
	if len(versions) > secretVersionListLimit {
		versions = versions[:secretVersionListLimit]
	}
	return versions, true
}
