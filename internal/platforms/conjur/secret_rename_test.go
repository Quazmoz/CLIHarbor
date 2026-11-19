package conjur

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	packassets "github.com/Quazmoz/CLIHarbor/packs"
	"github.com/cyberark/conjur-api-go/conjurapi"
	"github.com/cyberark/conjur-api-go/conjurapi/response"
)

type renameFixture struct {
	resources        map[string]map[string]interface{}
	values           map[string]map[int]string
	writes           []runs.Request
	failCommand      string
	suppressVersions bool
	onWrite          func()
	resourceErrors   map[string]error
}

func (f *renameFixture) Resource(id string) (map[string]interface{}, error) {
	if err := f.resourceErrors[id]; err != nil {
		return nil, err
	}
	record, ok := f.resources[id]
	if !ok {
		return nil, &response.ConjurError{Code: 404}
	}
	// Match the JSON types produced by the real vendor client, without sharing
	// mutable metadata slices with the orchestration service.
	data, _ := json.Marshal(record)
	var out map[string]interface{}
	_ = json.Unmarshal(data, &out)
	return out, nil
}

func (f *renameFixture) RetrieveSecretReader(id string) (io.ReadCloser, error) {
	return f.RetrieveSecretWithVersionReader(id, len(f.values[id]))
}

func (f *renameFixture) RetrieveSecretWithVersionReader(id string, version int) (io.ReadCloser, error) {
	value, ok := f.values[id][version]
	if !ok {
		return nil, &response.ConjurError{Code: 404}
	}
	return io.NopCloser(strings.NewReader(value)), nil
}

func (f *renameFixture) Preview(request runs.Request) (runs.Preview, error) {
	return runs.Preview{Approval: &runs.ApprovalChallenge{ID: "one-use", RequiredText: "DELETE: new"},
		Context: &runs.ExecutionContext{Fields: []runs.ExecutionContextField{
			{Label: "Account", Value: "acct"}, {Label: "Endpoint", Value: "https://conjur.example.test"},
		}}}, nil
}

func (f *renameFixture) Start(request runs.Request) (runs.Snapshot, error) {
	f.writes = append(f.writes, request)
	if f.onWrite != nil {
		f.onWrite()
	}
	if request.CommandID == f.failCommand {
		return runs.Snapshot{}, fmt.Errorf("untrusted error with secret bytes")
	}
	value := func(key string) string {
		var out string
		_ = json.Unmarshal(request.Values[key], &out)
		return out
	}
	local := value("variable-id")
	branch := value("policy-branch")
	id := "acct:variable:" + local
	if branch != "" && branch != "root" {
		id = "acct:variable:" + branch + "/" + local
	}
	switch request.CommandID {
	case "secret-create-owned":
		f.resources[id] = map[string]interface{}{
			"id": id, "policy": "acct:policy:" + branch,
			"owner":       "acct:" + value("owner-kind") + ":" + strings.TrimPrefix(value("owner-id"), "/"),
			"permissions": []interface{}{}, "annotations": []interface{}{}, "secrets": []interface{}{},
		}
		f.values[id] = map[int]string{}
	case "secret-annotate-owned":
		f.resources[id]["annotations"] = append(f.resources[id]["annotations"].([]interface{}), map[string]interface{}{
			"name": value("annotation-name"), "value": value("annotation-value"), "policy": "acct:policy:" + branch,
		})
	case "secret-permit":
		f.resources[id]["permissions"] = append(f.resources[id]["permissions"].([]interface{}), map[string]interface{}{
			"role":      "acct:" + value("role-kind") + ":" + strings.TrimPrefix(value("role-id"), "/"),
			"privilege": value("privileges"), "policy": "acct:policy:" + branch,
		})
	case "secret-set-value":
		id = local
		version := len(f.values[id]) + 1
		if !f.suppressVersions || version == 1 {
			f.values[id][version] = value("value")
			f.resources[id]["secrets"] = append(f.resources[id]["secrets"].([]interface{}), map[string]interface{}{"version": version})
		}
	case "secret-delete":
		delete(f.resources, id)
		delete(f.values, id)
	default:
		return runs.Snapshot{}, fmt.Errorf("unexpected task %s", request.CommandID)
	}
	return runs.Snapshot{RunID: fmt.Sprintf("run-%d", len(f.writes))}, nil
}

func (f *renameFixture) Wait(context.Context, string) (runs.Snapshot, error) {
	code := 0
	return runs.Snapshot{Status: runs.StatusExited, ExitCode: &code}, nil
}

func (f *renameFixture) Cancel(string) error { return nil }

