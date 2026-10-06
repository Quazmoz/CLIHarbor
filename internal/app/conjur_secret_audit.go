package app

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/cyberark/conjur-api-go/conjurapi"
	"github.com/cyberark/conjur-api-go/conjurapi/response"
)

// Port of tools/audit-conjur-secret-values.ps1 for the browser. Secret values
// are classified in backend memory, zeroed, and dropped.
// Only identifiers and closed reason codes reach the snapshot.
const (
	secretAuditMaxVariables     = 50000
	secretAuditListPageSize     = 500
	secretAuditBatchSize        = 50
	secretAuditMaxBatchQuery    = 6000
	secretAuditMaxValueBytes    = 1 << 20
	secretAuditHTTPTimeoutLimit = 30
)

type secretAuditClient interface {
	ResourcesCount(*conjurapi.ResourceFilter) (*conjurapi.ResourcesCount, error)
	Resources(*conjurapi.ResourceFilter) ([]map[string]interface{}, error)
	RetrieveBatchSecretsSafe([]string) (map[string][]byte, error)
	RetrieveSecret(string) ([]byte, error)
}

type secretAuditFailure struct{ code string }

func (f secretAuditFailure) Error() string { return f.code }

type conjurSecretAuditService struct {
	enabled    bool
	parent     context.Context
	loadConfig func() (conjurapi.Config, error)
	newClient  func(conjurapi.Config) (secretAuditClient, error)
	now        func() time.Time

	mu     sync.Mutex
	snap   server.SecretAuditSnapshot
	cancel context.CancelFunc
	done   chan struct{}
}

func newConjurSecretAuditService(ctx context.Context, snapshot discovery.Snapshot) *conjurSecretAuditService {
	state, ok := snapshot.Find(discovery.ToolRef{PackID: conjurCredentialPackID, ToolID: conjurCredentialToolID})
	return &conjurSecretAuditService{
		enabled:    ok && state.Healthy(),
		parent:     ctx,
		loadConfig: conjurapi.LoadConfig,
		newClient: func(config conjurapi.Config) (secretAuditClient, error) {
			// Reuses the session the vendor CLI stored; CLIHarbor supplies no credential.
			return conjurapi.NewClientFromEnvironment(config)
		},
		now:  time.Now,
		snap: server.SecretAuditSnapshot{State: "idle"},
	}
}

func (s *conjurSecretAuditService) Snapshot() server.SecretAuditSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotLocked()
}

func (s *conjurSecretAuditService) snapshotLocked() server.SecretAuditSnapshot {
	out := s.snap
	out.Available = s.enabled
	if s.enabled {
		out.PackID, out.ToolID = conjurCredentialPackID, conjurCredentialToolID
		if out.Target == nil {
			if config, err := s.loadConfig(); err == nil && config.ApplianceURL != "" {
				out.Target = &server.SecretAuditTarget{ApplianceURL: config.ApplianceURL, Account: config.Account}
			}
		}
	}
	out.Findings = append([]server.SecretAuditFinding{}, s.snap.Findings...)
	out.Failures = append([]server.SecretAuditFailure{}, s.snap.Failures...)
	return out
}

