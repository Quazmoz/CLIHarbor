package apperror

import "strings"

// Category groups stable operator-facing failures without exposing internal causes.
type Category string

const (
	CategoryValidation Category = "validation"
	CategorySecurity   Category = "security"
	CategoryDiscovery  Category = "discovery"
	CategoryPolicy     Category = "policy"
	CategoryCapacity   Category = "capacity"
	CategoryLifecycle  Category = "lifecycle"
	CategoryStream     Category = "stream"
	CategoryExecution  Category = "execution"
	CategoryInternal   Category = "internal"
)

// Code is a stable machine-readable operator error identifier.
type Code string

const (
	CodeInvalidRequest     Code = "invalid_request"
	CodeInvalidInput       Code = "invalid_input"
	CodeRequestTooLarge    Code = "request_too_large"
	CodeMethodNotAllowed   Code = "method_not_allowed"
	CodeRequestForbidden   Code = "request_forbidden"
	CodeSessionUnavailable Code = "session_unavailable"
	CodeResourceNotFound   Code = "resource_not_found"
	CodeCommandBlocked     Code = "command_blocked"
	CodeToolUnavailable    Code = "tool_unavailable"
	CodeToolChanged        Code = "tool_changed"
	CodeRunCapacity        Code = "run_capacity"
	CodeRunNotFound        Code = "run_not_found"
	CodeRuntimeClosed      Code = "runtime_closed"
	CodeInvalidCursor      Code = "invalid_cursor"
	CodeStreamCapacity     Code = "stream_capacity"
	CodeStreamUnavailable  Code = "stream_unavailable"
	CodeExecutionFailed    Code = "execution_failed"
	CodeOutputLimit        Code = "output_limit"
	CodeEventCapacity      Code = "event_capacity"
	CodeInternalError      Code = "internal_error"
)

// Detail is the complete browser-safe error DTO. Messages and remediation are
// selected from a closed set rather than copied from internal or vendor errors.
type Detail struct {
	Code        Code     `json:"code"`
	Category    Category `json:"category"`
	Message     string   `json:"message"`
	Remediation string   `json:"remediation,omitempty"`
	Retryable   bool     `json:"retryable"`
	Field       string   `json:"field,omitempty"`
}

// DetailFor returns the reviewed operator-facing representation for code.
func DetailFor(code Code) Detail {
	switch code {
	case CodeInvalidRequest:
		return Detail{Code: code, Category: CategoryValidation, Message: "The request was not accepted.", Remediation: "Review the task and submit only the fields CLIHarbor provides."}
	case CodeInvalidInput:
		return Detail{Code: code, Category: CategoryValidation, Message: "One or more task inputs are invalid.", Remediation: "Correct the highlighted field and retry."}
	case CodeRequestTooLarge:
		return Detail{Code: code, Category: CategoryValidation, Message: "The request is larger than CLIHarbor accepts.", Remediation: "Reduce the task input and retry."}
	case CodeMethodNotAllowed:
		return Detail{Code: code, Category: CategoryValidation, Message: "That operation is not supported on this local endpoint."}
	case CodeRequestForbidden:
		return Detail{Code: code, Category: CategorySecurity, Message: "The local request was rejected by CLIHarbor's browser security boundary.", Remediation: "Reload CLIHarbor from its launcher and retry."}
	case CodeSessionUnavailable:
		return Detail{Code: code, Category: CategorySecurity, Message: "The local browser session is not active.", Remediation: "Relaunch CLIHarbor to establish a new secure session."}
	case CodeResourceNotFound:
		return Detail{Code: code, Category: CategoryLifecycle, Message: "The requested local resource is unavailable.", Remediation: "Reload CLIHarbor and retry from the current task list."}
	case CodeCommandBlocked:
		return Detail{Code: code, Category: CategoryPolicy, Message: "The task is not permitted by the current local execution policy.", Remediation: "Choose a task currently exposed by CLIHarbor. Use cliharbor doctor if the browser metadata appears stale."}
	case CodeToolUnavailable:
		return Detail{Code: code, Category: CategoryDiscovery, Message: "The required tool is not ready for execution.", Remediation: "Run cliharbor doctor, then install or configure the declared tool with an explicit backend --tool-path if needed."}
	case CodeToolChanged:
		return Detail{Code: code, Category: CategoryDiscovery, Message: "The executable changed after CLIHarbor discovered it.", Remediation: "Relaunch CLIHarbor to collect fresh discovery evidence, then retry.", Retryable: true}
	case CodeRunCapacity:
		return Detail{Code: code, Category: CategoryCapacity, Message: "CLIHarbor is already running the maximum number of tasks.", Remediation: "Wait for an active run to finish or cancel one, then retry.", Retryable: true}
	case CodeRunNotFound:
		return Detail{Code: code, Category: CategoryLifecycle, Message: "This run is no longer available in local retention.", Remediation: "Start the task again if you still need the result."}
	case CodeRuntimeClosed:
		return Detail{Code: code, Category: CategoryLifecycle, Message: "CLIHarbor is shutting down and cannot start new work.", Remediation: "Relaunch CLIHarbor and retry."}
	case CodeInvalidCursor:
		return Detail{Code: code, Category: CategoryStream, Message: "The requested live-stream position is not valid.", Remediation: "Refresh the run status and reopen live updates.", Retryable: true}
	case CodeStreamCapacity:
		return Detail{Code: code, Category: CategoryCapacity, Message: "CLIHarbor has reached its live-stream observer limit.", Remediation: "Close another live run view or retry live updates shortly.", Retryable: true}
	case CodeStreamUnavailable:
		return Detail{Code: code, Category: CategoryStream, Message: "Live run updates are temporarily unavailable.", Remediation: "Refresh the run status and retry live updates if the run is still active.", Retryable: true}
	case CodeExecutionFailed:
		return Detail{Code: code, Category: CategoryExecution, Message: "CLIHarbor could not complete the local process lifecycle.", Remediation: "Review the run state and use cliharbor doctor for local diagnostics before retrying."}
	case CodeOutputLimit:
		return Detail{Code: code, Category: CategoryExecution, Message: "Run output exceeded CLIHarbor's local safety limit.", Remediation: "Narrow the task input or use the trusted CLI directly if complete local output is required."}
	case CodeEventCapacity:
		return Detail{Code: code, Category: CategoryExecution, Message: "CLIHarbor reached the local retained-event limit for this run.", Remediation: "Narrow the task output and start a new run."}
	case CodeInternalError:
		fallthrough
	default:
		return Detail{Code: CodeInternalError, Category: CategoryInternal, Message: "CLIHarbor encountered an internal local error.", Remediation: "Run cliharbor doctor for local diagnostics before retrying."}
	}
}

// WithField associates a reviewed validation field without permitting arbitrary
// paths or internal implementation names into the browser DTO.
func WithField(detail Detail, field string) Detail {
	if validField(field) {
		detail.Field = field
	}
	return detail
}

func validField(field string) bool {
	if field == "packId" || field == "commandId" {
		return true
	}
	if !strings.HasPrefix(field, "values.") {
		return false
	}
	id := strings.TrimPrefix(field, "values.")
	if len(id) == 0 || len(id) > 63 || id[0] < 'a' || id[0] > 'z' {
		return false
	}
	for _, r := range id[1:] {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return true
}