func newRenameFixture(t *testing.T) (*SecretRenameService, *renameFixture, server.SecretRenameRequest) {
	t.Helper()
	id := "acct:variable:apps/old"
	fixture := &renameFixture{
		resources: map[string]map[string]interface{}{id: {
			"id": id, "owner": "acct:group:owners", "policy": "acct:policy:apps",
			"annotations": []interface{}{map[string]interface{}{"name": "description", "value": "database password", "policy": "acct:policy:apps"}},
			"permissions": []interface{}{
				map[string]interface{}{"role": "acct:host:reader", "privilege": "execute", "policy": "acct:policy:root"},
				map[string]interface{}{"role": "acct:group:operators", "privilege": "update", "policy": "acct:policy:apps"},
			},
			"secrets": []interface{}{map[string]interface{}{"version": 7}, map[string]interface{}{"version": 9}},
		}},
		values: map[string]map[int]string{id: {7: " old-sensitive-value\r\nsecond line ", 9: "current-sensitive-value"}},
	}
	secrets := &SecretRetrievalService{
		enabled: true, now: time.Now,
		loadConfig: func() (conjurapi.Config, error) {
			return conjurapi.Config{Account: "acct", ApplianceURL: "https://conjur.example.test"}, nil
		},
		newClient: func(conjurapi.Config) (secretRetrievalClient, error) { return fixture, nil },
	}
	login := NewCredentialLoginService(readyConjurSnapshotWithExecutable(t))
	service := NewSecretRenameService(secrets, login, fixture)
	return service, fixture, server.SecretRenameRequest{Target: retrievalRequest("apps/old", 0), Destination: "apps/new"}
}

func renameCall(t *testing.T, service *SecretRenameService, action string, request server.SecretRenameRequest) server.SecretRenameResponse {
	t.Helper()
	out, err := service.Rename(t.Context(), action, request)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(out)
	if strings.Contains(string(data), "sensitive-value") {
		t.Fatal("rename response leaked a value")
	}
	return out
}

func TestRenameCopiesAllRetainedValuesAndGrantProvenanceBeforeSeparateDelete(t *testing.T) {
	service, fixture, request := newRenameFixture(t)
	review := renameCall(t, service, "review", request)
	if review.Status != "reviewed" || len(fixture.writes) != 0 || len(review.Versions) != 2 || review.Owner != "acct:group:owners" {
		t.Fatalf("review = %+v, writes = %d", review, len(fixture.writes))
	}
	request.ApprovalID = review.ApprovalID
	copy := renameCall(t, service, "copy", request)
	if copy.Status != "copied" || !slices.Equal(copy.Versions, []server.SecretVersionMapping{{Source: 7, Destination: 1}, {Source: 9, Destination: 2}}) {
		t.Fatalf("copy = %+v", copy)
	}
	if fixture.resources["acct:variable:apps/old"] == nil {
		t.Fatal("copy deleted the original")
	}
	if fixture.values["acct:variable:apps/new"][1] != fixture.values["acct:variable:apps/old"][7] {
		t.Fatal("copy changed whitespace or line endings")
	}
	// Root-owned grants must be recreated in root using the full relative path.
	for _, step := range fixture.writes {
		if step.CommandID == "secret-permit" && string(step.Values["policy-branch"]) == `"root"` &&
			string(step.Values["variable-id"]) != `"apps/new"` {
			t.Fatal("grant provenance lost")
		}
	}
	if replay := renameCall(t, service, "copy", request); replay.FailureCode != "approval_required" {
		t.Fatalf("copy replay = %+v", replay)
	}
	request.ApprovalID, request.Confirmation = copy.ApprovalID, "DELETE: apps/old"
	deleted := renameCall(t, service, "delete", request)
	if deleted.Status != "deleted" || fixture.resources["acct:variable:apps/old"] != nil || fixture.resources["acct:variable:apps/new"] == nil {
		t.Fatalf("delete = %+v", deleted)
	}
}

