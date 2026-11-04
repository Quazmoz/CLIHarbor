package passwordshare

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestPasswordSenderBrowserE2E(t *testing.T) {
	if os.Getenv("CLIHARBOR_BROWSER_E2E") != "1" {
		t.Skip("set CLIHARBOR_BROWSER_E2E=1 for real-browser acceptance")
	}
	s := testService(t, true)
	invite := testInvitation(t, s, "browser")
	_, source, _, _ := runtime.Caller(0)
	script := filepath.Join(filepath.Dir(source), "..", "..", "test", "password_sharing_e2e.mjs")
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", script)
	command.Env = append(os.Environ(), "CLIHARBOR_E2E_PASSWORD_INVITATION="+invite.URL)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("browser sender failed: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "password sender browser E2E passed") {
		t.Fatal("browser acceptance marker missing")
	}
	value, err := s.Take(invite.Status.ID)
	defer clear(value)
	if err != nil || string(value) != "browser-wire-fixture\nsecond line\tend" {
		t.Fatal("browser delivery did not reach the receiver intact")
	}
}
