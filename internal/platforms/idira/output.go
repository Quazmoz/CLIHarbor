// Package idira contains only the reviewed Idira Privilege Cloud adapter.
// All PAM execution remains owned by the official CyberArk idsec CLI.
package idira

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

const (
	PackID = "cyberark-idira-pam"
	ToolID = "idsec"
	maxVendorOutput = 64 << 10
	maxPageItems = 50
	maxMetadataValueBytes = 2048
)

var errUnsafeVendorOutput = errors.New("vendor output did not match the reviewed non-secret schema")

// OutputGuard identifies PAM operations whose vendor output is NEVER safe to
// forward as raw events. The run manager buffers both streams before calling
// this filter and emits only its validated return value. A failed subprocess,
// unknown schema, oversized response, or unexpected property produces no
// browser-visible vendor bytes.
func OutputGuard(plan planner.Plan) func([]byte) ([]byte, error) {
	if plan.PackID != PackID || plan.ToolID != ToolID {
		return nil
	}
	switch plan.CommandID {
	case "session-status":
		return filterStatus
	case "list-safes":
		return func(data []byte) ([]byte, error) {
			return filterRows(data, []string{"safe_id", "safe_name"})
		}
	case "list-accounts":
		return func(data []byte) ([]byte, error) {
			return filterRows(data, []string{"account_id", "name", "safe_name", "platform_id"})
		}
	default:
		// Future Idira pack tasks must be reviewed and explicitly admitted.
		return func([]byte) ([]byte, error) { return nil, errUnsafeVendorOutput }
	}
}

func filterStatus(data []byte) ([]byte, error) {
	if !validEnvelope(data) {
		return nil, errUnsafeVendorOutput
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	seen, err := readObject(dec, map[string]string{
		"profile": "string", "exists": "bool", "authenticated": "bool",
	})
	if err != nil || !atEOF(dec) {
		return nil, errUnsafeVendorOutput
	}
	profile := stringValue(seen["profile"])
	if profile == "" || len(profile) > 128 || !validText(profile) {
		return nil, errUnsafeVendorOutput
	}
	exists, ok1 := boolValue(seen["exists"])
	auth, ok2 := boolValue(seen["authenticated"])
	if !ok1 || !ok2 || (!exists && auth) {
		return nil, errUnsafeVendorOutput
	}
	return json.Marshal(struct {
		Profile string `json:"profile"`
		Exists bool `json:"exists"`
		Authenticated bool `json:"authenticated"`
	}{profile, exists, auth})
}

func filterRows(data []byte, fields []string) ([]byte, error) {
	if !validEnvelope(data) {
		return nil, errUnsafeVendorOutput
	}
	allow := make(map[string]string, len(fields))
	for _, field := range fields {
		allow[field] = "string"
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('[') {
		return nil, errUnsafeVendorOutput
	}
	rows := make([]map[string]string, 0)
	for dec.More() {
		if len(rows) == maxPageItems {
			return nil, errUnsafeVendorOutput
		}
		values, err := readObject(dec, allow)
		if err != nil {
			return nil, errUnsafeVendorOutput
		}
		row := make(map[string]string, len(fields))
		for _, field := range fields {
			value := stringValue(values[field])
			if len(value) > maxMetadataValueBytes || !validText(value) {
				return nil, errUnsafeVendorOutput
			}
			row[field] = value
		}
		// Identifiers and the account-to-Safe association are mandatory.
		if row[fields[0]] == "" || (len(fields) > 2 && row["safe_name"] == "") {
			return nil, errUnsafeVendorOutput
		}
		rows = append(rows, row)
	}
	if tok, err = dec.Token(); err != nil || tok != json.Delim(']') || !atEOF(dec) {
		return nil, errUnsafeVendorOutput
	}
	return json.Marshal(rows)
}

func readObject(dec *json.Decoder, allow map[string]string) (map[string]json.RawMessage, error) {
	start, err := dec.Token()
	if err != nil || start != json.Delim('{') {
		return nil, errUnsafeVendorOutput
	}
	seen := make(map[string]json.RawMessage, len(allow))
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return nil, errUnsafeVendorOutput
		}
		key, ok := token.(string)
		if !ok || allow[key] == "" {
			return nil, errUnsafeVendorOutput
		}
		if _, duplicate := seen[key]; duplicate {
			return nil, errUnsafeVendorOutput
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil || len(raw) == 0 {
			return nil, errUnsafeVendorOutput
		}
		if allow[key] == "string" {
			var s string
			if err := json.Unmarshal(raw, &s); err != nil || len(s) > maxMetadataValueBytes || !validText(s) {
				return nil, errUnsafeVendorOutput
			}
		} else {
			if _, ok := boolValue(raw); !ok {
				return nil, errUnsafeVendorOutput
			}
		}
		seen[key] = raw
	}
	end, err := dec.Token()
	if err != nil || end != json.Delim('}') || len(seen) != len(allow) {
		return nil, errUnsafeVendorOutput
	}
	return seen, nil
}

func boolValue(raw json.RawMessage) (bool, bool) {
	if bytes.Equal(raw, []byte("true")) {
		return true, true
	}
	if bytes.Equal(raw, []byte("false")) {
		return false, true
	}
	return false, false
}

func stringValue(raw json.RawMessage) string {
	var value string
	_ = json.Unmarshal(raw, &value)
	return value
}

func validEnvelope(data []byte) bool {
	return len(data) != 0 && len(data) <= maxVendorOutput && utf8.Valid(data)
}

func validText(s string) bool {
	if strings.ContainsRune(s, 0) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func atEOF(dec *json.Decoder) bool {
	_, err := dec.Token()
	return err == io.EOF
}
