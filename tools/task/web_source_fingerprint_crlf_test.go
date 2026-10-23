package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A Windows checkout may materialize CRLF for text without an eol attribute;
// the committed fingerprint must still verify there.
func TestWebSourceFingerprintIgnoresCRLFCheckout(t *testing.T) {
	digest := func(content string) string {
		root := t.TempDir()
		if err := os.MkdirAll(filepath.Join(root, "web", "public"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "web", "public", "favicon.svg"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		value, err := webSourceFingerprint(root)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	if lf, crlf := digest("<svg>\n</svg>\n"), digest("<svg>\r\n</svg>\r\n"); lf != crlf {
		t.Fatalf("CRLF checkout changed the fingerprint: %s != %s", lf, crlf)
	}
	if digest("<svg>\n</svg>\n") == digest("<svg>\n</svg>\nX") {
		t.Fatal("content changes must still change the fingerprint")
	}
}
