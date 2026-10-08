package conjur

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/cyberark/conjur-api-go/conjurapi"
	"github.com/cyberark/conjur-api-go/conjurapi/response"
)

func TestClassifySecretValueMatchesPowerShellSelfTest(t *testing.T) {
	known := map[string]struct{}{}
	normalized := map[string]struct{}{}
	for _, ref := range []string{"prod/service/password", "RH/value/value/value/password", "acme:variable:prod/service/token", "team/app/database/name"} {
		known[ref] = struct{}{}
		normalized[normalizeReferenceShape(ref)] = struct{}{}
	}
	cases := []struct{ value, confidence, reason string }{
		{"prod/service/password", "high", "exact_known_variable_reference"},
		{"RH.value.value.value/password", "high", "normalized_known_variable_reference"},
		{"team.app.database.name", "medium", "normalized_known_variable_reference"},
		{"conjur://prod/service/password", "high", "secret_reference_uri"},
		{"other.team.database/password", "medium", "dot_notation_reference_shape"},
		{"other.team.database.password", "medium", "dot_notation_reference_shape"},
		{"other.team.database.PASSWORD", "medium", "dot_notation_reference_shape"}, // -match is case-insensitive
		{"other/service/password", "medium", "path_with_secret_field_suffix"},
		{"other/service/env/region/value", "medium", "hierarchical_reference_shape"},
		{"correct-horse-battery-staple", "", ""},
		{"https://example.com/a/b/c", "", ""},
		{`{"password":"not-a-reference"}`, "", ""},
		{"Server=db;Password=example", "", ""},
		{"1.2.3", "", ""},
		{"10.20.30.40", "", ""},
		{"db.prod.example.com", "", ""},
		{"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "", ""},
		{"two words/password", "", ""},
	}
	for _, c := range cases {
		confidence, reason := classifySecretValue(c.value, known, normalized)
		if confidence != c.confidence || reason != c.reason {
			t.Errorf("%q = %s/%s, want %s/%s", c.value, confidence, reason, c.confidence, c.reason)
		}
	}
	for _, id := range []string{"acct:variable:bad\nidentifier", "acct:variable:spoof‮txt", "acct:variable:"} {
		if validSecretAuditResourceID(id) {
			t.Errorf("unsafe resource ID %q accepted", id)
		}
	}
}

const secretSentinel = "SENTINEL-SECRET-VALUE"

type fakeSecretAuditClient struct {
	mu          sync.Mutex
	ids         []string
	values      map[string]string
	errs        map[string]error
	countErr    error
	afterRead   func(*fakeSecretAuditClient)
	batchCalls  int
	singleCalls int
}

func (f *fakeSecretAuditClient) ResourcesCount(*conjurapi.ResourceFilter) (*conjurapi.ResourcesCount, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.countErr != nil {
		return nil, f.countErr
	}
	return &conjurapi.ResourcesCount{Count: len(f.ids)}, nil
}

func (f *fakeSecretAuditClient) Resources(filter *conjurapi.ResourceFilter) ([]map[string]interface{}, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	end := min(filter.Offset+filter.Limit, len(f.ids))
	var page []map[string]interface{}
	for _, id := range f.ids[filter.Offset:end] {
		page = append(page, map[string]interface{}{"id": id, "annotations": map[string]string{"note": "dropped"}})
	}
	return page, nil
}

func (f *fakeSecretAuditClient) RetrieveBatchSecretsSafe(ids []string) (map[string][]byte, error) {
	f.mu.Lock()
	f.batchCalls++
	f.mu.Unlock()
	out := map[string][]byte{}
	for _, id := range ids {
		if f.errs[id] != nil {
			return nil, f.errs[id]
		}
		out[id] = []byte(f.values[id])
	}
	f.read()
	return out, nil
}

func (f *fakeSecretAuditClient) RetrieveSecret(id string) ([]byte, error) {
	f.mu.Lock()
	f.singleCalls++
	f.mu.Unlock()
	defer f.read()
	if f.errs[id] != nil {
		return nil, f.errs[id]
	}
	return []byte(f.values[id]), nil
}

func (f *fakeSecretAuditClient) read() {
	if f.afterRead != nil {
		f.afterRead(f)
		f.afterRead = nil
	}
}

func runSecretAudit(t *testing.T, client *fakeSecretAuditClient, clientErr error, minimum string, scan ...server.SecretAuditRequest) server.SecretAuditSnapshot {
	t.Helper()
	service := &SecretAuditService{
		enabled: true,
		parent:  context.Background(),
		loadConfig: func() (conjurapi.Config, error) {
			return conjurapi.Config{ApplianceURL: "https://conjur.invalid", Account: "acct"}, nil
		},
		newClient: func(conjurapi.Config) (secretAuditClient, error) { return client, clientErr },
		now:       time.Now,
		snap:      server.SecretAuditSnapshot{State: "idle"},
	}
	request := server.SecretAuditRequest{}
	if len(scan) > 0 {
		request = scan[0]
	}
	request.PackID, request.ToolID, request.MinimumConfidence = PackID, ToolID, minimum
	if _, err := service.Start(request); err != nil {
		t.Fatalf("start: %v", err)
	}
	select {
	case <-service.done:
	case <-time.After(5 * time.Second):
		t.Fatal("audit did not finish")
	}
	snapshot := service.Snapshot()
	encoded, _ := json.Marshal(snapshot)
	if strings.Contains(string(encoded), secretSentinel) || strings.Contains(string(encoded), "dropped") {
		t.Fatalf("snapshot leaked a value or resource metadata: %s", encoded)
	}
	return snapshot
}

func TestInventoryRegexNeverRetrievesSecretValues(t *testing.T) {
	client := &fakeSecretAuditClient{
		ids: []string{"acct:variable:app/prod/password", "acct:variable:app/dev/name", "acct:variable:app/PROD/token"},
		values: map[string]string{"acct:variable:app/prod/password": secretSentinel},
		errs: map[string]error{"acct:variable:app/prod/password": &response.ConjurError{Code: http.StatusForbidden}},
	}
	snapshot := runSecretAudit(t, client, nil, "high", server.SecretAuditRequest{
		ScanType: "id-regex", Pattern: `(?i)(?:^|/)prod(?:/|$)`,
	})
	if snapshot.State != "completed" || snapshot.ScanType != "id-regex" ||
		snapshot.Total != 3 || snapshot.Processed != 3 || snapshot.Inspected != 3 ||
		len(snapshot.Failures) != 0 || len(snapshot.Findings) != 2 {
		t.Fatalf("inventory regex snapshot = %+v", snapshot)
	}
	for _, finding := range snapshot.Findings {
		if finding.Confidence != "high" || finding.Reason != "regex_variable_id_match" ||
			!strings.Contains(strings.ToLower(finding.VariableID), "/prod/") {
			t.Fatalf("incorrect ID match: %+v", finding)
		}
	}
	if client.singleCalls != 0 || client.batchCalls != 0 {
		t.Fatalf("inventory-only search attempted secret retrieval: single=%d batch=%d", client.singleCalls, client.batchCalls)
	}
	encoded, _ := json.Marshal(snapshot)
	if strings.Contains(string(encoded), "prod(?:/|$)") || strings.Contains(string(encoded), secretSentinel) {
		t.Fatal("inventory results leaked query or secret value")
	}
}

func TestSecretAuditCustomScansKeepValuesAndPatternsOutOfSnapshots(t *testing.T) {
	for _, scan := range []struct{ kind, pattern, value, reason string }{
		{"contains", secretSentinel, "prefix " + secretSentinel + " suffix", "contains_text_match"},
		{"exact", secretSentinel, secretSentinel, "exact_text_match"},
		{"exact", " leading space ", " leading space ", "exact_text_match"},
		{"regex", `(?i)^team[./].*/password$`, "TEAM.env/database/password", "regex_match"},
		{"regex", `^SENTINEL-SECRET-VALUE$`, secretSentinel, "regex_match"},
		{"contains", "password", "PASSWORD", ""},
		{"exact", "password", " password ", ""},
		{"regex", `^team[./].*/password$`, "prefix team.env/database/password", ""},
	} {
		t.Run(scan.kind+"/"+scan.reason+"/"+scan.pattern, func(t *testing.T) {
			client := &fakeSecretAuditClient{
				ids: []string{"acct:variable:example"}, values: map[string]string{"acct:variable:example": scan.value},
			}
			snapshot := runSecretAudit(t, client, nil, "high", server.SecretAuditRequest{
				ApplianceURL: "https://conjur.invalid/", ScanType: scan.kind, Pattern: scan.pattern,
			})
			if snapshot.State != "completed" || snapshot.ScanType != scan.kind {
				t.Fatalf("snapshot = %+v", snapshot)
			}
			if scan.reason == "" {
				if len(snapshot.Findings) != 0 {
					t.Fatalf("unexpected findings = %+v", snapshot.Findings)
				}
			} else if len(snapshot.Findings) != 1 || snapshot.Findings[0].Reason != scan.reason || snapshot.Findings[0].Confidence != "high" {
				t.Fatalf("findings = %+v", snapshot.Findings)
			}
			encoded, _ := json.Marshal(snapshot)
			if strings.Contains(string(encoded), scan.pattern) {
				t.Fatal("scan pattern leaked into snapshot")
			}
		})
	}
}

func TestSecretAuditRefusesCredentialForwardingToAnotherBackend(t *testing.T) {
	for _, backend := range []string{"https://other.invalid", "https://conjur.invalid/another-path", "https://conjur.invalid:9443"} {
		client := &fakeSecretAuditClient{}
		snapshot := runSecretAudit(t, client, errors.New("client must not be created"), "medium", server.SecretAuditRequest{ApplianceURL: backend})
		if snapshot.State != "failed" || snapshot.FailureCode != "backend_mismatch" || client.batchCalls != 0 || client.singleCalls != 0 {
			t.Fatalf("mismatched backend snapshot = %+v", snapshot)
		}
	}
}

func TestSecretAuditReportsNonTextValuesAsUnchecked(t *testing.T) {
	client := &fakeSecretAuditClient{
		ids: []string{"acct:variable:binary"}, values: map[string]string{"acct:variable:binary": "\xffpassword"},
	}
	snapshot := runSecretAudit(t, client, nil, "high", server.SecretAuditRequest{ScanType: "contains", Pattern: "password"})
	if snapshot.State != "completed" || snapshot.Inspected != 0 || len(snapshot.Findings) != 0 ||
		len(snapshot.Failures) != 1 || snapshot.Failures[0].Code != "unsupported_encoding" {
		t.Fatalf("non-text snapshot = %+v", snapshot)
	}
}

func TestSecretAuditReportsReferencesAndPerVariableFailuresWithoutValues(t *testing.T) {
	client := &fakeSecretAuditClient{
		ids: []string{"acct:variable:app/db/password", "acct:variable:app/api/token", "acct:variable:app/empty", "acct:variable:app/locked", "acct:variable:a,b"},
		values: map[string]string{
			"acct:variable:app/db/password": "app.empty",
			"acct:variable:app/api/token":   secretSentinel,
			"acct:variable:a,b":             "acct:variable:app/db/password",
		},
		errs: map[string]error{
			"acct:variable:app/empty":  &response.ConjurError{Code: http.StatusNotFound},
			"acct:variable:app/locked": &response.ConjurError{Code: http.StatusForbidden},
		},
	}
	snapshot := runSecretAudit(t, client, nil, "medium")

	if snapshot.State != "completed" || snapshot.Total != 5 || snapshot.Processed != 5 || snapshot.Inspected != 3 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	want := []server.SecretAuditFinding{
		{VariableID: "a,b", Confidence: "high", Reason: "exact_known_variable_reference"},
		{VariableID: "app/db/password", Confidence: "medium", Reason: "normalized_known_variable_reference"},
	}
	if len(snapshot.Findings) != len(want) || snapshot.Findings[0] != want[0] || snapshot.Findings[1] != want[1] {
		t.Fatalf("findings = %+v, want %+v", snapshot.Findings, want)
	}
	failures := map[string]string{}
	for _, failure := range snapshot.Failures {
		failures[failure.VariableID] = failure.Code
	}
	if failures["app/empty"] != "no_value" || failures["app/locked"] != "forbidden" || len(failures) != 2 {
		t.Fatalf("failures = %+v", snapshot.Failures)
	}
	if client.batchCalls == 0 || client.singleCalls == 0 {
		t.Fatalf("expected batch attempt then per-variable fallback, got batch=%d single=%d", client.batchCalls, client.singleCalls)
	}

	if high := runSecretAudit(t, client, nil, "high"); len(high.Findings) != 1 || high.Findings[0].VariableID != "a,b" {
		t.Fatalf("high-only findings = %+v", high.Findings)
	}
}

func TestSecretAuditFailsClosed(t *testing.T) {
	drifting := &fakeSecretAuditClient{
		ids:    []string{"acct:variable:one", "acct:variable:two"},
		values: map[string]string{"acct:variable:one": "app/db/password"},
		afterRead: func(f *fakeSecretAuditClient) {
			f.mu.Lock()
			f.ids = []string{"acct:variable:one", "acct:variable:three"}
			f.mu.Unlock()
		},
	}
	if snapshot := runSecretAudit(t, drifting, nil, "medium"); snapshot.State != "failed" || snapshot.FailureCode != "inventory_changed" || len(snapshot.Findings) != 0 {
		t.Fatalf("drift snapshot = %+v", snapshot)
	}

	unauthorized := &fakeSecretAuditClient{countErr: &response.ConjurError{Code: http.StatusUnauthorized}}
	if snapshot := runSecretAudit(t, unauthorized, nil, "medium"); snapshot.FailureCode != "session_required" {
		t.Fatalf("unauthorized snapshot = %+v", snapshot)
	}
	if snapshot := runSecretAudit(t, &fakeSecretAuditClient{}, errors.New("no stored credentials"), "medium"); snapshot.FailureCode != "session_required" {
		t.Fatalf("missing-session snapshot = %+v", snapshot)
	}

	disabled := &SecretAuditService{snap: server.SecretAuditSnapshot{State: "idle"}}
	if _, err := disabled.Start(server.SecretAuditRequest{PackID: PackID, ToolID: ToolID, MinimumConfidence: "high"}); err == nil {
		t.Fatal("disabled audit started")
	}
}
