package app

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/evidence"
	"github.com/Quazmoz/CLIHarbor/internal/executor"
	"github.com/Quazmoz/CLIHarbor/internal/hostinfo"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

const maxInventoryProbeSelections = 32

type InventoryConfig struct {
	ProbeSelectors []string
	ExportPath     string
}

// Inventory produces a sanitized Phase 0 view of explicitly configured trusted
// packs and tools. Evidence probes are opt-in and can only select fixed argv
// already declared in those packs.
func Inventory(ctx context.Context, options Options, config InventoryConfig) error {
	if options.Out == nil {
		return fmt.Errorf("inventory output writer is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	state, err := prepareRuntime(ctx, options)
	if err != nil {
		return err
	}

	selectors, err := parseProbeSelectors(config.ProbeSelectors)
	if err != nil {
		return err
	}
	host := hostinfo.Current()
	bundle := evidence.Bundle{
		SchemaVersion: evidence.SchemaVersion,
		GeneratedAt:   time.Now().UTC(),
		CLIHarbor:     normalizeBuildInfo(options),
		Host: evidence.HostInfo{
			OS:           host.OS,
			OSVersion:    host.Version,
			Architecture: host.Architecture,
		},
	}

	for _, toolState := range state.Discovery.Tools() {
		tool, ok := state.Registry.FindTool(toolState.PackID, toolState.ToolID)
		if !ok {
			return fmt.Errorf("inventory registry lost tool %s/%s", toolState.PackID, toolState.ToolID)
		}
		helpIDs := make([]string, 0, len(tool.HelpProbes))
		for id := range tool.HelpProbes {
			helpIDs = append(helpIDs, id)
		}
		sort.Strings(helpIDs)
		bundle.Tools = append(bundle.Tools, evidence.ToolRecord{
			PackID:                 toolState.PackID,
			PackVersion:            toolState.PackVersion,
			ToolID:                 toolState.ToolID,
			Status:                 string(toolState.Status),
			Version:                toolState.Version,
			VersionConstraint:      toolState.VersionConstraint,
			VersionProbeConfigured: tool.VersionProbe != nil,
			CandidateCount:         len(toolState.Candidates),
			Diagnostic:             inventoryDiagnostic(toolState.Status),
			AvailableHelpProbes:    helpIDs,
		})
	}

	toolIndex := make(map[discovery.ToolRef]int, len(bundle.Tools))
	for i := range bundle.Tools {
		toolIndex[discovery.ToolRef{PackID: bundle.Tools[i].PackID, ToolID: bundle.Tools[i].ToolID}] = i
	}

	for _, selector := range selectors {
		ref := discovery.ToolRef{PackID: selector.packID, ToolID: selector.toolID}
		index, ok := toolIndex[ref]
		if !ok {
			return fmt.Errorf("probe selector %q references an unknown configured tool", selector.raw)
		}
		tool, _ := state.Registry.FindTool(selector.packID, selector.toolID)
		toolState, _ := state.Discovery.Find(ref)
		probe, err := runInventoryProbe(ctx, toolState, tool, selector)
		if err != nil {
			return err
		}
		bundle.Tools[index].Probes = append(bundle.Tools[index].Probes, probe)
	}

	if err := evidence.Validate(bundle); err != nil {
		return fmt.Errorf("validate Phase 0 evidence: %w", err)
	}
	if err := printInventory(options, bundle, config.ExportPath == ""); err != nil {
		return err
	}
	if config.ExportPath != "" {
		if err := evidence.WriteBundle(ctx, config.ExportPath, bundle); err != nil {
			return fmt.Errorf("export Phase 0 evidence: %w", err)
		}
		if _, err := fmt.Fprintf(options.Out, "\nSanitized Phase 0 evidence exported to: %s\n", config.ExportPath); err != nil {
			return fmt.Errorf("write inventory export status: %w", err)
		}
		if _, err := fmt.Fprintln(options.Out, "Review the JSON before sharing it; CLIHarbor intentionally excludes executable paths, environment dumps, browser secrets, and credential-store contents."); err != nil {
			return fmt.Errorf("write inventory export guidance: %w", err)
		}
	}
	return nil
}

type probeSelector struct {
	raw     string
	packID  string
	toolID  string
	probeID string
}

func parseProbeSelectors(values []string) ([]probeSelector, error) {
	if len(values) > maxInventoryProbeSelections {
		return nil, fmt.Errorf("at most %d inventory probes may be selected", maxInventoryProbeSelections)
	}
	seen := make(map[string]struct{}, len(values))
	selectors := make([]probeSelector, 0, len(values))
	for _, raw := range values {
		parts := strings.Split(raw, "/")
		if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
			return nil, fmt.Errorf("invalid --probe %q; expected pack/tool/probe", raw)
		}
		if _, exists := seen[raw]; exists {
			return nil, fmt.Errorf("duplicate --probe selector %q", raw)
		}
		seen[raw] = struct{}{}
		selectors = append(selectors, probeSelector{raw: raw, packID: parts[0], toolID: parts[1], probeID: parts[2]})
	}
	sort.Slice(selectors, func(i, j int) bool { return selectors[i].raw < selectors[j].raw })
	return selectors, nil
}

func runInventoryProbe(ctx context.Context, state discovery.ToolState, tool packs.Tool, selector probeSelector) (evidence.ProbeRecord, error) {
	record := evidence.ProbeRecord{ID: selector.probeID, Identity: selector.raw}
	var (
		args          []string
		timeoutMillis int
	)
	if selector.probeID == "version" {
		record.Kind = "version"
		if tool.VersionProbe == nil {
			return evidence.ProbeRecord{}, fmt.Errorf("probe selector %q requested a version probe that is not declared", selector.raw)
		}
		args = append([]string(nil), tool.VersionProbe.Args...)
		timeoutMillis = tool.VersionProbe.TimeoutMillis
	} else {
		record.Kind = "help"
		probe, ok := tool.HelpProbes[selector.probeID]
		if !ok {
			return evidence.ProbeRecord{}, fmt.Errorf("probe selector %q references an undeclared help probe", selector.raw)
		}
		args = append([]string(nil), probe.Args...)
		timeoutMillis = probe.TimeoutMillis
	}

	if state.Path == "" || !state.ExecutableIdentity.Valid() {
		record.Status = "unavailable"
		record.Diagnostic = inventoryDiagnostic(state.Status)
		return record, nil
	}
	if !state.ExecutableIdentity.Matches(state.Path) {
		record.Status = "identity-changed"
		record.Diagnostic = "resolved executable changed after inventory discovery; probe refused"
		return record, nil
	}
	timeout := time.Duration(timeoutMillis) * time.Millisecond
	result, err := executor.RunReadOnlyProbe(ctx, state.Path, args, executor.ReadOnlyProbeConfig{
		Timeout:        timeout,
		MaxOutputBytes: evidence.MaxCapturedTextBytes,
	})
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return evidence.ProbeRecord{}, ctxErr
		}
		record.Status = "failed"
		record.Diagnostic = "probe execution could not be completed safely"
		return record, nil
	}

	record.StartedAt = result.StartedAt
	record.EndedAt = result.EndedAt
	record.TimedOut = result.TimedOut
	record.Cancelled = result.Cancelled
	record.Truncated = result.Truncated
	exit := result.ExitCode
	record.ExitCode = &exit
	record.Stdout = sanitizeProbeOutput(result.Stdout, state.Path)
	record.Stderr = sanitizeProbeOutput(result.Stderr, state.Path)
	switch {
	case result.Cancelled:
		record.Status = "cancelled"
	case result.TimedOut:
		record.Status = "timed-out"
	case result.ExitCode != 0:
		record.Status = "exited-nonzero"
	default:
		record.Status = "exited"
	}
	return record, nil
}

