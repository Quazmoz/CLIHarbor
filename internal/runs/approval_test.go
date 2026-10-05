package runs

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

func TestManagerMutationApprovalIsBackendBoundSingleUseAndContextAware(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	registry, snapshot := managerFixture(t)
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	contextAccount := "account-a"

	manager := newTestManager(t, registry, snapshot, Config{
		Now:         func() time.Time { return now },
		ApprovalTTL: 2 * time.Minute,
		NewApprovalID: fixedRunIDs(
			strings.Repeat("a", 32),
			strings.Repeat("b", 32),
			strings.Repeat("c", 32),
			strings.Repeat("d", 32),
		),
		NewRunID: fixedRunIDs(
			strings.Repeat("1", 32),
			strings.Repeat("2", 32),
			strings.Repeat("3", 32),
			strings.Repeat("4", 32),
			strings.Repeat("5", 32),
			strings.Repeat("6", 32),
		),
		ResolveExecutionContext: func(plan planner.Plan) (ExecutionContext, error) {
			return ExecutionContext{Fields: []ExecutionContextField{
				{Label: "Account", Value: contextAccount},
				{Label: "Endpoint", Value: "https://conjur.example.test"},
			}}, nil
		},
	})

	values := map[string]json.RawMessage{"target": rawRunJSON(t, "alpha")}
	preview, err := manager.Preview(Request{PackID: "fixture", CommandID: "change", Values: values})
	if err != nil {
		t.Fatalf("Preview(change) error = %v", err)
	}
	if preview.Risk != "change" || preview.Impact == nil || preview.Impact.Target != "alpha" || preview.Context == nil {
		t.Fatalf("preview mutation metadata = %#v", preview)
	}
	if preview.Approval == nil || preview.Approval.Mode != ApprovalModeExplicit || preview.Approval.RequiredText != "" {
		t.Fatalf("preview approval = %#v", preview.Approval)
	}

	_, err = manager.Start(Request{PackID: "fixture", CommandID: "change", Values: values})
	assertRunCode(t, err, ErrApprovalRequired)

	started, err := manager.Start(Request{
		PackID: "fixture", CommandID: "change", Values: values,
		Approval: &ApprovalSubmission{ID: preview.Approval.ID},
	})
	if err != nil {
		t.Fatalf("approved Start(change) error = %v", err)
	}
	waitCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	finished, err := manager.Wait(waitCtx, started.RunID)
	if err != nil || finished.Status != StatusExited {
		t.Fatalf("approved change finished = %#v, err = %v", finished, err)
	}

	_, err = manager.Start(Request{
		PackID: "fixture", CommandID: "change", Values: values,
		Approval: &ApprovalSubmission{ID: preview.Approval.ID},
	})
	assertRunCode(t, err, ErrApprovalRequired)

	mismatchPreview, err := manager.Preview(Request{PackID: "fixture", CommandID: "change", Values: values})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Start(Request{
		PackID: "fixture", CommandID: "change",
		Values:   map[string]json.RawMessage{"target": rawRunJSON(t, "beta")},
		Approval: &ApprovalSubmission{ID: mismatchPreview.Approval.ID},
	})
	assertRunCode(t, err, ErrApprovalRequired)

	contextPreview, err := manager.Preview(Request{PackID: "fixture", CommandID: "change", Values: values})
	if err != nil {
		t.Fatal(err)
	}
	contextAccount = "account-b"
	_, err = manager.Start(Request{
		PackID: "fixture", CommandID: "change", Values: values,
		Approval: &ApprovalSubmission{ID: contextPreview.Approval.ID},
	})
	assertRunCode(t, err, ErrApprovalRequired)

	contextAccount = "account-a"
	expiringPreview, err := manager.Preview(Request{PackID: "fixture", CommandID: "change", Values: values})
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(3 * time.Minute)
	_, err = manager.Start(Request{
		PackID: "fixture", CommandID: "change", Values: values,
		Approval: &ApprovalSubmission{ID: expiringPreview.Approval.ID},
	})
	assertRunCode(t, err, ErrApprovalRequired)
}

