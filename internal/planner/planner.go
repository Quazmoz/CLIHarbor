package planner

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

type ErrorCode string

const (
	ErrUnknownPack      ErrorCode = "unknown_pack"
	ErrUnknownCommand   ErrorCode = "unknown_command"
	ErrToolUnavailable  ErrorCode = "tool_unavailable"
	ErrStaleDiscovery   ErrorCode = "stale_discovery"
	ErrUnknownInput     ErrorCode = "unknown_input"
	ErrMissingInput     ErrorCode = "missing_input"
	ErrInvalidInput     ErrorCode = "invalid_input"
	ErrRiskPolicy       ErrorCode = "risk_policy_required"
	ErrAuthPolicy       ErrorCode = "auth_policy_required"
	ErrOutputPolicy     ErrorCode = "output_policy_required"
	ErrInvalidPlanState ErrorCode = "invalid_plan_state"
)

type Error struct {
	Code    ErrorCode
	Path    string
	Message string
}

func (e *Error) Error() string {
	if e.Path == "" {
		return fmt.Sprintf("%s: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("%s at %s: %s", e.Code, e.Path, e.Message)
}

type Request struct {
	PackID    string
	CommandID string
	Values    map[string]json.RawMessage
}

type Plan struct {
	PackID         string
	PackVersion    string
	CommandID      string
	ToolID         string
	ExecutablePath string
	ExecutableName string
	ToolVersion    string
	Args           []string
	Risk           packs.Risk
	Output         packs.Output
	Requirements   packs.Requirements
}

func (p Plan) Clone() Plan {
	p.Args = append([]string(nil), p.Args...)
	return p
}

type value struct {
	present  bool
	text     string
	argument string
	boolean  bool
	many     []string
}

func Build(registry *packs.Registry, snapshot discovery.Snapshot, request Request) (Plan, error) {
	var zero Plan
	if registry == nil {
		return zero, &Error{Code: ErrInvalidPlanState, Message: "pack registry is required"}
	}
	loaded, ok := registry.FindPack(request.PackID)
	if !ok {
		return zero, &Error{Code: ErrUnknownPack, Path: "packId", Message: "pack is not configured"}
	}
	command, ok := registry.FindCommand(request.PackID, request.CommandID)
	if !ok {
		return zero, &Error{Code: ErrUnknownCommand, Path: "commandId", Message: "command is not declared by the configured pack"}
	}
	if command.Risk != packs.RiskRead {
		return zero, &Error{Code: ErrRiskPolicy, Path: "commandId", Message: "this execution milestone permits read-only commands only"}
	}
	if command.Requirements.RequiresAuth {
		return zero, &Error{Code: ErrAuthPolicy, Path: "commandId", Message: "authenticated commands remain disabled until the auth adapter exists"}
	}
	if command.Output.Sensitivity.ContainsSecrets {
		return zero, &Error{Code: ErrOutputPolicy, Path: "commandId", Message: "secret-bearing commands remain disabled until output redaction/reveal policy exists"}
	}

	toolState, ok := snapshot.Find(discovery.ToolRef{PackID: request.PackID, ToolID: command.Tool})
	if !ok {
		return zero, &Error{Code: ErrToolUnavailable, Path: "tool", Message: "tool discovery state is unavailable"}
	}
	if toolState.PackVersion != loaded.Pack.Metadata.Version {
		return zero, &Error{Code: ErrStaleDiscovery, Path: "tool", Message: "tool discovery state does not match the configured pack version"}
	}
	if toolState.Status != discovery.StatusReady || toolState.Path == "" {
		return zero, &Error{Code: ErrToolUnavailable, Path: "tool", Message: "tool is not ready for execution"}
	}

	declared := make(map[string]packs.Input, len(command.Inputs))
	for _, input := range command.Inputs {
		declared[input.ID] = input
	}
	unknown := make([]string, 0)
	for id := range request.Values {
		if _, ok := declared[id]; !ok {
			unknown = append(unknown, id)
		}
	}
	if len(unknown) != 0 {
		sort.Strings(unknown)
		return zero, &Error{Code: ErrUnknownInput, Path: "values." + unknown[0], Message: "input is not declared by the command"}
	}

	values := make(map[string]value, len(command.Inputs))
	for _, input := range command.Inputs {
		raw, present := request.Values[input.ID]
		if !present {
			if input.Required {
				return zero, &Error{Code: ErrMissingInput, Path: "values." + input.ID, Message: "required input is missing"}
			}
			values[input.ID] = value{}
			continue
		}
		parsed, err := parseValue(input, raw)
		if err != nil {
			return zero, err
		}
		values[input.ID] = parsed
	}

	args := make([]string, 0, len(command.Argv)*2)
	for index, argument := range command.Argv {
		path := fmt.Sprintf("commands.%s.argv[%d]", request.CommandID, index)
		switch {
		case argument.Literal != "":
			args = append(args, argument.Literal)
		case argument.Flag != nil:
			current, ok := values[argument.Flag.ValueFrom]
			if !ok {
				return zero, &Error{Code: ErrInvalidPlanState, Path: path, Message: "validated pack references an unavailable input"}
			}
			if !current.present || (argument.Flag.OmitWhenEmpty && current.argument == "") {
				continue
			}
			args = append(args, argument.Flag.Name, current.argument)
		case argument.Switch != nil:
			current, ok := values[argument.Switch.EnabledFrom]
			if !ok {
				return zero, &Error{Code: ErrInvalidPlanState, Path: path, Message: "validated pack references an unavailable input"}
			}
			if current.present && current.boolean {
				args = append(args, argument.Switch.Name)
			}
		case argument.Map != nil:
			current, ok := values[argument.Map.ValueFrom]
			if !ok || !current.present {
				return zero, &Error{Code: ErrInvalidPlanState, Path: path, Message: "validated mapped input is unavailable"}
			}
			mapped, ok := argument.Map.Values[current.text]
			if !ok {
				return zero, &Error{Code: ErrInvalidPlanState, Path: path, Message: "validated enum value has no argument mapping"}
			}
			args = append(args, mapped)
		default:
			return zero, &Error{Code: ErrInvalidPlanState, Path: path, Message: "validated argument has no supported mapping"}
		}
	}

	return Plan{
		PackID:         request.PackID,
		PackVersion:    loaded.Pack.Metadata.Version,
		CommandID:      request.CommandID,
		ToolID:         command.Tool,
		ExecutablePath: toolState.Path,
		ExecutableName: toolState.ExecutableName,
		ToolVersion:    toolState.Version,
		Args:           args,
		Risk:           command.Risk,
		Output:         command.Output,
		Requirements:   command.Requirements,
	}, nil
}

func parseValue(input packs.Input, raw json.RawMessage) (value, error) {
	path := "values." + input.ID
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return value{}, &Error{Code: ErrInvalidInput, Path: path, Message: "input must not be null"}
	}

	switch input.Type {
	case packs.InputString, packs.InputEnum:
		var text string
		if err := strictJSON(raw, &text); err != nil {
			return value{}, &Error{Code: ErrInvalidInput, Path: path, Message: "input must be a string"}
		}
		if err := validateString(input, text, path); err != nil {
			return value{}, err
		}
		return value{present: true, text: text, argument: text}, nil
	case packs.InputInteger:
		var integer int64
		if err := strictJSON(raw, &integer); err != nil {
			return value{}, &Error{Code: ErrInvalidInput, Path: path, Message: "input must be an integer"}
		}
		if input.Validation.Min != nil && integer < *input.Validation.Min {
			return value{}, &Error{Code: ErrInvalidInput, Path: path, Message: "integer is below the allowed minimum"}
		}
		if input.Validation.Max != nil && integer > *input.Validation.Max {
			return value{}, &Error{Code: ErrInvalidInput, Path: path, Message: "integer exceeds the allowed maximum"}
		}
		return value{present: true, argument: fmt.Sprintf("%d", integer)}, nil
	case packs.InputBoolean:
		var boolean bool
		if err := strictJSON(raw, &boolean); err != nil {
			return value{}, &Error{Code: ErrInvalidInput, Path: path, Message: "input must be a boolean"}
		}
		return value{present: true, boolean: boolean, argument: fmt.Sprintf("%t", boolean)}, nil
	case packs.InputMultiselect:
		var many []string
		if err := strictJSON(raw, &many); err != nil || many == nil {
			return value{}, &Error{Code: ErrInvalidInput, Path: path, Message: "input must be an array of strings"}
		}
		allowed := stringSet(input.Validation.Enum)
		seen := make(map[string]struct{}, len(many))
		for _, item := range many {
			if _, ok := allowed[item]; !ok {
				return value{}, &Error{Code: ErrInvalidInput, Path: path, Message: "input contains a value outside the allowed set"}
			}
			if _, duplicate := seen[item]; duplicate {
				return value{}, &Error{Code: ErrInvalidInput, Path: path, Message: "input contains a duplicate value"}
			}
			seen[item] = struct{}{}
		}
		return value{present: true, many: append([]string(nil), many...)}, nil
	default:
		return value{}, &Error{Code: ErrInvalidPlanState, Path: path, Message: "validated pack contains an unsupported input type"}
	}
}

func validateString(input packs.Input, text, path string) error {
	if strings.ContainsRune(text, '\x00') {
		return &Error{Code: ErrInvalidInput, Path: path, Message: "input cannot contain NUL"}
	}
	length := utf8.RuneCountInString(text)
	if input.Validation.MinLength != nil && length < *input.Validation.MinLength {
		return &Error{Code: ErrInvalidInput, Path: path, Message: "string is shorter than the allowed minimum"}
	}
	if input.Validation.MaxLength != nil && length > *input.Validation.MaxLength {
		return &Error{Code: ErrInvalidInput, Path: path, Message: "string exceeds the allowed maximum"}
	}
	if input.Validation.Pattern != "" {
		matched, err := regexp.MatchString(input.Validation.Pattern, text)
		if err != nil {
			return &Error{Code: ErrInvalidPlanState, Path: path, Message: "validated pack contains an invalid input pattern"}
		}
		if !matched {
			return &Error{Code: ErrInvalidInput, Path: path, Message: "string does not match the allowed pattern"}
		}
	}
	if input.Validation.DisallowLeadingDash && strings.HasPrefix(text, "-") {
		return &Error{Code: ErrInvalidInput, Path: path, Message: "input cannot begin with a dash"}
	}
	if input.Type == packs.InputEnum {
		if _, ok := stringSet(input.Validation.Enum)[text]; !ok {
			return &Error{Code: ErrInvalidInput, Path: path, Message: "input is outside the allowed enum"}
		}
	}
	return nil
}

func strictJSON(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("trailing JSON value")
		}
		return err
	}
	return nil
}

func stringSet(values []string) map[string]struct{} {
	set := make(map[string]struct{}, len(values))
	for _, item := range values {
		set[item] = struct{}{}
	}
	return set
}
