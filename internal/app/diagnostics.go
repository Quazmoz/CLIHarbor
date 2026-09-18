package app

import (
	"context"
	"fmt"
	"runtime"

	"github.com/Quazmoz/CLIHarbor/internal/diagnostics"
	"github.com/Quazmoz/CLIHarbor/internal/hostinfo"
)

func ExportDiagnostics(ctx context.Context, options Options, destination string) error {
	if options.Out == nil {
		return fmt.Errorf("diagnostics output writer is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	state, err := prepareRuntime(ctx, options)
	if err != nil {
		return err
	}
	bundle := buildDiagnosticBundle(options, state, hostinfo.Current())
	digest, err := diagnostics.WriteBundle(ctx, destination, bundle)
	if err != nil {
		return fmt.Errorf("export diagnostics: %w", err)
	}
	if _, err := fmt.Fprintf(options.Out,
		"Diagnostic bundle exported to: %s\nSchema: %s\nSHA-256: %s\n",
		destination, diagnostics.SchemaVersion, digest,
	); err != nil {
		return fmt.Errorf("write diagnostics export status: %w", err)
	}
	_, err = fmt.Fprintln(options.Out, "The bundle is local-only and intentionally excludes command output, argv, environment values, executable paths, pack source paths, browser/session secrets, and credential material.")
	return err
}

func buildDiagnosticBundle(options Options, state RuntimeState, host hostinfo.Info) diagnostics.Bundle {
	build := normalizeBuildInfo(options)
	packsCount, ready, unavailable := state.counts()
	bundle := diagnostics.Bundle{
		SchemaVersion: diagnostics.SchemaVersion,
		CLIHarbor: diagnostics.BuildInfo{
			Version: build.Version, Commit: build.Commit, BuildMode: build.BuildMode,
		},
		Runtime: diagnostics.RuntimeInfo{
			GoVersion: runtime.Version(), OS: host.OS, OSVersion: host.Version, Architecture: host.Architecture,
		},
		Configuration: diagnostics.Configuration{
			PackSourceMode: packSourceMode(options),
			PackCount: packsCount,
			ToolOverrideCount: len(options.ToolOverrides),
		},
		Health: diagnostics.Health{ToolsReady: ready, ToolsUnavailable: unavailable},
	}

	for _, loaded := range state.Registry.Packs() {
		bundle.Packs = append(bundle.Packs, diagnostics.PackRecord{
			ID: loaded.Pack.Metadata.ID, Version: loaded.Pack.Metadata.Version,
		})
	}
	for _, tool := range state.Discovery.Tools() {
		bundle.Tools = append(bundle.Tools, diagnostics.ToolRecord{
			PackID: tool.PackID,
			PackVersion: tool.PackVersion,
			ToolID: tool.ToolID,
			Status: string(tool.Status),
			Version: tool.Version,
			CandidateCount: len(tool.Candidates),
		})
	}
	return bundle
}

func packSourceMode(options Options) string {
	switch {
	case options.PackDirectory != "":
		return "directory"
	case len(options.PackFiles) != 0:
		return "files"
	default:
		return "none"
	}
}
