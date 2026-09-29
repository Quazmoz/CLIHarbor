package toolbootstrap

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

const (
	maxManagedArtifactBytes int64 = 512 << 20
	maxManagedZIPEntries          = 4096
)

// ManagedProvisioner installs one immutable artifact declared by a trusted pack.
// Browser requests choose only a pack/tool reference; source URLs, hashes,
// extraction paths, and executable names remain backend-owned pack authority.
type ManagedProvisioner interface {
	Ensure(context.Context, discovery.ToolRef, packs.Tool) (path string, installed bool, err error)
}

// PortableProvisioner places verified portable CLI artifacts in CLIHarbor's
// current-user cache. It never executes installers, scripts, package managers,
// shells, or machine-wide mutation operations.
type PortableProvisioner struct {
	client        *http.Client
	rootDir       string
	goos          string
	goarch        string
	allowInsecure bool // tests only
}

func NewPortableProvisioner() *PortableProvisioner {
	transport := http.RoundTripper(http.DefaultTransport)
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		cloned := base.Clone()
		cloned.DisableCompression = true
		transport = cloned
	}
	return &PortableProvisioner{
		client: &http.Client{
			Transport: transport,
			Timeout:   60 * time.Second,
		},
		goos:   runtime.GOOS,
		goarch: runtime.GOARCH,
	}
}

// ResolveInstalled returns a previously installed verified portable artifact without
// performing network I/O. A missing or invalid managed copy is reported as not found.
func (p *PortableProvisioner) ResolveInstalled(ref discovery.ToolRef, tool packs.Tool) (string, bool, error) {
	if p == nil || tool.Install == nil {
		return "", false, nil
	}
	if !safeManagedSegment(ref.PackID) || !safeManagedSegment(ref.ToolID) || !safeManagedVersion(tool.Install.Version) {
		return "", false, fmt.Errorf("portable install metadata contains an unsafe cache path segment")
	}
	artifact, ok := tool.Install.Artifacts[p.goos+"-"+p.goarch]
	if !ok {
		return "", false, nil
	}
	if filepath.Base(artifact.ExecutableName) != artifact.ExecutableName || strings.ContainsAny(artifact.ExecutableName, `/\\`) {
		return "", false, fmt.Errorf("portable install executable name is not a basename")
	}
	target, err := p.targetPath(ref, tool.Install.Version, artifact.ExecutableName)
	if err != nil {
		return "", false, err
	}
	finalSHA, finalSize, err := finalExecutableIdentity(artifact)
	if err != nil {
		return "", false, err
	}
	valid, err := verifyManagedFile(target, finalSize, finalSHA)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	if !valid {
		return "", false, nil
	}
	return target, true, nil
}

