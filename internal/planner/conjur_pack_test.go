package planner

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"gopkg.in/yaml.v3"
)

func TestConjurPackBuildsDocumentedArgv(t *testing.T) {
	registry, snapshot := conjurPlannerFixture(t)

	plan, err := Build(registry, snapshot, Request{
		PackID:    "cyberark-conjur-v9",
		CommandID: "list-resources",
		Values: map[string]json.RawMessage{
			"kind":    rawJSON(t, "user"),
			"search":  rawJSON(t, "prod"),
			"limit":   rawJSON(t, "25"),
			"offset":  rawJSON(t, int64(10)),
			"role":    rawJSON(t, "account:group:ops"),
			"inspect": rawJSON(t, true),
		},
	})
	if err != nil {
		t.Fatalf("Build(list-resources) error = %v", err)
	}
	want := []string{"list", "--kind", "user", "--search", "prod", "--limit", "25", "--offset", "10", "--role", "account:group:ops", "--inspect", "--output", "json"}
	if !reflect.DeepEqual(plan.Args, want) {
		t.Fatalf("list args = %#v, want %#v", plan.Args, want)
	}
	if !plan.Requirements.RequiresAuth || plan.Requirements.AuthMode != packs.AuthModeVendorSession {
		t.Fatalf("list auth requirements = %#v", plan.Requirements)
	}

	plan, err = Build(registry, snapshot, Request{
		PackID:    "cyberark-conjur-v9",
		CommandID: "resource-permitted-roles",
		Values: map[string]json.RawMessage{
			"resource-id": rawJSON(t, "account:variable:apps/prod/password"),
			"privilege":   rawJSON(t, "read"),
		},
	})
	if err != nil {
		t.Fatalf("Build(resource-permitted-roles) error = %v", err)
	}
	want = []string{"resource", "permitted-roles", "account:variable:apps/prod/password", "read", "--output", "json"}
	if !reflect.DeepEqual(plan.Args, want) {
		t.Fatalf("resource args = %#v, want %#v", plan.Args, want)
	}
}

func TestConjurInventoryShortcutsUseFixedKindAndBoundedPagination(t *testing.T) {
	registry, snapshot := conjurPlannerFixture(t)
	for id, kind := range map[string]string{
		"list-variables": "variable",
		"list-policies": "policy",
		"list-hosts": "host",
		"list-groups": "group",
	} {
		t.Run(id, func(t *testing.T) {
			plan, err := Build(registry, snapshot, Request{
				PackID: "cyberark-conjur-v9", CommandID: id,
				Values: map[string]json.RawMessage{
					"limit": rawJSON(t, "25"), "offset": rawJSON(t, 50),
				},
			})
			if err != nil {
				t.Fatalf("Build(%s): %v", id, err)
			}
			want := []string{"list", "--kind", kind, "--limit", "25", "--offset", "50", "--output", "json"}
			if !slices.Equal(plan.Args, want) || plan.Risk != packs.RiskRead {
				t.Fatalf("%s argv = %v, risk = %s; want %v/read", id, plan.Args, plan.Risk, want)
			}
			if _, err := Build(registry, snapshot, Request{
				PackID: "cyberark-conjur-v9", CommandID: id,
				Values: map[string]json.RawMessage{"limit": rawJSON(t, "500")},
			}); err == nil {
				t.Fatal("unbounded inventory page accepted")
			}
		})
	}
}

func TestConjurListResourcesRequiresBoundedPageSize(t *testing.T) {
	registry, snapshot := conjurPlannerFixture(t)

	_, err := Build(registry, snapshot, Request{
		PackID:    "cyberark-conjur-v9",
		CommandID: "list-resources",
		Values:    map[string]json.RawMessage{},
	})
	var plannerErr *Error
	if !errors.As(err, &plannerErr) || plannerErr.Code != ErrMissingInput || plannerErr.Path != "values.limit" {
		t.Fatalf("Build(list-resources without limit) error = %T %v", err, err)
	}

	_, err = Build(registry, snapshot, Request{
		PackID:    "cyberark-conjur-v9",
		CommandID: "list-resources",
		Values: map[string]json.RawMessage{
			"limit": rawJSON(t, "10000"),
		},
	})
	if !errors.As(err, &plannerErr) || plannerErr.Code != ErrInvalidInput || plannerErr.Path != "values.limit" {
		t.Fatalf("Build(list-resources with unsafe limit) error = %T %v", err, err)
	}
}

