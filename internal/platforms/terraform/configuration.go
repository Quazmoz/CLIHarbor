package terraform

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/executor"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

const (
	maxConfigFiles = 64
	maxConfigBytes = 256 << 10
	maxConfigTotalBytes = 2 << 20
	maxFormatDuration = 25 * time.Second
)

// Only direct-child .tf files enter this inventory. terraform fmt also accepts
// tfvars; never pass them here because they commonly contain secret values.
func configurationEntries(root approvedRoot) ([]os.DirEntry, error) {
	entries, err := boundedDirectoryEntries(root)
	if err != nil { return nil, errors.New("cannot enumerate bounded approved Terraform configuration") }
	files := make([]os.DirEntry, 0)
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".tf") || entry.IsDir() ||
			entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() < 0 ||
			info.Size() > maxConfigBytes {
			continue
		}
		// Match the exact eligibility predicate in Projects, including the
		// file limit. readConfiguration revalidates these properties after
		// obtaining the pinned root handle, so filesystem races fail closed.
		if len(files) == maxConfigFiles {
			return nil, errors.New("approved Terraform directory exceeds configuration file limit")
		}
		files = append(files, entry)
	}
	return files, nil
}

// readConfiguration takes a bounded snapshot. os.Root ensures a swapped
// symlink/junction cannot redirect the read outside the approved root even
// between path checks. The checks also reject in-root redirection/replacement.
func readConfiguration(root *os.Root, name string) ([]byte, string) {
	before, err := root.Lstat(name)
	if err != nil { return nil, "inspection-failed" }
	if !before.Mode().IsRegular() { return nil, "unsupported" }
	if before.Size() < 0 || before.Size() > maxConfigBytes { return nil, "unsupported" }
	file, err := root.Open(name)
	if err != nil { return nil, "inspection-failed" }
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(before, opened) { return nil, "inspection-failed" }
	data, err := io.ReadAll(io.LimitReader(file, maxConfigBytes+1))
	if err != nil || len(data) > maxConfigBytes { return nil, "inspection-failed" }
	after, err := root.Lstat(name)
	openedAfter, openedErr := file.Stat()
	if err != nil || openedErr != nil || !os.SameFile(before, after) || !os.SameFile(before, openedAfter) ||
		before.Size() != after.Size() || before.Size() != openedAfter.Size() ||
		!before.ModTime().Equal(after.ModTime()) || !before.ModTime().Equal(openedAfter.ModTime()) {
		return nil, "inspection-failed"
	}
	return data, ""
}

// FormatCheck runs the already-discovered, identity-bound Terraform executable
// in a neutral temporary directory, with vetted configuration bytes on stdin.
// Browser inputs can only select an opaque startup-approved project ID.
func (p *Platform) FormatCheck(ctx context.Context, projectID string) (server.TerraformFormatReport, error) {
	var empty server.TerraformFormatReport
	if ctx == nil { return empty, errors.New("format check needs a request context") }
	select {
	case p.formatSlot <- struct{}{}:
		defer func() { <-p.formatSlot }()
	default:
		return empty, errors.New("Terraform formatting check already running")
	}

	root, err := p.root(projectID)
	if err != nil { return empty, err }
	entries, err := configurationEntries(root)
	if err != nil { return empty, err }
	p.mu.RLock()
	tool := p.tool
	p.mu.RUnlock()
	if tool.Status != discovery.StatusReady || !tool.ExecutableIdentity.Valid() || tool.Path == "" {
		return empty, errors.New("approved Terraform executable is unavailable")
	}
	if !tool.ExecutableIdentity.Matches(tool.Path) { return empty, errors.New("approved Terraform executable changed") }

	// OpenRoot is traversal-resistant in the pinned Go toolchain (>=1.24).
	// Reject a root replaced after startup before inspecting any file content.
	dir, err := openApprovedRoot(root)
	if err != nil { return empty, err }
	defer dir.Close()

	ctx, cancel := context.WithTimeout(ctx, maxFormatDuration)
	defer cancel()
	report := server.TerraformFormatReport{
		ProjectID: projectID, TerraformVersion: tool.Version,
		Files: make([]server.TerraformFormatFile, 0, len(entries)),
	}
	total := 0
	for _, entry := range entries {
		item := server.TerraformFormatFile{Name: entry.Name()}
		if ctx.Err() != nil {
			item.Status = "inspection-failed"
			item.Reason = "The inspection deadline or request was cancelled."
			report.Files = append(report.Files, item)
			continue
		}
		// Once the project byte budget is exhausted, never read more files;
		// the report remains complete but their checks fail closed.
		if total >= maxConfigTotalBytes {
			item.Status = "inspection-failed"
			item.Reason = "Configuration inspection exceeds the project byte limit."
			report.Files = append(report.Files, item)
			continue
		}
		data, problem := readConfiguration(dir, entry.Name())
		if problem != "" {
			item.Status = problem
			item.Reason = "This file is unsafe, oversized, inaccessible, or changed while reading."
			report.Files = append(report.Files, item)
			continue
		}
		total += len(data)
		if total > maxConfigTotalBytes {
			item.Status = "inspection-failed"
			item.Reason = "Configuration inspection exceeds the project byte limit."
			report.Files = append(report.Files, item)
			continue
		}
		if !tool.ExecutableIdentity.Matches(tool.Path) {
			item.Status = "inspection-failed"
			item.Reason = "The Terraform executable changed since discovery."
			report.Files = append(report.Files, item)
			continue
		}
		// Do not return, log, or persist raw stdout/stderr: diagnostics and
		// formatted stdin can contain configuration secrets or source excerpts.
		result, probeErr := executor.RunReadOnlyProbe(ctx, tool.Path,
			[]string{"fmt", "-check", "-write=false", "-no-color", "-"}, executor.ReadOnlyProbeConfig{
				Timeout: 5 * time.Second, MaxOutputBytes: 1024, Input: data,
			})
		if probeErr != nil || result.TimedOut || result.Cancelled || result.Truncated ||
			!tool.ExecutableIdentity.Matches(tool.Path) {
			item.Status = "inspection-failed"
			item.Reason = "Terraform execution failed, exceeded limits, or executable identity changed."
		} else {
			switch {
			case result.ExitCode == 0 && len(result.Stderr) == 0:
				item.Status = "formatted"
			case result.ExitCode == 3 && len(result.Stderr) == 0:
				item.Status = "needs-formatting"
			default:
				item.Status = "inspection-failed"
				item.Reason = "Terraform rejected this input or returned an unexpected exit status."
			}
		}
		report.Files = append(report.Files, item)
	}
	report.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	return report, nil
}
