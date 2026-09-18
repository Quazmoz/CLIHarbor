package evidence

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSanitizeTextRedactsSecretsPathsAndUnsafeBytes(t *testing.T) {
	home, _ := os.UserHomeDir()
	temp := os.TempDir()
	raw := []byte("Authorization: Bearer abc123\npassword=hunter2\ntoken: topsecret\n")
	raw = append(raw, []byte("eyJabcdefghijk.abcdefghijk.abcdefghijk\n")...)
	if home != "" {
		raw = append(raw, []byte(home+string(filepath.Separator)+"secret.txt\n")...)
	}
	if temp != "" {
		raw = append(raw, []byte(temp+string(filepath.Separator)+"cliharbor\n")...)
	}
	raw = append(raw, 0xff, 0x00, 'x')

	got := SanitizeText(raw)
	for _, secret := range []string{"abc123", "hunter2", "topsecret", "eyJabcdefghijk.abcdefghijk.abcdefghijk"} {
		if strings.Contains(got, secret) {
			t.Fatalf("sanitized output still contains %q: %q", secret, got)
		}
	}
	if strings.ContainsRune(got, '\x00') {
		t.Fatalf("sanitized output contains NUL: %q", got)
	}
	if home != "" && strings.Contains(got, home) {
		t.Fatalf("sanitized output contains home path: %q", got)
	}
	if temp != "" && strings.Contains(got, temp) {
		t.Fatalf("sanitized output contains temp path: %q", got)
	}
	if !strings.Contains(got, "[REDACTED]") || !strings.Contains(got, "[REDACTED_JWT]") {
		t.Fatalf("sanitized output lacks redaction markers: %q", got)
	}
}

func TestSanitizeTextBoundsUTF8Output(t *testing.T) {
	raw := strings.Repeat("é", MaxCapturedTextBytes)
	got := SanitizeText([]byte(raw))
	if len(got) > MaxCapturedTextBytes {
		t.Fatalf("sanitized output length = %d, max %d", len(got), MaxCapturedTextBytes)
	}
	if !json.Valid([]byte(`"` + strings.ReplaceAll(got, `"`, `\"`) + `"`)) {
		t.Fatal("bounded sanitizer split UTF-8")
	}
}

func TestWriteBundleCreatesProtectedAtomicJSONAndRefusesOverwrite(t *testing.T) {
	dir := t.TempDir()
	destination := filepath.Join(dir, "phase0.json")
	bundle := testBundle()

	if err := WriteBundle(context.Background(), destination, bundle); err != nil {
		t.Fatalf("WriteBundle() error = %v", err)
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Bundle
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("export is not valid JSON: %v", err)
	}
	if decoded.SchemaVersion != SchemaVersion || len(decoded.Tools) != 1 {
		t.Fatalf("decoded export = %#v", decoded)
	}
	if bytes.Contains(data, []byte("0001-01-01")) {
		t.Fatalf("export serialized zero-value probe timestamp: %s", data)
	}
	if !bytes.Contains(data, []byte(`"arguments": [`)) {
		t.Fatalf("export omitted probe argument identity: %s", data)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(destination)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("export mode = %o, want 600", info.Mode().Perm())
		}
	}
	if err := WriteBundle(context.Background(), destination, bundle); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("second WriteBundle() error = %v, want existing-file refusal", err)
	}
}

func TestWriteBundleRejectsTraversalAndCancellationWithoutPartialFile(t *testing.T) {
	if err := WriteBundle(context.Background(), filepath.Join("..", "phase0.json"), testBundle()); err == nil {
		t.Fatal("relative parent traversal unexpectedly accepted")
	}

	dir := t.TempDir()
	destination := filepath.Join(dir, "cancelled.json")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := WriteBundle(ctx, destination, testBundle()); err == nil {
		t.Fatal("cancelled export unexpectedly succeeded")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("cancelled export left destination behind: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("cancelled export left staging files: %v", entries)
	}
}

func TestWriteBundleConcurrentActivationNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	destination := filepath.Join(dir, "phase0.json")
	bundles := []Bundle{testBundle(), testBundle()}
	bundles[0].CLIHarbor.Commit = "first"
	bundles[1].CLIHarbor.Commit = "second"

	var wg sync.WaitGroup
	errs := make([]error, len(bundles))
	for i := range bundles {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			errs[index] = WriteBundle(context.Background(), destination, bundles[index])
		}(i)
	}
	wg.Wait()

	successes := 0
	for _, err := range errs {
		if err == nil {
			successes++
			continue
		}
		if !strings.Contains(err.Error(), "already exists") {
			t.Fatalf("concurrent WriteBundle() error = %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful concurrent exports = %d, want 1 (errors: %v)", successes, errs)
	}

	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Bundle
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("winning export is partial or invalid JSON: %v", err)
	}
	if decoded.CLIHarbor.Commit != "first" && decoded.CLIHarbor.Commit != "second" {
		t.Fatalf("unexpected winning bundle commit %q", decoded.CLIHarbor.Commit)
	}
}

func TestSanitizeArgumentRedactsAndBounds(t *testing.T) {
	got := SanitizeArgument("token=" + strings.Repeat("s", 512))
	if strings.Contains(got, strings.Repeat("s", 32)) {
		t.Fatalf("sanitized argument retained secret material: %q", got)
	}
	if len(got) > MaxArgumentBytes {
		t.Fatalf("sanitized argument length = %d, max %d", len(got), MaxArgumentBytes)
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("sanitized argument lacks redaction marker: %q", got)
	}
}

func TestValidateRejectsOversizedCapturedText(t *testing.T) {
	bundle := testBundle()
	bundle.Tools[0].Probes = []ProbeRecord{{
		ID: "help", Kind: "help", Identity: "demo/tool/help", Status: "exited",
		Stdout: strings.Repeat("x", MaxCapturedTextBytes+1),
	}}
	if err := Validate(bundle); err == nil {
		t.Fatal("oversized probe output unexpectedly validated")
	}
}

func testBundle() Bundle {
	exit := 0
	generated := time.Unix(1, 0).UTC()
	started := generated.Add(time.Second)
	ended := started.Add(time.Second)
	return Bundle{
		SchemaVersion: SchemaVersion,
		GeneratedAt:   generated,
		CLIHarbor:     BuildInfo{Version: "test", Commit: "abc", BuildMode: "test"},
		Host:          HostInfo{OS: "windows", Architecture: "amd64"},
		Tools: []ToolRecord{{
			PackID: "demo", PackVersion: "1.0.0", ToolID: "tool", Status: "ready",
			CandidateCount: 1, AvailableHelpProbes: []string{"help"},
			Probes: []ProbeRecord{{
				ID: "help", Kind: "help", Identity: "demo/tool/help", Arguments: []string{"--help"}, Status: "exited",
				StartedAt: &started, EndedAt: &ended, ExitCode: &exit,
			}},
		}},
	}
}
