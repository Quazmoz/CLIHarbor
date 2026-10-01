package terminal

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateLaunchRequiresAbsoluteExecutableAndBoundedArgs(t *testing.T) {
	absolute := filepath.Join(t.TempDir(), "conjur")
	cases := []struct {
		name       string
		executable string
		args       []string
		wantError  bool
	}{
		{name: "reviewed login", executable: absolute, args: []string{"login"}},
		{name: "relative executable", executable: "conjur", args: []string{"login"}, wantError: true},
		{name: "missing args", executable: absolute, wantError: true},
		{name: "empty arg", executable: absolute, args: []string{""}, wantError: true},
		{name: "nul executable", executable: absolute + "\x00other", args: []string{"login"}, wantError: true},
		{name: "nul arg", executable: absolute, args: []string{"login\x00other"}, wantError: true},
		{name: "too many args", executable: absolute, args: make([]string, 17), wantError: true},
		{name: "oversized", executable: absolute, args: []string{strings.Repeat("x", 17*1024)}, wantError: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateLaunch(tc.executable, tc.args)
			if (err != nil) != tc.wantError {
				t.Fatalf("validateLaunch() error = %v, wantError %t", err, tc.wantError)
			}
		})
	}
}
