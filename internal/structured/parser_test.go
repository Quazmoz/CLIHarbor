package structured

import (
	"context"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestParseNormalizesDeclaredScalarsInPackOrder(t *testing.T) {
	result := Parse(t.Context(), []byte(`{"ok":true,"name":"snow 雪","count":7}`), fixtureSpec(), "")
	if result.Status != StatusAvailable || result.Error != "" || result.Renderer != "cards" {
		t.Fatalf("result = %#v", result)
	}
	if len(result.Fields) != 3 || result.Fields[0].Value != "snow 雪" || result.Fields[1].Value != "7" || result.Fields[2].Value != "true" {
		t.Fatalf("fields = %#v", result.Fields)
	}
}

func TestParseAllowsMissingOptionalFieldsAndStringBoundary(t *testing.T) {
	value := strings.Repeat("x", MaxStringBytes)
	result := Parse(t.Context(), []byte(`{"name":"`+value+`"}`), fixtureSpec(), "cards")
	if result.Status != StatusAvailable || result.Fields[0].Value != value || result.Fields[1].Present || result.Fields[2].Present {
		t.Fatalf("result = %#v", result)
	}
}

func TestParseFailsClosedForAdversarialOutput(t *testing.T) {
	spec := fixtureSpec()
	tests := []struct {
		name string
		data []byte
		code ErrorCode
	}{
		{"malformed", []byte(`{"name":`), ErrMalformedJSON},
		{"wrong primitive", []byte(`{"name":42}`), ErrWrongType},
		{"unknown field", []byte(`{"name":"ok","token":"secret"}`), ErrUnexpectedField},
		{"duplicate key", []byte(`{"name":"one","name":"two"}`), ErrDuplicateKey},
		{"nested object", []byte(`{"name":{"deep":{"deeper":"x"}}}`), ErrWrongType},
		{"nested array", []byte(`{"name":["x"]}`), ErrWrongType},
		{"integer overflow", []byte(`{"name":"ok","count":9223372036854775808}`), ErrInvalidInteger},
		{"float as integer", []byte(`{"name":"ok","count":1.5}`), ErrInvalidInteger},
		{"nan token", []byte(`{"name":"ok","count":NaN}`), ErrMalformedJSON},
		{"ansi control", []byte(`{"name":"\u001b[31mred"}`), ErrUnsafeControl},
		{"string over limit", []byte(`{"name":"`+strings.Repeat("x", MaxStringBytes+1)+`"}`), ErrStringTooLarge},
		{"trailing value", []byte(`{"name":"ok"} []`), ErrMalformedJSON},
		{"top-level array", []byte(`[]`), ErrUnexpectedSchema},
		{"invalid utf8", []byte{'{','"','n','a','m','e','"',':','"',0xff,'"','}'}, ErrInvalidEncoding},
		{"output too large", []byte(strings.Repeat(" ", MaxInputBytes+1)), ErrOutputTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := Parse(t.Context(), test.data, spec, "cards")
			if result.Status != StatusInvalid || result.Error != test.code || len(result.Fields) != 0 {
				t.Fatalf("result = %#v, want invalid/%s", result, test.code)
			}
		})
	}
}

func TestParseRendersMarkupLikeStringOnlyAsData(t *testing.T) {
	result := Parse(t.Context(), []byte(`{"name":"<script>alert(1)</script>"}`), fixtureSpec(), "cards")
	if result.Status != StatusAvailable || result.Fields[0].Value != "<script>alert(1)</script>" {
		t.Fatalf("result = %#v", result)
	}
}

func TestParseHonorsCancellationAndSensitiveDefenseInDepth(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	result := Parse(ctx, []byte(`{"name":"ok"}`), fixtureSpec(), "cards")
	if result.Status != StatusUnavailable || result.Error != ErrParserCancelled {
		t.Fatalf("cancelled result = %#v", result)
	}

	spec := fixtureSpec()
	spec.Fields[0].Sensitive = true
	result = Parse(t.Context(), []byte(`{"name":"ok"}`), spec, "cards")
	if result.Status != StatusUnavailable || result.Error != ErrSensitiveOutput {
		t.Fatalf("sensitive result = %#v", result)
	}
}

func fixtureSpec() packs.StructuredOutput {
	return packs.StructuredOutput{Fields: []packs.StructuredField{
		{Key: "name", Label: "Name", Type: packs.StructuredString, Required: true},
		{Key: "count", Label: "Count", Type: packs.StructuredInteger},
		{Key: "ok", Label: "Healthy", Type: packs.StructuredBoolean},
	}}
}
