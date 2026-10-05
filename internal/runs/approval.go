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
		PackID         string                 `json:"packId"`
		PackVersion    string                 `json:"packVersion"`
		CommandID      string                 `json:"commandId"`
		ToolID         string                 `json:"toolId"`
		ToolVersion    string                 `json:"toolVersion"`
		ExecutablePath string                 `json:"executablePath"`
		ExecutableName string                 `json:"executableName"`
		Args           []string               `json:"args"`
		Risk           packs.Risk             `json:"risk"`
		Impact         *planner.MutationImpact `json:"impact"`
		Context        ExecutionContext       `json:"context"`
	}{
		PackID:         plan.PackID,
		PackVersion:    plan.PackVersion,
		CommandID:      plan.CommandID,
		ToolID:         plan.ToolID,
		ToolVersion:    plan.ToolVersion,
		ExecutablePath: plan.ExecutablePath,
		ExecutableName: plan.ExecutableName,
		Args:           append([]string(nil), plan.Args...),
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
