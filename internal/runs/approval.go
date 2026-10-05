package runs

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

const (
	defaultApprovalTTL  = 2 * time.Minute
	defaultMaxApprovals = 64
)

type ApprovalMode string

const (
	ApprovalModeExplicit ApprovalMode = "explicit"
	ApprovalModeTyped    ApprovalMode = "typed"
)

type ExecutionContextField struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// ExecutionContext is deliberately browser-safe operator context. It must never
// contain credentials, local credential paths, tokens, or other secret material.
type ExecutionContext struct {
	Fields []ExecutionContextField `json:"fields"`
}

type MutationImpact struct {
	TargetLabel string            `json:"targetLabel"`
	Target      string            `json:"target"`
	Effect      string            `json:"effect"`
	Scope       packs.ImpactScope `json:"scope"`
}

type ApprovalChallenge struct {
	ID           string       `json:"id"`
	ExpiresAt    time.Time    `json:"expiresAt"`
	Mode         ApprovalMode `json:"mode"`
	RequiredText string       `json:"requiredText,omitempty"`
}

type ApprovalSubmission struct {
	ID           string
	Confirmation string
}

type approvalRecord struct {
	fingerprint  [sha256.Size]byte
	expiresAt    time.Time
	issuedAt     time.Time
	mode         ApprovalMode
	requiredText string
}

func mutationImpact(plan planner.Plan) *MutationImpact {
	if plan.Impact == nil {
		return nil
	}
	return &MutationImpact{
		TargetLabel: plan.Impact.TargetLabel,
		Target:      plan.Impact.Target,
		Effect:      plan.Impact.Effect,
		Scope:       plan.Impact.Scope,
	}
}

func requiresApproval(plan planner.Plan) bool {
	return plan.Risk == packs.RiskChange || plan.Risk == packs.RiskDestructive
}

func approvalRequirement(plan planner.Plan) (ApprovalMode, string, error) {
	if !requiresApproval(plan) {
		return "", "", nil
	}
	if plan.Impact == nil {
		return "", "", fmt.Errorf("mutation plan is missing impact")
	}
	if plan.Impact.Scope == packs.ImpactScopeMultiple {
		if plan.Risk == packs.RiskDestructive {
			return ApprovalModeTyped, "DELETE MULTIPLE: " + plan.Impact.Target, nil
		}
		return ApprovalModeTyped, "APPROVE MULTIPLE: " + plan.Impact.Target, nil
	}
	if plan.Risk == packs.RiskDestructive {
		return ApprovalModeTyped, "DELETE: " + plan.Impact.Target, nil
	}
	return ApprovalModeExplicit, "", nil
}

func approvalFingerprint(plan planner.Plan, context ExecutionContext) ([sha256.Size]byte, error) {
	payload := struct {
		PackID         string                  `json:"packId"`
		PackVersion    string                  `json:"packVersion"`
		CommandID      string                  `json:"commandId"`
		ToolID         string                  `json:"toolId"`
		ToolVersion    string                  `json:"toolVersion"`
		ExecutablePath string                  `json:"executablePath"`
		ExecutableName string                  `json:"executableName"`
		Args           []string                `json:"args"`
		Stdin          string                  `json:"stdin"`
		Risk           packs.Risk              `json:"risk"`
		Impact         *planner.MutationImpact `json:"impact"`
		Context        ExecutionContext        `json:"context"`
	}{
		PackID:         plan.PackID,
		PackVersion:    plan.PackVersion,
		CommandID:      plan.CommandID,
		ToolID:         plan.ToolID,
		ToolVersion:    plan.ToolVersion,
		ExecutablePath: plan.ExecutablePath,
		ExecutableName: plan.ExecutableName,
		Args:           append([]string(nil), plan.Args...),
		Stdin:          plan.Stdin,
		Risk:           plan.Risk,
		Impact:         plan.Impact,
		Context:        context,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	return sha256.Sum256(encoded), nil
}

func validateExecutionContext(context ExecutionContext) error {
	if len(context.Fields) == 0 || len(context.Fields) > 8 {
		return fmt.Errorf("execution context must contain 1-8 fields")
	}
	seen := make(map[string]struct{}, len(context.Fields))
	for _, field := range context.Fields {
		if !safeContextText(field.Label, 80) || !safeContextText(field.Value, 2048) {
			return fmt.Errorf("execution context contains unsafe display text")
		}
		if _, exists := seen[field.Label]; exists {
			return fmt.Errorf("execution context contains duplicate labels")
		}
		seen[field.Label] = struct{}{}
	}
	return nil
}

func safeContextText(value string, max int) bool {
	if value == "" || len(value) > max || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if character <= 0x1f || character == 0x7f {
			return false
		}
	}
	return true
}

