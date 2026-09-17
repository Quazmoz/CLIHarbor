package app

import (
	"context"
	"fmt"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

type DoctorError struct {
	Unavailable int
}

func (e *DoctorError) Error() string {
	return fmt.Sprintf("doctor found %d unavailable or incompatible tool(s)", e.Unavailable)
}

func Doctor(ctx context.Context, options Options) error {
	if options.Out == nil {
		return fmt.Errorf("doctor output writer is required")
	}
	if options.Version == "" {
		options.Version = "dev"
	}
	state, err := prepareRuntime(ctx, options)
	if err != nil {
		return err
	}

	packsCount, ready, unavailable := state.counts()
	if _, err := fmt.Fprintf(options.Out, "CLIHarbor %s doctor\nConfigured packs: %d\nTools ready: %d\nTools unavailable: %d\n", options.Version, packsCount, ready, unavailable); err != nil {
		return fmt.Errorf("write doctor summary: %w", err)
	}
	if packsCount == 0 {
		_, err := fmt.Fprintln(options.Out, "No packs configured. Use --pack-file or --pack-dir to inspect tool availability.")
		return err
	}

	for _, tool := range state.Discovery.Tools() {
		if _, err := fmt.Fprintf(options.Out, "\n%s/%s: %s\n", tool.PackID, tool.ToolID, tool.Status); err != nil {
			return fmt.Errorf("write doctor tool status: %w", err)
		}
		if tool.Path != "" {
			if _, err := fmt.Fprintf(options.Out, "  path: %s\n", tool.Path); err != nil {
				return err
			}
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
		for _, candidate := range tool.Candidates {
			if tool.Status == discovery.StatusAmbiguous {
				if _, err := fmt.Fprintf(options.Out, "  candidate: %s\n", candidate.Path); err != nil {
					return err
				}
			}
		}
		if tool.Message != "" {
			if _, err := fmt.Fprintf(options.Out, "  detail: %s\n", tool.Message); err != nil {
				return err
			}
		}
	}
	if unavailable != 0 {
		return &DoctorError{Unavailable: unavailable}
	}
	return nil
}
