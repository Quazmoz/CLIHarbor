package apperror

import "testing"

func TestDetailForIsClosedAndBrowserSafe(t *testing.T) {
	detail := DetailFor(Code("PRIVATE_PATH_MARKER PRIVATE_VALUE_MARKER <em>markup</em>"))
	if detail.Code != CodeInternalError || detail.Category != CategoryInternal {
		t.Fatalf("unknown code mapped to %#v", detail)
	}
	if detail.Message == "" || detail.Remediation == "" {
		t.Fatalf("fallback detail incomplete: %#v", detail)
	}
}

func TestWithFieldAllowsOnlyOperatorInputFields(t *testing.T) {
	base := DetailFor(CodeInvalidInput)
	for _, field := range []string{"packId", "commandId", "values.query", "values.count-2"} {
		if got := WithField(base, field).Field; got != field {
			t.Fatalf("field %q was rejected", field)
		}
	}
	for _, field := range []string{"tool", "commands.inspect.argv[0]", "values.", "values.Query", "PRIVATE_PATH_MARKER"} {
		if got := WithField(base, field).Field; got != "" {
			t.Fatalf("unsafe field %q crossed boundary as %q", field, got)
		}
	}
}
