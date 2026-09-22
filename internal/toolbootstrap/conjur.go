package toolbootstrap

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

const (
	ConjurVersion = "9.3.1"

	conjurWindowsAMD64URL = "https://github.com/cyberark/conjur-cli-go/releases/download/v9.3.1/conjur_windows_amd64.exe"
	conjurWindowsAMD64SHA = "da2b31ca00b8faaefb8e1fe891563b5cc07c39460e776fb42e7f89b05d3ee4f6"
	conjurWindowsAMD64Size int64 = 21_950_000
	maxConjurDownloadBytes int64 = 24 << 20
)

var ConjurRef = discovery.ToolRef{PackID: "cyberark-conjur-v9", ToolID: "conjur"}

// Provisioner can provide a reviewed local executable for a missing trusted
// tool. Implementations must not widen the pack's executable/argv authority.
type Provisioner interface {
	Ensure(context.Context, discovery.ToolRef) (path string, installed bool, err error)
}

// ConjurProvisioner installs the exact reviewed CyberArk Conjur CLI release in
// the current user's local cache. It never writes machine PATH, Program Files,
// services, registry, or other machine-wide state.
type ConjurProvisioner struct {
	client        *http.Client
	rootDir       string
	sourceURL     string
	expectedSHA   string
	expectedSize  int64
	goos          string
	goarch        string
	allowInsecure bool // tests only
}

func NewConjurProvisioner() *ConjurProvisioner {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	p := &ConjurProvisioner{
		client: &http.Client{
			Transport: transport,
			Timeout:   60 * time.Second,
		},
		sourceURL:    conjurWindowsAMD64URL,
		expectedSHA:  conjurWindowsAMD64SHA,
		expectedSize: conjurWindowsAMD64Size,
		goos:         runtime.GOOS,
		goarch:       runtime.GOARCH,
	}
	p.client.CheckRedirect = p.checkRedirect
	return p
}

func (p *ConjurProvisioner) Ensure(ctx context.Context, ref discovery.ToolRef) (string, bool, error) {
	if ref != ConjurRef || p == nil || p.goos != "windows" || p.goarch != "amd64" {
		return "", false, nil
	}

	target, err := p.targetPath()
	if err != nil {
		return "", false, err
	}
	if ok, err := p.verifyFile(target); err == nil && ok {
		return target, false, nil
	} else if err != nil && !os.IsNotExist(err) {
		if removeErr := os.Remove(target); removeErr != nil && !os.IsNotExist(removeErr) {
			return "", false, fmt.Errorf("remove invalid managed Conjur executable: %w", removeErr)
		}
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", false, fmt.Errorf("create managed Conjur directory: %w", err)
	}

	temp, err := os.CreateTemp(filepath.Dir(target), ".conjur-download-*.tmp")
	if err != nil {
		return "", false, fmt.Errorf("create Conjur download staging file: %w", err)
	}
	tempPath := temp.Name()
	keepTemp := true
	defer func() {
		_ = temp.Close()
		if keepTemp {
			_ = os.Remove(tempPath)
		}
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.sourceURL, nil)
	if err != nil {
		return "", false, fmt.Errorf("build Conjur download request: %w", err)
	}
	req.Header.Set("User-Agent", "CLIHarbor-vendor-bootstrap")
	req.Header.Set("Accept", "application/octet-stream")

	resp, err := p.client.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("download Conjur CLI: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false, fmt.Errorf("download Conjur CLI: unexpected HTTP status %d", resp.StatusCode)
	}
	if !p.allowedURL(resp.Request.URL) {
		return "", false, fmt.Errorf("download Conjur CLI: final download origin is not approved")
	}
	if resp.ContentLength > maxConjurDownloadBytes {
		return "", false, fmt.Errorf("download Conjur CLI: response exceeded size limit")
	}

	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temp, hash), io.LimitReader(resp.Body, maxConjurDownloadBytes+1))
	if err != nil {
		return "", false, fmt.Errorf("download Conjur CLI payload: %w", err)
	}
	if written > maxConjurDownloadBytes || written != p.expectedSize {
		return "", false, fmt.Errorf("download Conjur CLI: unexpected payload size")
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), p.expectedSHA) {
		return "", false, fmt.Errorf("download Conjur CLI: SHA-256 verification failed")
	}
	if err := temp.Sync(); err != nil {
		return "", false, fmt.Errorf("sync Conjur staging file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return "", false, fmt.Errorf("close Conjur staging file: %w", err)
	}
	if err := os.Chmod(tempPath, 0o700); err != nil {
		return "", false, fmt.Errorf("set Conjur staging permissions: %w", err)
	}

	if err := os.Rename(tempPath, target); err != nil {
		// A concurrent CLIHarbor instance may have completed the same pinned
		// installation first. Accept only the exact reviewed bytes.
		if ok, verifyErr := p.verifyFile(target); verifyErr == nil && ok {
			return target, false, nil
		}
		return "", false, fmt.Errorf("activate managed Conjur executable: %w", err)
	}
	keepTemp = false

	ok, err := p.verifyFile(target)
	if err != nil {
		return "", false, fmt.Errorf("verify activated Conjur executable: %w", err)
	}
	if !ok {
		return "", false, fmt.Errorf("verify activated Conjur executable: content mismatch")
	}
	return target, true, nil
}

func (p *ConjurProvisioner) targetPath() (string, error) {
	root := p.rootDir
	if root == "" {
		cache, err := os.UserCacheDir()
		if err != nil {
			return "", fmt.Errorf("resolve current-user cache directory: %w", err)
		}
		root = filepath.Join(cache, "CLIHarbor")
	}
	return filepath.Join(root, "tools", "conjur", ConjurVersion, "conjur.exe"), nil
}

func (p *ConjurProvisioner) verifyFile(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() != p.expectedSize {
		return false, fmt.Errorf("managed Conjur executable is not the expected regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, maxConjurDownloadBytes+1))
	if err != nil {
		return false, err
	}
	if written != p.expectedSize {
		return false, nil
	}
	return strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), p.expectedSHA), nil
}

func (p *ConjurProvisioner) checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return fmt.Errorf("too many redirects")
	}
	if !p.allowedURL(req.URL) {
		return fmt.Errorf("redirected to an unapproved download origin")
	}
	return nil
}

func (p *ConjurProvisioner) allowedURL(candidate *url.URL) bool {
	if candidate == nil {
		return false
	}
	source, err := url.Parse(p.sourceURL)
	if err != nil {
		return false
	}
	if p.allowInsecure && candidate.Scheme == "http" && candidate.Host == source.Host {
		return true
	}
	if candidate.Scheme != "https" {
		return false
	}
	host := strings.ToLower(candidate.Hostname())
	return host == "github.com" || strings.HasSuffix(host, ".githubusercontent.com")
}