func TestManagerMultipleRecordDestructiveApprovalRequiresExactTypedText(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	registry, snapshot := managerFixture(t)

	manager := newTestManager(t, registry, snapshot, Config{
		NewApprovalID: fixedRunIDs(strings.Repeat("e", 32)),
		NewRunID: fixedRunIDs(
			strings.Repeat("7", 32),
			strings.Repeat("8", 32),
		),
		ResolveExecutionContext: func(plan planner.Plan) (ExecutionContext, error) {
			return ExecutionContext{Fields: []ExecutionContextField{
				{Label: "Account", Value: "account-a"},
				{Label: "Endpoint", Value: "https://conjur.example.test"},
			}}, nil
		},
	})

	values := map[string]json.RawMessage{"target": rawRunJSON(t, "ops")}
	preview, err := manager.Preview(Request{PackID: "fixture", CommandID: "bulk-delete", Values: values})
	if err != nil {
		t.Fatalf("Preview(bulk-delete) error = %v", err)
	}
	if preview.Approval == nil || preview.Approval.Mode != ApprovalModeTyped {
		t.Fatalf("approval = %#v", preview.Approval)
	}
	if got, want := preview.Approval.RequiredText, "DELETE MULTIPLE: ops"; got != want {
		t.Fatalf("required text = %q, want %q", got, want)
	}
	if preview.Impact == nil || preview.Impact.Scope != "multiple" {
		t.Fatalf("impact = %#v", preview.Impact)
	}

	_, err = manager.Start(Request{
		PackID: "fixture", CommandID: "bulk-delete", Values: values,
		Approval: &ApprovalSubmission{ID: preview.Approval.ID, Confirmation: "DELETE MULTIPLE: wrong"},
	})
	assertRunCode(t, err, ErrApprovalRequired)

	started, err := manager.Start(Request{
		PackID: "fixture", CommandID: "bulk-delete", Values: values,
		Approval: &ApprovalSubmission{ID: preview.Approval.ID, Confirmation: preview.Approval.RequiredText},
	})
	if err != nil {
		t.Fatalf("typed approved Start() error = %v", err)
	}
	waitCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	finished, err := manager.Wait(waitCtx, started.RunID)
	if err != nil || finished.Status != StatusExited {
		t.Fatalf("typed approved run = %#v, err = %v", finished, err)
	}
}

func TestManagerMutationFailsClosedWithoutTrustedExecutionContext(t *testing.T) {
	registry, snapshot := managerFixture(t)
	manager := newTestManager(t, registry, snapshot, Config{})

	_, err := manager.Preview(Request{
		PackID: "fixture", CommandID: "change",
		Values: map[string]json.RawMessage{"target": rawRunJSON(t, "alpha")},
	})
	assertRunCode(t, err, ErrContextUnavailable)
}

func TestManagerPreviewNeverEchoesSecretStdinAndApprovalBindsIt(t *testing.T) {
	t.Setenv(managerHelperEnv, "1")
	registry, snapshot := managerFixture(t)
	manager := newTestManager(t, registry, snapshot, Config{
		NewApprovalID: fixedRunIDs(strings.Repeat("a", 32), strings.Repeat("b", 32)),
		NewRunID:      fixedRunIDs(strings.Repeat("1", 32)),
		ResolveExecutionContext: func(plan planner.Plan) (ExecutionContext, error) {
			return ExecutionContext{Fields: []ExecutionContextField{{Label: "Account", Value: "account-a"}}}, nil
		},
	})

	policy, err := manager.Preview(Request{PackID: "fixture", CommandID: "policy", Values: map[string]json.RawMessage{"target": rawRunJSON(t, "db/password")}})
	if err != nil || policy.Stdin != "- !variable\n  id: \"db/password\"\n" {
		t.Fatalf("policy preview stdin = %q, err = %v", policy.Stdin, err)
	}

	secret := "correct horse battery staple"
	values := map[string]json.RawMessage{"target": rawRunJSON(t, "db/password"), "value": rawRunJSON(t, secret)}
	preview, err := manager.Preview(Request{PackID: "fixture", CommandID: "set-secret", Values: values})
	if err != nil {
		t.Fatalf("Preview(set-secret) error = %v", err)
	}
	encoded, _ := json.Marshal(preview)
	if preview.Stdin != "" || strings.Contains(string(encoded), secret) {
		t.Fatalf("secret preview leaked stdin: %s", encoded)
	}

	_, err = manager.Start(Request{
		PackID: "fixture", CommandID: "set-secret",
		Values:   map[string]json.RawMessage{"target": rawRunJSON(t, "db/password"), "value": rawRunJSON(t, "swapped")},
		Approval: &ApprovalSubmission{ID: preview.Approval.ID},
	})
	assertRunCode(t, err, ErrApprovalRequired)
}