func TestConjurCountResourcesDoesNotUseListPagination(t *testing.T) {
	registry, snapshot := conjurPlannerFixture(t)

	plan, err := Build(registry, snapshot, Request{
		PackID:    "cyberark-conjur-v9",
		CommandID: "count-resources",
		Values: map[string]json.RawMessage{
			"kind":   rawJSON(t, "variable"),
			"search": rawJSON(t, "prod"),
			"role":   rawJSON(t, "account:group:ops"),
		},
	})
	if err != nil {
		t.Fatalf("Build(count-resources) error = %v", err)
	}
	want := []string{"list", "--kind", "variable", "--search", "prod", "--role", "account:group:ops", "--count", "--output", "json"}
	if !reflect.DeepEqual(plan.Args, want) {
		t.Fatalf("count args = %#v, want %#v", plan.Args, want)
	}
	if plan.Output.Structured == nil || len(plan.Output.Structured.Fields) != 1 || plan.Output.Structured.Fields[0].Key != "count" {
		t.Fatalf("count structured output = %#v", plan.Output.Structured)
	}
}

func TestConjurPositionalInputCannotBecomeUndeclaredFlag(t *testing.T) {
	registry, snapshot := conjurPlannerFixture(t)
	_, err := Build(registry, snapshot, Request{
		PackID:    "cyberark-conjur-v9",
		CommandID: "resource-show",
		Values: map[string]json.RawMessage{
			"resource-id": rawJSON(t, "--help"),
		},
	})
	assertPlannerCode(t, err, ErrInvalidInput)
}

func TestConjurWhoamiUsesVendorSessionWithoutCredentialArguments(t *testing.T) {
	registry, snapshot := conjurPlannerFixture(t)
	plan, err := Build(registry, snapshot, Request{
		PackID:    "cyberark-conjur-v9",
		CommandID: "whoami",
		Values:    map[string]json.RawMessage{},
	})
	if err != nil {
		t.Fatalf("Build(whoami) error = %v", err)
	}
	want := []string{"whoami", "--output", "json"}
	if !reflect.DeepEqual(plan.Args, want) {
		t.Fatalf("whoami args = %#v, want %#v", plan.Args, want)
	}
	if !plan.Requirements.RequiresAuth || plan.Requirements.AuthMode != packs.AuthModeVendorSession {
		t.Fatalf("whoami auth requirements = %#v", plan.Requirements)
	}
}

func conjurPlannerFixture(t *testing.T) (*packs.Registry, discovery.Snapshot) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "packs", "conjur", "conjur-v9.yaml"))
	if err != nil {
		t.Fatalf("read Conjur pack: %v", err)
	}
	pack, err := packs.Parse(data)
	if err != nil {
		t.Fatalf("parse Conjur pack: %v", err)
	}
	registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: pack}})
	if err != nil {
		t.Fatalf("create registry: %v", err)
	}
	executable := filepath.Join(t.TempDir(), "conjur")
	if err := os.WriteFile(executable, []byte("fixture"), 0o755); err != nil {
		t.Fatalf("write executable fixture: %v", err)
	}
	identity, err := discovery.CaptureExecutableIdentity(executable)
	if err != nil {
		t.Fatalf("capture executable identity: %v", err)
	}
	snapshot := discovery.NewSnapshot([]discovery.ToolState{{
		PackID:             "cyberark-conjur-v9",
		PackVersion:        pack.Metadata.Version,
		ToolID:             "conjur",
		Status:             discovery.StatusReady,
		Path:               executable,
		ExecutableName:     filepath.Base(executable),
		Version:            "9.3.1",
		VersionConstraint:  ">=9.3.1-0 <10.0.0-0",
		ExecutableIdentity: identity,
	}})
	return registry, snapshot
}

