package diagnostics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestMarshalBundleIsDeterministicAndBounded(t *testing.T) {
	bundle := testBundle()
	first, err := MarshalBundle(bundle)
	if err != nil {
		t.Fatalf("MarshalBundle() error = %v", err)
	}
	second, err := MarshalBundle(bundle)
	if err != nil {
		t.Fatalf("second MarshalBundle() error = %v", err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("identical diagnostics state did not serialize deterministically")
	}
	if len(first) > MaxSerializedBytes {
		t.Fatalf("serialized diagnostics length = %d, max %d", len(first), MaxSerializedBytes)
	}
	var decoded Bundle
	if err := json.Unmarshal(first, &decoded); err != nil {
		t.Fatalf("diagnostics JSON invalid: %v", err)
	}
	if decoded.SchemaVersion != SchemaVersion {
		t.Fatalf("schemaVersion = %q", decoded.SchemaVersion)
	}
}

func TestValidateRejectsUnsafeOrAmbiguousFields(t *testing.T) {
	tests := []func(*Bundle){
		func(b *Bundle) { b.CLIHarbor.Version = "secret\nvalue" },
		func(b *Bundle) { b.Packs[0].ID = "internal/unsafe" },
		func(b *Bundle) { b.Tools[0].Version = strings.Repeat("x", 129) },
		func(b *Bundle) { b.Tools[0].Status = "unknown" },
		func(b *Bundle) { b.Tools[0].CandidateCount = maxCandidateCount + 1 },
		func(b *Bundle) { b.Configuration.PackCount++ },
		func(b *Bundle) { b.Health.ToolsReady++ },
	}
	for i, mutate := range tests {
		bundle := testBundle()
		mutate(&bundle)
		if err := Validate(bundle); err == nil {
			t.Fatalf("case %d unexpectedly validated", i)
		}
	}
}

func TestWriteBundleCreatesPrivateNoClobberFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "diagnostics Ω")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(dir, "bundle.json")
	digest, err := WriteBundle(context.Background(), destination, testBundle())
	if err != nil {
		t.Fatalf("WriteBundle() error = %v", err)
	}
	if len(digest) != 64 {
		t.Fatalf("digest length = %d, want 64", len(digest))
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(data) {
		t.Fatal("diagnostics export is not valid JSON")
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(destination)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("diagnostics mode = %o, want 600", info.Mode().Perm())
		}
	}
	if _, err := WriteBundle(context.Background(), destination, testBundle()); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("second export error = %v, want no-clobber refusal", err)
	}
}

func TestWriteBundleRejectsUnsafeTargetsAndCleansCancellation(t *testing.T) {
	if _, err := WriteBundle(context.Background(), filepath.Join("..", "diagnostics.json"), testBundle()); err == nil {
		t.Fatal("relative parent traversal unexpectedly accepted")
	}

	root := t.TempDir()
	directoryTarget := filepath.Join(root, "existing-dir")
	if err := os.Mkdir(directoryTarget, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteBundle(context.Background(), directoryTarget, testBundle()); err == nil || !strings.Contains(err.Error(), "directory or special file") {
		t.Fatalf("directory target error = %v", err)
	}

	symlinkTarget := filepath.Join(root, "real")
	if err := os.WriteFile(symlinkTarget, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(root, "link.json")
	if err := os.Symlink(symlinkTarget, symlink); err == nil {
		if _, err := WriteBundle(context.Background(), symlink, testBundle()); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("symlink target error = %v", err)
		}
	}

	destination := filepath.Join(root, "cancelled.json")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := WriteBundle(ctx, destination, testBundle()); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled export error = %v, want context.Canceled", err)
	}
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cancelled export left destination: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".cliharbor-diagnostics-") {
			t.Fatalf("cancelled export left staging file %q", entry.Name())
		}
	}
}

func TestWriteBundleConcurrentExportPublishesExactlyOneCompleteFile(t *testing.T) {
	dir := t.TempDir()
	destination := filepath.Join(dir, "bundle.json")
	bundles := []Bundle{testBundle(), testBundle()}
	bundles[0].CLIHarbor.Commit = "first"
	bundles[1].CLIHarbor.Commit = "second"

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range bundles {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			_, errs[index] = WriteBundle(context.Background(), destination, bundles[index])
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
			t.Fatalf("concurrent export error = %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful concurrent exports = %d, want 1; errors=%v", successes, errs)
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Bundle
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("winning export was partial: %v", err)
	}
	if decoded.CLIHarbor.Commit != "first" && decoded.CLIHarbor.Commit != "second" {
		t.Fatalf("unexpected winning commit %q", decoded.CLIHarbor.Commit)
	}
}

func testBundle() Bundle {
	return Bundle{
		SchemaVersion: SchemaVersion,
		CLIHarbor: BuildInfo{Version: "0.0.0-test", Commit: "abc123", BuildMode: "test"},
		Runtime: RuntimeInfo{GoVersion: "go1.27.1", OS: "windows", OSVersion: "10.0.26100", Architecture: "amd64"},
		Configuration: Configuration{PackSourceMode: "files", PackCount: 1, ToolOverrideCount: 0},
		Health: Health{ToolsReady: 1, ToolsUnavailable: 0},
		Packs: []PackRecord{{ID: "demo", Version: "1.0.0"}},
		Tools: []ToolRecord{{PackID: "demo", PackVersion: "1.0.0", ToolID: "tool", Status: "ready", Version: "2.0.0", CandidateCount: 1}},
	}
}