func sanitizeProbeOutput(raw []byte, executablePath string) string {
	text := string(raw)
	if executablePath != "" {
		clean := filepath.Clean(executablePath)
		for _, variant := range []string{clean, filepath.ToSlash(clean), strings.ReplaceAll(clean, "/", "\\")} {
			if variant != "" {
				text = strings.ReplaceAll(text, variant, "[EXECUTABLE]")
			}
		}
	}
	return evidence.SanitizeText([]byte(text))
}

func inventoryDiagnostic(status discovery.Status) string {
	switch status {
	case discovery.StatusReady:
		return "tool is ready"
	case discovery.StatusMissing:
		return "no matching executable found on trusted discovery paths"
	case discovery.StatusAmbiguous:
		return "multiple matching executables found; use CLI --tool-path to disambiguate"
	case discovery.StatusIncompatible:
		return "detected version does not satisfy the trusted pack constraint"
	case discovery.StatusProbeFailed:
		return "configured version probe did not produce usable version evidence"
	case discovery.StatusInvalidOverride:
		return "explicit CLI tool override was invalid"
	case discovery.StatusIdentityFailed:
		return "resolved executable identity could not be recorded"
	case discovery.StatusUnsupportedPlatform:
		return "pack does not support this operating system"
	default:
		return "tool state is unavailable"
	}
}