func (m *Manager) executionContextFor(plan planner.Plan) (ExecutionContext, error) {
	if !requiresApproval(plan) {
		return ExecutionContext{}, nil
	}
	if m == nil || m.config.ResolveExecutionContext == nil {
		return ExecutionContext{}, &Error{Code: ErrContextUnavailable}
	}
	context, err := m.config.ResolveExecutionContext(plan.Clone())
	if err != nil || validateExecutionContext(context) != nil {
		return ExecutionContext{}, &Error{Code: ErrContextUnavailable}
	}
	context.Fields = append([]ExecutionContextField(nil), context.Fields...)
	return context, nil
}

func (m *Manager) issueApproval(plan planner.Plan, context ExecutionContext) (*ApprovalChallenge, error) {
	mode, requiredText, err := approvalRequirement(plan)
	if err != nil {
		return nil, &Error{Code: ErrPolicyBlocked}
	}
	fingerprint, err := approvalFingerprint(plan, context)
	if err != nil {
		return nil, fmt.Errorf("fingerprint mutation approval")
	}
	id, err := m.config.NewApprovalID()
	if err != nil || !validRunID(id) {
		return nil, fmt.Errorf("generate approval identifier")
	}
	now := m.config.Now()
	expiresAt := now.Add(m.config.ApprovalTTL)

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.ctx.Err() != nil {
		return nil, &Error{Code: ErrClosed}
	}
	m.pruneApprovalsLocked(now)
	if len(m.approvals) >= m.config.MaxApprovals {
		m.evictOldestApprovalLocked()
	}
	m.approvals[id] = approvalRecord{
		fingerprint:  fingerprint,
		expiresAt:    expiresAt,
		issuedAt:     now,
		mode:         mode,
		requiredText: requiredText,
	}
	return &ApprovalChallenge{
		ID:           id,
		ExpiresAt:    expiresAt,
		Mode:         mode,
		RequiredText: requiredText,
	}, nil
}

func (m *Manager) consumeApprovalLocked(fingerprint [sha256.Size]byte, submission *ApprovalSubmission, now time.Time) error {
	m.pruneApprovalsLocked(now)
	if submission == nil || !validRunID(submission.ID) {
		return &Error{Code: ErrApprovalRequired}
	}
	record, ok := m.approvals[submission.ID]
	if !ok {
		return &Error{Code: ErrApprovalRequired}
	}
	if record.fingerprint != fingerprint {
		delete(m.approvals, submission.ID)
		return &Error{Code: ErrApprovalRequired}
	}
	if record.mode == ApprovalModeTyped && submission.Confirmation != record.requiredText {
		return &Error{Code: ErrApprovalRequired}
	}
	if record.mode == ApprovalModeExplicit && submission.Confirmation != "" {
		return &Error{Code: ErrApprovalRequired}
	}
	delete(m.approvals, submission.ID)
	return nil
}

func (m *Manager) pruneApprovalsLocked(now time.Time) {
	for id, record := range m.approvals {
		if !now.Before(record.expiresAt) {
			delete(m.approvals, id)
		}
	}
}

func (m *Manager) evictOldestApprovalLocked() {
	var oldestID string
	var oldest time.Time
	for id, record := range m.approvals {
		if oldestID == "" || record.issuedAt.Before(oldest) || (record.issuedAt.Equal(oldest) && id < oldestID) {
			oldestID = id
			oldest = record.issuedAt
		}
	}
	if oldestID != "" {
		delete(m.approvals, oldestID)
	}
}
