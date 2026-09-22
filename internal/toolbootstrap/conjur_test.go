package toolbootstrap

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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
	assertNoManagedTarget(t, p)
}

func TestConjurProvisionerRejectsOversizedResponseBeforeActivation(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.FormatInt(maxConjurDownloadBytes+1, 10))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	expected := sha256.Sum256([]byte("x"))
	p := &ConjurProvisioner{
		client:        server.Client(),
		rootDir:       t.TempDir(),
		sourceURL:     server.URL,
		expectedSHA:   hex.EncodeToString(expected[:]),
		expectedSize:  1,
		goos:          "windows",
		goarch:        "amd64",
		allowInsecure: true,
	}
	p.client.CheckRedirect = p.checkRedirect

	if path, installed, err := p.Ensure(context.Background(), ConjurRef); err == nil || installed || path != "" {
		t.Fatalf("oversized response was not rejected safely: path=%q installed=%v err=%v", path, installed, err)
	}
	assertNoManagedTarget(t, p)
}

func TestConjurProvisionerRejectsRedirectToUnapprovedOrigin(t *testing.T) {
	t.Parallel()

	unapproved := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("must-not-be-accepted"))
	}))
	defer unapproved.Close()

	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, unapproved.URL+"/payload.exe", http.StatusFound)
	}))
	defer source.Close()

	expected := sha256.Sum256([]byte("must-not-be-accepted"))
	p := &ConjurProvisioner{
		client:        source.Client(),
		rootDir:       t.TempDir(),
		sourceURL:     source.URL,
		expectedSHA:   hex.EncodeToString(expected[:]),
		expectedSize:  int64(len("must-not-be-accepted")),
		goos:          "windows",
		goarch:        "amd64",
		allowInsecure: true,
	}
	p.client.CheckRedirect = p.checkRedirect

	if path, installed, err := p.Ensure(context.Background(), ConjurRef); err == nil || installed || path != "" {
		t.Fatalf("unapproved redirect was not rejected safely: path=%q installed=%v err=%v", path, installed, err)
	}
	assertNoManagedTarget(t, p)
}

func TestConjurProvisionerReplacesSymlinkInsteadOfFollowingIt(t *testing.T) {
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
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.exe")
	if err := os.WriteFile(outside, []byte("wrong-hash-same-size!!"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, target); err != nil {
		t.Skipf("symlink creation unavailable on this runner: %v", err)
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
		t.Fatalf("replace symlink: %v", err)
	}
	if !installed || path != target {
		t.Fatalf("expected safe replacement, installed=%v path=%q", installed, path)
	}
	info, err := os.Lstat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		t.Fatalf("managed target remained non-regular after repair: %v", info.Mode())
	}
	outsideContent, err := os.ReadFile(outside)
	if err != nil {
		t.Fatal(err)
	}
	if string(outsideContent) != "wrong-hash-same-size!!" {
		t.Fatalf("symlink target was modified: %q", outsideContent)
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

func assertNoManagedTarget(t *testing.T, p *ConjurProvisioner) {
	t.Helper()
	target, err := p.targetPath()
	if err != nil {
		t.Fatal(err)
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatalf("failed bootstrap left activated target: %v", statErr)
	}
}

func discoveryRef(packID, toolID string) discovery.ToolRef {
	return discovery.ToolRef{PackID: packID, ToolID: toolID}
}