func printInventory(options Options, bundle evidence.Bundle, includeCapturedOutput bool) error {
	hostVersion := bundle.Host.OSVersion
	if hostVersion == "" {
		hostVersion = "not reported"
	}
	if _, err := fmt.Fprintf(options.Out,
		"CLIHarbor %s inventory\nBuild: %s (%s)\nHost: %s %s/%s\nConfigured tools: %d\n",
		bundle.CLIHarbor.Version, bundle.CLIHarbor.BuildMode, bundle.CLIHarbor.Commit,
		bundle.Host.OS, hostVersion, bundle.Host.Architecture, len(bundle.Tools),
	); err != nil {
		return fmt.Errorf("write inventory summary: %w", err)
	}
	if len(bundle.Tools) == 0 {
		_, err := fmt.Fprintln(options.Out, "No trusted packs are configured. Supply --pack-file or --pack-dir; CLIHarbor never guesses vendor executable names.")
		return err
	}
	for _, tool := range bundle.Tools {
		if _, err := fmt.Fprintf(options.Out, "\n%s/%s: %s\n", tool.PackID, tool.ToolID, tool.Status); err != nil {
			return err
		}
		if tool.Version != "" {
			if _, err := fmt.Fprintf(options.Out, "  version: %s\n", tool.Version); err != nil {
				return err
			}
		}
		if tool.VersionConstraint != "" {
			if _, err := fmt.Fprintf(options.Out, "  constraint: %s\n", tool.VersionConstraint); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintf(options.Out, "  candidates: %d\n  diagnostic: %s\n", tool.CandidateCount, tool.Diagnostic); err != nil {
			return err
		}
		if tool.VersionProbeConfigured {
			if _, err := fmt.Fprintln(options.Out, "  version evidence probe: version"); err != nil {
				return err
			}
		}
		if len(tool.AvailableHelpProbes) != 0 {
			if _, err := fmt.Fprintf(options.Out, "  help evidence probes: %s\n", strings.Join(tool.AvailableHelpProbes, ", ")); err != nil {
				return err
			}
		}
		for _, probe := range tool.Probes {
			exit := "-"
			if probe.ExitCode != nil {
				exit = fmt.Sprintf("%d", *probe.ExitCode)
			}
			if _, err := fmt.Fprintf(options.Out, "  probe %s: %s (exit=%s, truncated=%t)\n", probe.ID, probe.Status, exit, probe.Truncated); err != nil {
				return err
			}
			if includeCapturedOutput {
				if probe.Stdout != "" {
					if _, err := fmt.Fprintf(options.Out, "    stdout:\n%s\n", indentEvidence(probe.Stdout)); err != nil {
						return err
					}
				}
				if probe.Stderr != "" {
					if _, err := fmt.Fprintf(options.Out, "    stderr:\n%s\n", indentEvidence(probe.Stderr)); err != nil {
						return err
					}
				}
			}
		}
	}
	return nil
}

func indentEvidence(value string) string {
	value = strings.TrimSuffix(value, "\n")
	return "      " + strings.ReplaceAll(value, "\n", "\n      ")
}
