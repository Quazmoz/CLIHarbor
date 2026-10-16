package idira

import (
	"bytes"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

func guardFor(command string) func([]byte) ([]byte, error) {
	return OutputGuard(planner.Plan{PackID: PackID, ToolID: ToolID, CommandID: command})
}

func TestOutputGuardAcceptsOnlyReviewedPAMMetadata(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		command  string
		input    string
		contains string
	}{
		{"version", "0.13.0\n", "0.13.0"},
		{"list-safes", `[{"safe_id":"s-1","safe_name":"Operations"}]`, "Operations"},
		{"list-safes", `[]`, "[]"},
		{"list-accounts", `[{"account_id":"42","name":"service","safe_name":"Operations","platform_id":"Linux"}]`, "Linux"},
		{"session-status", `{"profile":"idsec","exists":true,"authenticated":false}`, `"authenticated":false`},
	} {
		t.Run(test.command+"/"+test.contains, func(t *testing.T) {
			got, err := guardFor(test.command)([]byte(test.input))
			if err != nil || !bytes.Contains(got, []byte(test.contains)) {
				t.Fatalf("guard = %s, %v; want %s", got, err, test.contains)
			}
		})
	}
}

func TestOutputGuardRejectsSecretsDuplicatesAndMalformedDocuments(t *testing.T) {
	t.Parallel()
	cases := []struct {
		command string
		data    string
	}{
		{"list-accounts", `[{"account_id":"42","name":"service","safe_name":"S","platform_id":"Linux","password":"TOP-SECRET"}]`},
		{"list-accounts", `[{"account_id":"42","name":"service","safe_name":"S","platform_id":"Linux","credentials":{"password":"TOP-SECRET"}}]`},
		{"list-accounts", `[{"account_id":"42","account_id":"43","name":"service","safe_name":"S","platform_id":"Linux"}]`},
		{"list-accounts", `[{"account_id":"42","name":"service","safe_name":"S","platform_id":"Linux","token":"TOP-SECRET"}]`},
		{"list-accounts", `[{"account_id":"42","name":"service","safe_name":"S","platform_id":"Linux"}]{"other":true}`},
		{"list-safes", `[{"safe_id":"s1","safe_name":"S","secret":"TOP-SECRET"}]`},
		{"list-safes", `{"safe_id":"s1","safe_name":"S"}`},
		{"list-safes", `[{"safe_id":"s1","safe_name":null}]`},
		{"list-safes", `[{"safe_id":"s1","safe_name":"one\nmore"}]`},
		{"list-safes", `[{"safe_id":"s1","safe_name":"\ud800"}]`},
		{"list-accounts", `[{"account_id":"a1","name":"\udc00","safe_name":"S","platform_id":""}]`},
		{"session-status", `{"profile":"\udfff","exists":true,"authenticated":false}`},
		{"list-safes", `[{"safe_id":"s1","safe_name":"\ufffd"}]`},
		{"session-status", `{"profile":"idsec","exists":true,"authenticated":false,"endpoint":"https://tenant"}`},
		{"session-status", `{"profile":"idsec","exists":true,"authenticated":true,"authenticated":false}`},
		{"session-status", `{"profile":"idsec","exists":false,"authenticated":true}`},
		{"session-status", `{"profile":"idsec","exists":"true","authenticated":false}`},
		{"version", "TOP-SECRET"},
		{"version", "0.13.0\nTOP-SECRET"},
		{"version", "0.13.0\x1b[31m"},
		{"version", "0.13.0-beta\nmore"},
		{"version", "0.13.0\n\n"},
	}
	for _, test := range cases {
		t.Run(test.command+"/"+test.data, func(t *testing.T) {
			got, err := guardFor(test.command)([]byte(test.data))
			if err == nil || len(got) != 0 {
				t.Fatalf("unexpected unsafe output: %q / %v", got, err)
			}
		})
	}
}

func TestOutputGuardRejectsLimitsAndUnreviewedTasks(t *testing.T) {
	t.Parallel()
	accounts := strings.Repeat(`{"account_id":"a","name":"n","safe_name":"s","platform_id":""},`, 50)
	accounts += `{"account_id":"a","name":"n","safe_name":"s","platform_id":""}`
	if _, err := guardFor("list-accounts")([]byte("[" + accounts + "]")); err == nil {
		t.Fatal("51 rows accepted")
	}
	if _, err := guardFor("list-safes")([]byte(strings.Repeat("x", maxVendorOutput+1))); err == nil {
		t.Fatal("oversized vendor output accepted")
	}
	if _, err := guardFor("list-safes")([]byte{0xff}); err == nil {
		t.Fatal("invalid UTF-8 accepted")
	}
	if _, err := guardFor("get-credentials")([]byte("{}")); err == nil {
		t.Fatal("unreviewed PAM operation accepted")
	}
	if OutputGuard(planner.Plan{PackID: "docker-cli", ToolID: "docker", CommandID: "inspect"}) != nil {
		t.Fatal("PAM guard intercepted unrelated CLI")
	}
}