func (p *PortableProvisioner) Ensure(ctx context.Context, ref discovery.ToolRef, tool packs.Tool) (string, bool, error) {
	if p == nil || ctx == nil || tool.Install == nil {
		return "", false, nil
	}
	if path, found, err := p.ResolveInstalled(ref, tool); err != nil {
		return "", false, err
	} else if found {
		return path, false, nil
	}
	if !safeManagedSegment(ref.PackID) || !safeManagedSegment(ref.ToolID) || !safeManagedVersion(tool.Install.Version) {
		return "", false, fmt.Errorf("portable install metadata contains an unsafe cache path segment")
	}

	artifact, ok := tool.Install.Artifacts[p.goos+"-"+p.goarch]
	if !ok {
		return "", false, nil
	}
	if artifact.SizeBytes <= 0 || artifact.SizeBytes > maxManagedArtifactBytes {
		return "", false, fmt.Errorf("portable install artifact size is outside the supported limit")
	}
	if filepath.Base(artifact.ExecutableName) != artifact.ExecutableName || strings.ContainsAny(artifact.ExecutableName, `/\`) {
		return "", false, fmt.Errorf("portable install executable name is not a basename")
	}

	target, err := p.targetPath(ref, tool.Install.Version, artifact.ExecutableName)
	if err != nil {
		return "", false, err
	}
	finalSHA, finalSize, err := finalExecutableIdentity(artifact)
	if err != nil {
		return "", false, err
	}

	if valid, verifyErr := verifyManagedFile(target, finalSize, finalSHA); verifyErr == nil && valid {
		return target, false, nil
	} else if verifyErr == nil || !errors.Is(verifyErr, os.ErrNotExist) {
		if removeErr := os.Remove(target); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return "", false, fmt.Errorf("remove invalid managed executable: %w", removeErr)
		}
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", false, fmt.Errorf("create managed tool directory: %w", err)
	}

	downloadPath, err := p.download(ctx, filepath.Dir(target), artifact)
	if err != nil {
		return "", false, err
	}
	keepDownload := true
	defer func() {
		if keepDownload {
			_ = os.Remove(downloadPath)
		}
	}()

	stagePath := downloadPath
	if artifact.Format == packs.InstallFormatZIP {
		stagePath, err = extractZIPExecutable(filepath.Dir(target), downloadPath, artifact)
		if err != nil {
			return "", false, err
		}
		defer func() { _ = os.Remove(stagePath) }()
		if removeErr := os.Remove(downloadPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return "", false, fmt.Errorf("remove verified archive staging file: %w", removeErr)
		}
		keepDownload = false
	} else if artifact.Format != packs.InstallFormatExecutable {
		return "", false, fmt.Errorf("unsupported portable install format %q", artifact.Format)
	}

	if err := os.Chmod(stagePath, 0o700); err != nil {
		return "", false, fmt.Errorf("set managed executable permissions: %w", err)
	}
	if err := activateManagedFile(stagePath, target, finalSize, finalSHA); err != nil {
		return "", false, err
	}
	if stagePath == downloadPath {
		keepDownload = false
	}

	valid, verifyErr := verifyManagedFile(target, finalSize, finalSHA)
	if verifyErr != nil {
		return "", false, fmt.Errorf("verify activated managed executable: %w", verifyErr)
	}
	if !valid {
		return "", false, fmt.Errorf("verify activated managed executable: content mismatch")
	}
	return target, true, nil
}

func (p *PortableProvisioner) targetPath(ref discovery.ToolRef, version, executableName string) (string, error) {
	root := p.rootDir
	if root == "" {
		cache, err := os.UserCacheDir()
		if err != nil {
			return "", fmt.Errorf("resolve current-user cache directory: %w", err)
		}
		root = filepath.Join(cache, "CLIHarbor")
	}
	return filepath.Join(root, "tools", ref.PackID, ref.ToolID, version, executableName), nil
}

func (p *PortableProvisioner) download(ctx context.Context, directory string, artifact packs.InstallArtifact) (string, error) {
	source, err := url.Parse(artifact.URL)
	if err != nil || source.Host == "" {
		return "", fmt.Errorf("parse portable install source URL")
	}
	if !p.allowInsecure && !strings.EqualFold(source.Scheme, "https") {
		return "", fmt.Errorf("portable install source must use HTTPS")
	}

	temp, err := os.CreateTemp(directory, ".cliharbor-download-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create portable download staging file: %w", err)
	}
	tempPath := temp.Name()
	keep := false
	defer func() {
		_ = temp.Close()
		if !keep {
			_ = os.Remove(tempPath)
		}
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.URL, nil)
	if err != nil {
		return "", fmt.Errorf("build portable install request: %w", err)
	}
	req.Header.Set("User-Agent", "CLIHarbor-portable-installer")
	req.Header.Set("Accept", "application/octet-stream")

	client := p.client
	if client == nil {
		client = NewPortableProvisioner().client
	}
	requestClient := *client
	requestClient.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("portable install exceeded redirect limit")
		}
		if !p.allowedDownloadURL(req.URL, source, artifact.RedirectHosts) {
			return fmt.Errorf("portable install redirected to an unapproved origin")
		}
		return nil
	}

	response, err := requestClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("download portable CLI artifact: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download portable CLI artifact: unexpected HTTP status %d", response.StatusCode)
	}
	if !p.allowedDownloadURL(response.Request.URL, source, artifact.RedirectHosts) {
		return "", fmt.Errorf("download portable CLI artifact: final origin is not approved")
	}
	if response.ContentLength >= 0 && response.ContentLength != artifact.SizeBytes {
		return "", fmt.Errorf("download portable CLI artifact: unexpected payload size")
	}

	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temp, hash), io.LimitReader(response.Body, artifact.SizeBytes+1))
	if err != nil {
		return "", fmt.Errorf("download portable CLI artifact payload: %w", err)
	}
	if written != artifact.SizeBytes {
		return "", fmt.Errorf("download portable CLI artifact: unexpected payload size")
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), artifact.SHA256) {
		return "", fmt.Errorf("download portable CLI artifact: SHA-256 verification failed")
	}
	if err := temp.Sync(); err != nil {
		return "", fmt.Errorf("sync portable download staging file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return "", fmt.Errorf("close portable download staging file: %w", err)
	}
	keep = true
	return tempPath, nil
}

func (p *PortableProvisioner) allowedDownloadURL(candidate, source *url.URL, redirectHosts []string) bool {
	if candidate == nil || source == nil {
		return false
	}
	if p.allowInsecure && candidate.Scheme == "http" && candidate.Host == source.Host {
		return true
	}
	if !strings.EqualFold(candidate.Scheme, "https") || candidate.User != nil || candidate.Fragment != "" || candidate.Port() != "" {
		return false
	}
	if strings.EqualFold(candidate.Host, source.Host) {
		return true
	}
	host := strings.ToLower(candidate.Hostname())
	for _, allowed := range redirectHosts {
		if host == strings.ToLower(allowed) {
			return true
		}
	}
	return false
}

func extractZIPExecutable(directory, archivePath string, artifact packs.InstallArtifact) (string, error) {
	if artifact.ArchivePath == "" || artifact.ExecutableSHA256 == "" || artifact.ExecutableSizeBytes <= 0 {
		return "", fmt.Errorf("ZIP install metadata is incomplete")
	}
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		return "", fmt.Errorf("open verified portable ZIP artifact: %w", err)
	}
	defer archive.Close()
	if len(archive.File) > maxManagedZIPEntries {
		return "", fmt.Errorf("portable ZIP artifact contains too many entries")
	}

	var selected *zip.File
	for _, entry := range archive.File {
		if entry.Name != artifact.ArchivePath {
			continue
		}
		if selected != nil {
			return "", fmt.Errorf("portable ZIP artifact contains duplicate executable entries")
		}
		selected = entry
	}
	if selected == nil {
		return "", fmt.Errorf("portable ZIP artifact does not contain the declared executable")
	}
	mode := selected.FileInfo().Mode()
	if mode&os.ModeSymlink != 0 || !mode.IsRegular() {
		return "", fmt.Errorf("portable ZIP executable entry is not a regular file")
	}
	if selected.UncompressedSize64 != uint64(artifact.ExecutableSizeBytes) {
		return "", fmt.Errorf("portable ZIP executable entry has unexpected size")
	}

	reader, err := selected.Open()
	if err != nil {
		return "", fmt.Errorf("open portable ZIP executable entry: %w", err)
	}
	defer reader.Close()

	temp, err := os.CreateTemp(directory, ".cliharbor-executable-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create portable executable staging file: %w", err)
	}
	tempPath := temp.Name()
	keep := false
	defer func() {
		_ = temp.Close()
		if !keep {
			_ = os.Remove(tempPath)
		}
	}()

	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temp, hash), io.LimitReader(reader, artifact.ExecutableSizeBytes+1))
	if err != nil {
		return "", fmt.Errorf("extract portable ZIP executable: %w", err)
	}
	if written != artifact.ExecutableSizeBytes {
		return "", fmt.Errorf("portable ZIP executable entry has unexpected size")
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), artifact.ExecutableSHA256) {
		return "", fmt.Errorf("portable ZIP executable SHA-256 verification failed")
	}
	if err := temp.Sync(); err != nil {
		return "", fmt.Errorf("sync portable executable staging file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return "", fmt.Errorf("close portable executable staging file: %w", err)
	}
	keep = true
	return tempPath, nil
}

func activateManagedFile(stagePath, target string, expectedSize int64, expectedSHA string) error {
	if err := os.Rename(stagePath, target); err != nil {
		if valid, verifyErr := verifyManagedFile(target, expectedSize, expectedSHA); verifyErr == nil && valid {
			return nil
		}
		return fmt.Errorf("activate managed executable: %w", err)
	}
	return nil
}

func verifyManagedFile(path string, expectedSize int64, expectedSHA string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() != expectedSize {
		return false, fmt.Errorf("managed executable is not the expected regular file")
	}

	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()

	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, expectedSize+1))
	if err != nil {
		return false, err
	}
	if written != expectedSize {
		return false, nil
	}
	return strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), expectedSHA), nil
}

func finalExecutableIdentity(artifact packs.InstallArtifact) (string, int64, error) {
	switch artifact.Format {
	case packs.InstallFormatExecutable:
		return artifact.SHA256, artifact.SizeBytes, nil
	case packs.InstallFormatZIP:
		if artifact.ExecutableSHA256 == "" || artifact.ExecutableSizeBytes <= 0 {
			return "", 0, fmt.Errorf("ZIP portable install metadata is incomplete")
		}
		return artifact.ExecutableSHA256, artifact.ExecutableSizeBytes, nil
	default:
		return "", 0, fmt.Errorf("unsupported portable install format %q", artifact.Format)
	}
}

func safeManagedSegment(value string) bool {
	if len(value) == 0 || len(value) > 128 || filepath.Base(value) != value || strings.ContainsAny(value, `/\`) || value == "." || value == ".." {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return true
}

func safeManagedVersion(value string) bool {
	if len(value) == 0 || len(value) > 128 || filepath.Base(value) != value || strings.ContainsAny(value, `/\`) || value == "." || value == ".." {
		return false
	}
	for _, character := range value {
		if (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') &&
			character != '.' && character != '-' && character != '+' {
			return false
		}
	}
	return true
}