func TestRenameRefusesUnsafeOrIncompleteCopies(t *testing.T) {
	for _, scenario := range []string{"existing", "forbidden", "forbidden-destination", "unknown-grant", "external-annotation", "rotation", "dynamic", "dynamic-namespace", "too-many-versions", "oversized-value", "source-drift", "suppressed-version", "failed-write", "wrong-context", "expired", "different-policy", "tool-changed"} {
		t.Run(scenario, func(t *testing.T) {
			service, fixture, request := newRenameFixture(t)
			source := fixture.resources["acct:variable:apps/old"]
			switch scenario {
			case "existing":
				fixture.resources["acct:variable:apps/new"] = source
			case "forbidden":
				service.secrets.newClient = func(conjurapi.Config) (secretRetrievalClient, error) {
					return nil, fmt.Errorf("sensitive vendor failure")
				}
			case "forbidden-destination":
				fixture.resourceErrors = map[string]error{"acct:variable:apps/new": &response.ConjurError{Code: 403}}
			case "unknown-grant":
				source["permissions"].([]interface{})[0].(map[string]interface{})["privilege"] = "unknown"
			case "external-annotation":
				source["annotations"].([]interface{})[0].(map[string]interface{})["policy"] = "acct:policy:root"
			case "rotation":
				source["annotations"].([]interface{})[0].(map[string]interface{})["name"] = "rotation/ttl"
			case "dynamic":
				source["annotations"].([]interface{})[0].(map[string]interface{})["name"] = "dynamic/issuer"
			case "dynamic-namespace":
				request.Destination = "data/dynamic/new"
			case "too-many-versions":
				source["secrets"] = make([]interface{}, renameLimit+1)
			case "oversized-value":
				fixture.values["acct:variable:apps/old"][7] = strings.Repeat("x", 4097)
			case "different-policy":
				request.Destination = "other/new"
			case "tool-changed":
				service.login.enabled = false
			}
			review := renameCall(t, service, "review", request)
			if review.Status == "reviewed" {
				request.ApprovalID = review.ApprovalID
				switch scenario {
				case "source-drift":
					fixture.values["acct:variable:apps/old"][9] = "changed"
				case "suppressed-version":
					fixture.suppressVersions = true
				case "failed-write":
					fixture.failCommand = "secret-set-value"
				case "wrong-context":
					request.Target.Account = "other"
				case "expired":
					service.now = func() time.Time { return time.Now().Add(3 * time.Minute) }
				default:
					t.Fatalf("unsafe review allowed for %s", scenario)
				}
				out := renameCall(t, service, "copy", request)
				if out.Status == "copied" || out.FailureCode == "" {
					t.Fatalf("unsafe copy = %+v", out)
				}
			} else if review.FailureCode == "" {
				t.Fatalf("missing explicit failure: %+v", review)
			}
			for _, step := range fixture.writes {
				if step.CommandID == "secret-delete" {
					t.Fatal("failure deleted original")
				}
			}
		})
	}
}

func TestRenameDeleteRechecksBothSecretsAndRequiresTypedConfirmation(t *testing.T) {
	for _, scenario := range []string{"source", "destination-value", "destination-grant", "destination-version", "confirmation", "expired"} {
		t.Run(scenario, func(t *testing.T) {
			service, fixture, request := newRenameFixture(t)
			review := renameCall(t, service, "review", request)
			request.ApprovalID = review.ApprovalID
			copied := renameCall(t, service, "copy", request)
			if copied.Status != "copied" {
				t.Fatalf("copy = %+v", copied)
			}

			request.ApprovalID, request.Confirmation = copied.ApprovalID, "DELETE: apps/old"
			switch scenario {
			case "source":
				fixture.values["acct:variable:apps/old"][9] = "changed"
			case "destination-value":
				fixture.values["acct:variable:apps/new"][2] = "changed"
			case "destination-grant":
				fixture.resources["acct:variable:apps/new"]["permissions"] = []interface{}{}
			case "destination-version":
				fixture.resources["acct:variable:apps/new"]["secrets"].([]interface{})[0].(map[string]interface{})["expires_at"] = "2099-01-01T00:00:00Z"
			case "confirmation":
				request.Confirmation = ""
			case "expired":
				service.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
			}
			deleted := renameCall(t, service, "delete", request)
			if deleted.FailureCode == "" || fixture.resources["acct:variable:apps/old"] == nil {
				t.Fatalf("unsafe deletion = %+v", deleted)
			}
		})
	}
}

func TestRenameStepsUseTheReviewedPackAndEscapeAnnotations(t *testing.T) {
	service, fixture, request := newRenameFixture(t)
	registry, err := packs.NewLoader().LoadBuiltins(packassets.Builtins())
	if err != nil {
		t.Fatal(err)
	}
	state := readyConjurSnapshotWithExecutable(t).Tools()[0]
	loaded, _ := registry.FindPack(PackID)
	state.PackVersion = loaded.Pack.Metadata.Version
	snapshot := discovery.NewSnapshot([]discovery.ToolState{state})
	record := fixture.resources["acct:variable:apps/old"]
	annotation := record["annotations"].([]interface{})[0].(map[string]interface{})
	annotation["name"], annotation["value"] = "description:\n- !delete", "text\n- !delete"
	source, err := service.snapshot(t.Context(), fixture, request.Target)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(source.Values)
	for _, step := range renameSteps(request, source) {
		plan, err := planner.Build(registry, snapshot, planner.Request{PackID: step.PackID, CommandID: step.CommandID, Values: step.Values})
		if err != nil {
			t.Fatalf("%s: %v", step.CommandID, err)
		}
		if step.CommandID == "secret-annotate-owned" {
			want := "- !variable\n  id: \"new\"\n  owner: !group \"/owners\"\n  annotations:\n    \"description:\\n- !delete\": \"text\\n- !delete\"\n"
			if plan.Stdin != want {
				t.Fatalf("unsafe annotation template: %q", plan.Stdin)
			}
			if !slices.Equal(plan.Args, []string{"policy", "update", "--branch", "apps", "--file", "-"}) {
				t.Fatalf("unexpected argv: %v", plan.Args)
			}
		}
		if step.CommandID == "secret-set-value" && !plan.StdinSensitive {
			t.Fatal("historical values must stay on the reviewed sensitive stdin path")
		}
	}
}