func (s *conjurSecretAuditService) Start(request server.SecretAuditRequest) (server.SecretAuditSnapshot, error) {
	if err := server.ValidateSecretAuditRequest(request); err != nil {
		return s.Snapshot(), err
	}
	if request.ScanType == "" {
		request.ScanType = "references"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.enabled || request.PackID != conjurCredentialPackID || request.ToolID != conjurCredentialToolID {
		return s.snapshotLocked(), server.ErrSecretAuditUnavailable
	}
	if s.snap.State == "running" {
		return s.snapshotLocked(), nil
	}
	ctx, cancel := context.WithCancel(s.parent)
	s.cancel = cancel
	s.done = make(chan struct{})
	s.snap = server.SecretAuditSnapshot{
		State:             "running",
		Phase:             "connecting",
		MinimumConfidence: request.MinimumConfidence,
		ScanType:          request.ScanType,
		StartedAt:         s.now().UTC().Format(time.RFC3339),
	}
	go s.run(ctx, cancel, s.done, request)
	return s.snapshotLocked(), nil
}

func (s *conjurSecretAuditService) Cancel() server.SecretAuditSnapshot {
	s.mu.Lock()
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return s.Snapshot()
}

func (s *conjurSecretAuditService) update(apply func(*server.SecretAuditSnapshot)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	apply(&s.snap)
}

func (s *conjurSecretAuditService) run(ctx context.Context, cancel context.CancelFunc, done chan struct{}, request server.SecretAuditRequest) {
	defer close(done)
	defer cancel()
	err := s.audit(ctx, request)
	s.update(func(snap *server.SecretAuditSnapshot) {
		snap.FinishedAt = s.now().UTC().Format(time.RFC3339)
		snap.Phase = ""
		switch {
		case err == nil:
			snap.State = "completed"
		case ctx.Err() != nil:
			snap.State = "cancelled"
		default:
			snap.State = "failed"
			var failure secretAuditFailure
			if errors.As(err, &failure) {
				snap.FailureCode = failure.code
			} else {
				snap.FailureCode = "unavailable"
			}
		}
		if snap.State != "completed" {
			// A partial audit must not look like a clean inventory.
			snap.Findings, snap.Failures = nil, nil
		}
	})
}

func (s *conjurSecretAuditService) audit(ctx context.Context, request server.SecretAuditRequest) error {
	config, err := s.loadConfig()
	if err != nil || config.ApplianceURL == "" {
		return secretAuditFailure{"not_configured"}
	}
	// Never redirect vendor-owned credentials or tokens to a browser-chosen host.
	// A different backend must be configured and authenticated through Conjur.
	if request.ApplianceURL != "" && strings.TrimRight(request.ApplianceURL, "/") != strings.TrimRight(config.ApplianceURL, "/") {
		return secretAuditFailure{"backend_mismatch"}
	}
	var pattern *regexp.Regexp
	if request.ScanType == "regex" {
		pattern, err = regexp.Compile(request.Pattern)
		if err != nil {
			return secretAuditFailure{"invalid_scan"}
		}
	}
	if config.HTTPTimeout <= 0 || config.HTTPTimeout > secretAuditHTTPTimeoutLimit {
		config.HTTPTimeout = secretAuditHTTPTimeoutLimit
	}
	s.update(func(snap *server.SecretAuditSnapshot) {
		snap.Target = &server.SecretAuditTarget{ApplianceURL: config.ApplianceURL, Account: config.Account}
	})
	client, err := s.newClient(config)
	if err != nil {
		return secretAuditFailure{"session_required"}
	}

	s.update(func(snap *server.SecretAuditSnapshot) { snap.Phase = "listing" })
	ids, err := listSecretAuditVariables(ctx, client)
	if err != nil {
		return err
	}
	s.update(func(snap *server.SecretAuditSnapshot) { snap.Total = len(ids); snap.Phase = "reading" })

	known := map[string]struct{}{}
	knownNormalized := map[string]struct{}{}
	variableIDs := make(map[string]string, len(ids))
	for _, id := range ids {
		variableID := secretAuditVariableID(id)
		variableIDs[id] = variableID
		for _, ref := range []string{id, variableID} {
			if request.ScanType == "references" {
				known[ref] = struct{}{}
				knownNormalized[normalizeReferenceShape(ref)] = struct{}{}
			}
		}
	}
	sort.Slice(ids, func(i, j int) bool { return variableIDs[ids[i]] < variableIDs[ids[j]] })

	var findings []server.SecretAuditFinding
	var failures []server.SecretAuditFailure
	inspected := 0
	for start := 0; start < len(ids); {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		end := nextSecretAuditBatch(ids, start)
		values, batchFailures := retrieveSecretAuditBatch(client, ids[start:end])
		for _, id := range ids[start:end] {
			if code, failed := batchFailures[id]; failed {
				failures = append(failures, server.SecretAuditFailure{VariableID: variableIDs[id], Code: code})
				continue
			}
			value := values[id]
			if !utf8.Valid(value) {
				failures = append(failures, server.SecretAuditFailure{VariableID: variableIDs[id], Code: "unsupported_encoding"})
				continue
			}
			inspected++
			confidence, reason := "", ""
			switch request.ScanType {
			case "references":
				confidence, reason = classifySecretValue(string(value), known, knownNormalized)
			case "contains":
				if strings.Contains(string(value), request.Pattern) {
					confidence, reason = "high", "contains_text_match"
				}
			case "exact":
				if string(value) == request.Pattern {
					confidence, reason = "high", "exact_text_match"
				}
			case "regex":
				if pattern.Match(value) {
					confidence, reason = "high", "regex_match"
				}
			}
			if reason != "" && (request.MinimumConfidence == "medium" || confidence == "high") {
				findings = append(findings, server.SecretAuditFinding{VariableID: variableIDs[id], Confidence: confidence, Reason: reason})
			}
		}
		zeroSecretValues(values)
		start = end
		processed := start
		s.update(func(snap *server.SecretAuditSnapshot) { snap.Processed = processed; snap.Inspected = inspected })
	}

	// Not a server-side transaction: re-verify the visible ID set so drift
	// during a long audit cannot yield a report claiming full coverage.
	s.update(func(snap *server.SecretAuditSnapshot) { snap.Phase = "verifying" })
	ending, err := listSecretAuditVariables(ctx, client)
	if err != nil {
		return err
	}
	if len(ending) != len(ids) {
		return secretAuditFailure{"inventory_changed"}
	}
	for _, id := range ending {
		if _, ok := variableIDs[id]; !ok {
			return secretAuditFailure{"inventory_changed"}
		}
	}

	sort.SliceStable(findings, func(i, j int) bool {
		return findings[i].Confidence == "high" && findings[j].Confidence != "high"
	})
	s.update(func(snap *server.SecretAuditSnapshot) {
		snap.Findings, snap.Failures, snap.Inspected = findings, failures, inspected
	})
	return nil
}

func listSecretAuditVariables(ctx context.Context, client secretAuditClient) ([]string, error) {
	count, err := client.ResourcesCount(&conjurapi.ResourceFilter{Kind: "variable"})
	if err != nil || count == nil || count.Count < 0 {
		return nil, classifySecretAuditAPIError(err)
	}
	if count.Count > secretAuditMaxVariables {
		return nil, secretAuditFailure{"too_many_variables"}
	}
	seen := make(map[string]struct{}, count.Count)
	ids := make([]string, 0, count.Count)
	for offset := 0; offset < count.Count; {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		limit := min(secretAuditListPageSize, count.Count-offset)
		page, err := client.Resources(&conjurapi.ResourceFilter{Kind: "variable", Limit: limit, Offset: offset})
		if err != nil {
			return nil, classifySecretAuditAPIError(err)
		}
		if len(page) == 0 || len(page) > limit {
			return nil, secretAuditFailure{"inventory_changed"}
		}
		for _, resource := range page {
			// Take only the ID; annotations and other metadata are dropped here.
			id, ok := resource["id"].(string)
			if !ok || !validSecretAuditResourceID(id) {
				return nil, secretAuditFailure{"invalid_inventory"}
			}
			if _, dup := seen[id]; dup {
				return nil, secretAuditFailure{"inventory_changed"}
			}
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
		offset += len(page)
	}
	return ids, nil
}

// nextSecretAuditBatch bounds both item count and URL size. IDs containing a
// comma cannot be batched because the vendor API joins IDs with commas.
func nextSecretAuditBatch(ids []string, start int) int {
	if strings.Contains(ids[start], ",") {
		return start + 1
	}
	end, size := start, 0
	for end < len(ids) && end-start < secretAuditBatchSize && !strings.Contains(ids[end], ",") {
		size += len(url.QueryEscape(ids[end])) + 3
		if end > start && size > secretAuditMaxBatchQuery {
			break
		}
		end++
	}
	return end
}

func retrieveSecretAuditBatch(client secretAuditClient, ids []string) (map[string][]byte, map[string]string) {
	failures := map[string]string{}
	if len(ids) > 1 {
		values, err := client.RetrieveBatchSecretsSafe(ids)
		if err == nil && len(values) == len(ids) && hasEveryID(values, ids) {
			for _, id := range ids {
				if len(values[id]) > secretAuditMaxValueBytes {
					clear(values[id])
					delete(values, id)
					failures[id] = "output_limit_exceeded"
				}
			}
			return values, failures
		}
		zeroSecretValues(values)
	}
	// One unreadable variable fails a whole batch; fall back per variable so
	// the operator learns exactly which ones could not be inspected.
	values := make(map[string][]byte, len(ids))
	for _, id := range ids {
		value, err := client.RetrieveSecret(id)
		switch {
		case err != nil:
			failures[id] = secretAuditRetrievalCode(err)
		case len(value) > secretAuditMaxValueBytes:
			clear(value)
			failures[id] = "output_limit_exceeded"
		default:
			values[id] = value
		}
	}
	return values, failures
}

func hasEveryID(values map[string][]byte, ids []string) bool {
	for _, id := range ids {
		if _, ok := values[id]; !ok {
			return false
		}
	}
	return true
}

// zeroSecretValues overwrites each buffer we own. Go strings/allocations made
// inside the vendor library cannot be reliably erased; this drops what we can.
func zeroSecretValues(values map[string][]byte) {
	for id, value := range values {
		clear(value)
		delete(values, id)
	}
}

func secretAuditRetrievalCode(err error) string {
	var conjurErr *response.ConjurError
	if errors.As(err, &conjurErr) {
		switch conjurErr.Code {
		case http.StatusNotFound:
			return "no_value"
		case http.StatusForbidden:
			return "forbidden"
		}
	}
	return "retrieval_failed"
}

func classifySecretAuditAPIError(err error) error {
	var conjurErr *response.ConjurError
	if errors.As(err, &conjurErr) && conjurErr.Code == http.StatusUnauthorized {
		return secretAuditFailure{"session_required"}
	}
	return secretAuditFailure{"unavailable"}
}

func validSecretAuditResourceID(id string) bool {
	if id == "" || len(id) > 2048 || !utf8.ValidString(id) || strings.TrimSpace(id) == "" {
		return false
	}
	for _, r := range id {
		if r <= 0x1f || (r >= 0x7f && r <= 0x9f) || unicode.Is(unicode.Cf, r) || r == '\u2028' || r == '\u2029' {
			return false
		}
	}
	return !strings.Contains(id, ":variable:") || secretAuditVariableID(id) != ""
}

func secretAuditVariableID(resourceID string) string {
	if _, after, ok := strings.Cut(resourceID, ":variable:"); ok {
		return after
	}
	return resourceID
}

func normalizeReferenceShape(value string) string {
	normalized := strings.NewReplacer(`\`, "/", ".", "/").Replace(strings.TrimSpace(value))
	for strings.Contains(normalized, "//") {
		normalized = strings.ReplaceAll(normalized, "//", "/")
	}
	return strings.Trim(normalized, "/")
}

// Patterns mirror the PowerShell -match operator, which is case-insensitive.
const secretFieldSuffix = `(password|passwd|pwd|username|user|token|api[-_]?key|secret|client[-_]?secret|private[-_]?key|access[-_]?key|credential|credentials)`

var (
	dotCredentialSuffixPattern  = regexp.MustCompile(`(?i)(?:^|\.)` + secretFieldSuffix + `$`)
	referenceURIPattern         = regexp.MustCompile(`(?i)^(conjur|cyberark|idira)://[A-Za-z0-9_.@:/\\-]+$`)
	anyURIPattern               = regexp.MustCompile(`(?i)^[A-Za-z][A-Za-z0-9+.-]*://`)
	ipv4Pattern                 = regexp.MustCompile(`^\d{1,3}(?:\.\d{1,3}){3}$`)
	semverPattern               = regexp.MustCompile(`(?i)^v?\d+(?:\.\d+){2,}(?:[-+][A-Za-z0-9.-]+)?$`)
	jwtPattern                  = regexp.MustCompile(`^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$`)
	dotReferencePattern         = regexp.MustCompile(`(?i)^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}(?:[\\/][A-Za-z0-9_.@-]+(?:[\\/][A-Za-z0-9_.@-]+)*)?$`)
	dotSecretSuffixPattern      = regexp.MustCompile(`(?i)\.` + secretFieldSuffix + `$`)
	pathPattern                 = regexp.MustCompile(`(?i)^[A-Za-z0-9_.@-]+(?:[\\/][A-Za-z0-9_.@-]+)+$`)
	pathSecretSuffixPattern     = regexp.MustCompile(`(?i)(?:^|[\\/])` + secretFieldSuffix + `$`)
	referenceSeparatorCharacter = regexp.MustCompile(`[./\\]`)
)

// classifySecretValue returns ("", "") when the value does not look like a
// secret path/reference. It must stay in step with Test-SecretValueShape.
func classifySecretValue(value string, known, knownNormalized map[string]struct{}) (confidence, reason string) {
	candidate := strings.TrimSpace(value)
	if candidate == "" || utf8.RuneCountInString(candidate) > 2048 {
		return "", ""
	}
	if _, ok := known[candidate]; ok {
		return "high", "exact_known_variable_reference"
	}
	hasSlash := strings.ContainsAny(candidate, `/\`)
	if normalized := normalizeReferenceShape(candidate); normalized != "" && (hasSlash || strings.Contains(candidate, ".")) {
		if _, ok := knownNormalized[normalized]; ok {
			// Dot-only values are ambiguous with host/domain-like data.
			if hasSlash || dotCredentialSuffixPattern.MatchString(candidate) {
				return "high", "normalized_known_variable_reference"
			}
			return "medium", "normalized_known_variable_reference"
		}
	}
	if referenceURIPattern.MatchString(candidate) {
		return "high", "secret_reference_uri"
	}
	if strings.IndexFunc(candidate, unicode.IsSpace) >= 0 ||
		strings.HasPrefix(candidate, "{") || strings.HasPrefix(candidate, "[") ||
		strings.HasPrefix(candidate, "-----BEGIN") ||
		anyURIPattern.MatchString(candidate) || strings.Contains(candidate, "=") {
		return "", ""
	}
	if ipv4Pattern.MatchString(candidate) || semverPattern.MatchString(candidate) || jwtPattern.MatchString(candidate) {
		return "", ""
	}
	if dotReferencePattern.MatchString(candidate) && (hasSlash || dotSecretSuffixPattern.MatchString(candidate)) {
		return "medium", "dot_notation_reference_shape"
	}
	if pathPattern.MatchString(candidate) {
		if pathSecretSuffixPattern.MatchString(candidate) {
			return "medium", "path_with_secret_field_suffix"
		}
		if len(referenceSeparatorCharacter.FindAllStringIndex(candidate, -1)) >= 3 {
			return "medium", "hierarchical_reference_shape"
		}
	}
	return "", ""
}
