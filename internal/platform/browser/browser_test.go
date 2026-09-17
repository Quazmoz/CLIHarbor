package browser

import "testing"

func TestValidateBootstrapURL(t *testing.T) {
	t.Parallel()

	if err := validateBootstrapURL("http://127.0.0.1:49152/bootstrap?token=abc123"); err != nil {
		t.Fatalf("valid bootstrap URL rejected: %v", err)
	}

	for _, raw := range []string{
		"https://127.0.0.1:49152/bootstrap?token=abc123",
		"http://localhost:49152/bootstrap?token=abc123",
		"http://0.0.0.0:49152/bootstrap?token=abc123",
		"http://127.0.0.1/bootstrap?token=abc123",
		"http://127.0.0.1:49152/?token=abc123",
		"http://127.0.0.1:49152/bootstrap",
		"http://127.0.0.1:49152/bootstrap?token=abc123&next=x",
		"http://user@127.0.0.1:49152/bootstrap?token=abc123",
		"http://127.0.0.1:49152/bootstrap?token=abc123#fragment",
	} {
		t.Run(raw, func(t *testing.T) {
			if err := validateBootstrapURL(raw); err == nil {
				t.Fatalf("URL %q unexpectedly accepted", raw)
			}
		})
	}
}
