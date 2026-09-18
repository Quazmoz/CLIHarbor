package structured

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strconv"
	"unicode"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

const (
	MaxInputBytes  = 64 << 10
	MaxStringBytes = 8 << 10
	MaxFields      = 32
)

type Status string

const (
	StatusAvailable   Status = "available"
	StatusInvalid     Status = "invalid"
	StatusUnavailable Status = "unavailable"
)

type ErrorCode string

const (
	ErrInvalidEncoding  ErrorCode = "invalid_encoding"
	ErrOutputTooLarge   ErrorCode = "output_too_large"
	ErrMalformedJSON    ErrorCode = "malformed_json"
	ErrUnexpectedSchema ErrorCode = "unexpected_schema"
	ErrDuplicateKey     ErrorCode = "duplicate_key"
	ErrUnexpectedField  ErrorCode = "unexpected_field"
	ErrMissingField     ErrorCode = "missing_field"
	ErrWrongType        ErrorCode = "wrong_type"
	ErrInvalidInteger   ErrorCode = "invalid_integer"
	ErrStringTooLarge   ErrorCode = "string_too_large"
	ErrUnsafeControl    ErrorCode = "unsafe_control"
	ErrParserCancelled  ErrorCode = "parser_cancelled"
	ErrNonzeroExit      ErrorCode = "nonzero_exit"
	ErrRunCancelled     ErrorCode = "run_cancelled"
	ErrRunTimedOut      ErrorCode = "run_timed_out"
	ErrExecutionFailed  ErrorCode = "execution_failed"
	ErrSensitiveOutput  ErrorCode = "sensitive_output"
)

type Field struct {
	Key     string `json:"key"`
	Label   string `json:"label"`
	Type    string `json:"type"`
	Present bool   `json:"present"`
	Value   string `json:"value"`
}

type Result struct {
	Status   Status    `json:"status"`
	Renderer string    `json:"renderer"`
	Error    ErrorCode `json:"error,omitempty"`
	Fields   []Field   `json:"fields,omitempty"`
}

func Unavailable(renderer string, code ErrorCode) Result {
	return Result{Status: StatusUnavailable, Renderer: normalizeRenderer(renderer), Error: code}
}

func Invalid(renderer string, code ErrorCode) Result {
	return Result{Status: StatusInvalid, Renderer: normalizeRenderer(renderer), Error: code}
}

func Parse(ctx context.Context, data []byte, spec packs.StructuredOutput, renderer string) Result {
	renderer = normalizeRenderer(renderer)
	if cancelled(ctx) {
		return Unavailable(renderer, ErrParserCancelled)
	}
	if len(data) > MaxInputBytes {
		return Invalid(renderer, ErrOutputTooLarge)
	}
	if !utf8.Valid(data) {
		return Invalid(renderer, ErrInvalidEncoding)
	}
	if len(spec.Fields) == 0 || len(spec.Fields) > MaxFields {
		return Invalid(renderer, ErrUnexpectedSchema)
	}

	declared := make(map[string]packs.StructuredField, len(spec.Fields))
	for _, field := range spec.Fields {
		if field.Sensitive {
			return Unavailable(renderer, ErrSensitiveOutput)
		}
		if _, exists := declared[field.Key]; exists {
			return Invalid(renderer, ErrUnexpectedSchema)
		}
		declared[field.Key] = field
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	first, err := decoder.Token()
	if err != nil {
		return Invalid(renderer, ErrMalformedJSON)
	}
	if delimiter, ok := first.(json.Delim); !ok || delimiter != '{' {
		return Invalid(renderer, ErrUnexpectedSchema)
	}

	seen := make(map[string]string, len(spec.Fields))
	for decoder.More() {
		if cancelled(ctx) {
			return Unavailable(renderer, ErrParserCancelled)
		}
		keyToken, err := decoder.Token()
		if err != nil {
			return Invalid(renderer, ErrMalformedJSON)
		}
		key, ok := keyToken.(string)
		if !ok {
			return Invalid(renderer, ErrMalformedJSON)
		}
		if _, duplicate := seen[key]; duplicate {
			return Invalid(renderer, ErrDuplicateKey)
		}
		field, ok := declared[key]
		if !ok {
			return Invalid(renderer, ErrUnexpectedField)
		}
		value, code := parseValue(decoder, field)
		if code != "" {
			return Invalid(renderer, code)
		}
		seen[key] = value
	}

	end, err := decoder.Token()
	if err != nil {
		return Invalid(renderer, ErrMalformedJSON)
	}
	if delimiter, ok := end.(json.Delim); !ok || delimiter != '}' {
		return Invalid(renderer, ErrMalformedJSON)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return Invalid(renderer, ErrMalformedJSON)
	}

	fields := make([]Field, 0, len(spec.Fields))
	for _, declaration := range spec.Fields {
		value, present := seen[declaration.Key]
		if declaration.Required && !present {
			return Invalid(renderer, ErrMissingField)
		}
		fields = append(fields, Field{
			Key: declaration.Key, Label: declaration.Label, Type: string(declaration.Type),
			Present: present, Value: value,
		})
	}
	return Result{Status: StatusAvailable, Renderer: renderer, Fields: fields}
}

func parseValue(decoder *json.Decoder, field packs.StructuredField) (string, ErrorCode) {
	token, err := decoder.Token()
	if err != nil {
		return "", ErrMalformedJSON
	}
	switch field.Type {
	case packs.StructuredString:
		value, ok := token.(string)
		if !ok {
			return "", ErrWrongType
		}
		if len(value) > MaxStringBytes {
			return "", ErrStringTooLarge
		}
		for _, r := range value {
			if unicode.IsControl(r) && r != '\t' && r != '\n' && r != '\r' {
				return "", ErrUnsafeControl
			}
		}
		return value, ""
	case packs.StructuredInteger:
		number, ok := token.(json.Number)
		if !ok {
			return "", ErrWrongType
		}
		value, err := number.Int64()
		if err != nil {
			return "", ErrInvalidInteger
		}
		return strconv.FormatInt(value, 10), ""
	case packs.StructuredBoolean:
		value, ok := token.(bool)
		if !ok {
			return "", ErrWrongType
		}
		return strconv.FormatBool(value), ""
	default:
		return "", ErrUnexpectedSchema
	}
}

func normalizeRenderer(renderer string) string {
	if renderer == "" {
		return "cards"
	}
	return renderer
}

func cancelled(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	select {
	case <-ctx.Done():
		return true
	default:
		return false
	}
}