func TestConjurSecretTasksSendExactPolicyOnStdin(t *testing.T) {
	registry, snapshot := conjurPlannerFixture(t)
	build := func(commandID string, values map[string]any) Plan {
		t.Helper()
		raw := make(map[string]json.RawMessage, len(values))
		for id, value := range values {
			raw[id] = rawJSON(t, value)
		}
		plan, err := Build(registry, snapshot, Request{PackID: "cyberark-conjur-v9", CommandID: commandID, Values: raw})
		if err != nil {
			t.Fatalf("Build(%s) error = %v", commandID, err)
		}
		return plan
	}

	// A hostile role ID must stay one YAML scalar and cannot add statements.
	hostile := "ops\"\n- !permit\n  role: !user /admin"
	plan := build("secret-permit", map[string]any{
		"policy-branch": "apps/myapp", "variable-id": "db/password",
		"role-kind": "host", "role-id": hostile, "privileges": "read, execute", "dry-run": true,
	})
	if want := []string{"policy", "update", "--branch", "apps/myapp", "--file", "-", "--dry-run"}; !reflect.DeepEqual(plan.Args, want) {
		t.Fatalf("permit args = %#v, want %#v", plan.Args, want)
	}
	wantStdin := "- !permit\n  role: !host \"ops\\\"\\n- !permit\\n  role: !user /admin\"\n  privileges: [ read, execute ]\n  resource: !variable \"db/password\"\n"
	if plan.Stdin != wantStdin || plan.StdinSensitive || plan.Impact == nil || plan.Impact.Target != "db/password" {
		t.Fatalf("permit plan stdin = %q sensitive = %v impact = %#v", plan.Stdin, plan.StdinSensitive, plan.Impact)
	}
	var statements []map[string]yaml.Node
	if err := yaml.Unmarshal([]byte(plan.Stdin), &statements); err != nil || len(statements) != 1 {
		t.Fatalf("permit stdin parsed into %d statements, err = %v", len(statements), err)
	}
	if role := statements[0]["role"]; role.Tag != "!host" || role.Value != hostile {
		t.Fatalf("permit role node = %s %q", role.Tag, role.Value)
	}

	plan = build("secret-deny", map[string]any{
		"policy-branch": "root", "variable-id": "db/password", "role-kind": "group", "role-id": "/ops", "privileges": "execute",
	})
	if want := "- !deny\n  role: !group \"/ops\"\n  privileges: [ execute ]\n  resource: !variable \"db/password\"\n"; plan.Stdin != want {
		t.Fatalf("deny stdin = %q", plan.Stdin)
	}
	plan = build("secret-create", map[string]any{"policy-branch": "root", "variable-id": "db/password"})
	if want := "- !variable\n  id: \"db/password\"\n"; plan.Stdin != want || plan.Risk != packs.RiskChange {
		t.Fatalf("create stdin = %q risk = %s", plan.Stdin, plan.Risk)
	}
	plan = build("secret-delete", map[string]any{"policy-branch": "root", "variable-id": "db/password"})
	if want := "- !delete\n  record: !variable \"db/password\"\n"; plan.Stdin != want || plan.Risk != packs.RiskDestructive {
		t.Fatalf("delete stdin = %q risk = %s", plan.Stdin, plan.Risk)
	}

	secret := "s3cr3t value\nwith newline"
	plan = build("secret-set-value", map[string]any{"variable-id": "apps/myapp/db/password", "value": secret})
	if want := []string{"variable", "set", "--id", "apps/myapp/db/password", "--file", "-"}; !reflect.DeepEqual(plan.Args, want) {
		t.Fatalf("set-value args = %#v, want %#v", plan.Args, want)
	}
	if plan.Stdin != secret || !plan.StdinSensitive {
		t.Fatalf("set-value stdin sensitive = %v", plan.StdinSensitive)
	}
}
