package conjur

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// LoadConfig persists a missing environment key; unserialized concurrent loads
// appended it several times and broke every later load.
func TestConcurrentConfigLoadsKeepConjurrcValid(t *testing.T) {
	rc := filepath.Join(t.TempDir(), ".conjurrc")
	if err := os.WriteFile(rc, []byte("appliance_url: https://conjur.example.test\naccount: acme\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CONJURRC", rc)
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() { _, _ = loadConjurConfig() })
	}
	wg.Wait()
	if _, err := loadConjurConfig(); err != nil {
		t.Fatalf("load after concurrent loads: %v", err)
	}
	data, _ := os.ReadFile(rc)
	if n := strings.Count(string(data), "environment:"); n > 1 {
		t.Fatalf("environment persisted %d times:\n%s", n, data)
	}
}
