package runs

import (
	"errors"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/apperror"
	"github.com/Quazmoz/CLIHarbor/internal/executor"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

func TestPlannerFailureClassificationDoesNotForwardMessages(t *testing.T) {
	const marker = "PRIVATE_INTERNAL_MARKER"
	tests := []struct {
		in        *planner.Error
		wantCode  ErrorCode
		wantField string
	}{
		{in: &planner.Error{Code: planner.ErrInvalidInput, Path: "values.query", Message: marker}, wantCode: ErrInvalidRequest, wantField: "values.query"},
		{in: &planner.Error{Code: planner.ErrToolUnavailable, Path: "tool", Message: marker}, wantCode: ErrToolUnavailable},
		{in: &planner.Error{Code: planner.ErrStaleDiscovery, Path: "tool", Message: marker}, wantCode: ErrToolChanged},
		{in: &planner.Error{Code: planner.ErrRiskPolicy, Path: "commandId", Message: marker}, wantCode: ErrPolicyBlocked},
	}
	for _, test := range tests {
		err := classifyPlannerError(test.in)
		var runErr *Error
		if !errors.As(err, &runErr) {
			t.Fatalf("classification = %T %v", err, err)
		}
		if runErr.Code != test.wantCode || runErr.Field != test.wantField {
			t.Fatalf("classification = %#v, want code=%s field=%q", runErr, test.wantCode, test.wantField)
		}
		if strings.Contains(runErr.Error(), marker) {
			t.Fatalf("classification leaked planner detail: %v", runErr)
		}
	}
}

func TestExecutionFailureClassificationIsStable(t *testing.T) {
	tests := []struct {
		err  error
		code apperror.Code
	}{
		{err: &executor.Error{Code: executor.ErrExecutableChanged, Message: "PRIVATE_PATH_MARKER"}, code: apperror.CodeToolChanged},
		{err: &executor.Error{Code: executor.ErrOutputLimit, Message: "PRIVATE_VALUE_MARKER"}, code: apperror.CodeOutputLimit},
		{err: errors.New("PRIVATE_INTERNAL_MARKER"), code: apperror.CodeExecutionFailed},
		{err: errEventCapacity, code: apperror.CodeEventCapacity},
	}
	for _, test := range tests {
		detail := classifyExecutionFailure(test.err)
		if detail.Code != test.code {
			t.Fatalf("failure code = %s, want %s", detail.Code, test.code)
		}
		if strings.Contains(detail.Message, "PRIVATE_") || strings.Contains(detail.Remediation, "PRIVATE_") {
			t.Fatalf("safe failure leaked internal detail: %#v", detail)
		}
	}
}
