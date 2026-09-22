package toolbootstrap

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

func TestConjurProvisionerDownloadsVerifiesAndReusesManagedCopy(t *testing.T) {
	t.Parallel()

	payload := []byte("reviewed-conjur-binary")
	digest := sha256.Sum256(payload)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	p := &ConjurProvisioner{
		client:        server.Client(),
		rootDir:       t.TempDir(),
		sourceURL:     server.URL,
		expectedSHA:   hex.EncodeToString(digest[:]),
		expectedSize:  int64(len(payload)),
		goos:          "windows",
		goarch:        "amd64",
		allowInsecure: true,
	}
	p.client.CheckRedirect = p.checkRedirect

	path, installed, err := p.Ensure(context.Background(), ConjurRef)
	if err != nil {
		t.Fatalf("ensure Conjur: %v", err)
	}
	if !installed {
		t.Fatal("first ensure did not report installation")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read installed file: %v", err)
	}
	if string(content) != string(payload) {
		t.Fatalf("installed payload mismatch: %q", content)
	}

	path2, installed2, err := p.Ensure(context.Background(), ConjurRef)
	if err != nil {
		t.Fatalf("reuse Conjur: %v", err)
	}
	if installed2 || path2 != path {
		t.Fatalf("expected verified reuse, got installed=%v path=%q", installed2, path2)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("verified managed copy unexpectedly redownloaded: %d requests", got)
	}
}

func TestConjurProvisionerRepairsWrongHashManagedCopy(t *testing.T) {
	t.Parallel()

	payload := []byte("reviewed-conjur-binary")
	digest := sha256.Sum256(payload)
	root := t.TempDir()
	p := &ConjurProvisioner{
		rootDir:       root,
		expectedSHA:   hex.EncodeToString(digest[:]),
		expectedSize:  int64(len(payload)),
		goos:          "windows",
		goarch:        "amd64",
		allowInsecure: true,
	}
	target, err := p.targetPath()
	if err != nil {
		t.Fatalf("target path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("wrong-hash-same-size!!"), 0o700); err != nil {
		t.Fatal(err)
	}
	wrong, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(wrong)) != p.expectedSize {
		t.Fatalf("test fixture must be same size: got %d want %d", len(wrong), p.expectedSize)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	p.client = server.Client()
	p.sourceURL = server.URL
	p.client.CheckRedirect = p.checkRedirect

	path, installed, err := p.Ensure(context.Background(), ConjurRef)
	if err != nil {
		t.Fatalf("repair Conjur: %v", err)
	}
	if !installed || path != target {
		t.Fatalf("expected repaired managed install, installed=%v path=%q", installed, path)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != string(payload) {
		t.Fatalf("repaired payload mismatch: %q", content)
	}
}

func TestConjurProvisionerRejectsDigestMismatchWithoutActivation(t *testing.T) {
	t.Parallel()

	payload := []byte("unexpected")
	expected := sha256.Sum256([]byte("expected!!"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	p := &ConjurProvisioner{
		client:        server.Client(),
		rootDir:       t.TempDir(),
		sourceURL:     server.URL,
		expectedSHA:   hex.EncodeToString(expected[:]),
		expectedSize:  int64(len(payload)),
		goos:          "windows",
		goarch:        "amd64",
		allowInsecure: true,
	}
	p.client.CheckRedirect = p.checkRedirect

	path, installed, err := p.Ensure(context.Background(), ConjurRef)
	if err == nil {
		t.Fatal("digest mismatch unexpectedly succeeded")
	}
	if installed || path != "" {
		t.Fatalf("digest mismatch returned activated state: installed=%v path=%q", installed, path)
	}
	target, targetErr := p.targetPath()
	if targetErr != nil {
		t.Fatal(targetErr)
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatalf("digest mismatch left activated target: %v", statErr)
	}
}

func TestConjurProvisionerIgnoresOtherToolsAndPlatforms(t *testing.T) {
	t.Parallel()

	p := NewConjurProvisioner()
	p.rootDir = t.TempDir()
	p.goos = "linux"

	if path, installed, err := p.Ensure(context.Background(), ConjurRef); err != nil || path != "" || installed {
		t.Fatalf("unsupported platform should be no-op: path=%q installed=%v err=%v", path, installed, err)
	}
	if path, installed, err := p.Ensure(context.Background(), discoveryRef("other", "tool")); err != nil || path != "" || installed {
		t.Fatalf("unmanaged tool should be no-op: path=%q installed=%v err=%v", path, installed, err)
	}
}

func discoveryRef(packID, toolID string) discovery.ToolRef {
	return discovery.ToolRef{PackID: packID, ToolID: toolID}
}
