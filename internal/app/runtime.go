package app

import (
	"context"
	"fmt"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

type RuntimeState struct {
	Registry  *packs.Registry
	Discovery discovery.Snapshot
}

func prepareRuntime(ctx context.Context, options Options) (RuntimeState, error) {
	if options.PackDirectory != "" && len(options.PackFiles) != 0 {
		return RuntimeState{}, fmt.Errorf("configure either --pack-dir or --pack-file, not both")
	}

	loader := packs.NewLoader()
	var (
		registry *packs.Registry
		err      error
	)
	switch {
	case options.PackDirectory != "":
		registry, err = loader.LoadDirectory(options.PackDirectory)
	case len(options.PackFiles) != 0:
		registry, err = loader.LoadFiles(options.PackFiles)
	default:
		registry, err = packs.NewRegistry(nil)
	}
	if err != nil {
		return RuntimeState{}, fmt.Errorf("load configured packs: %w", err)
	}

	resolver := discovery.NewResolver(discovery.Config{})
	snapshot, err := resolver.Discover(ctx, registry, options.ToolOverrides)
	if err != nil {
		return RuntimeState{}, err
	}
	return RuntimeState{Registry: registry, Discovery: snapshot}, nil
}

func (s RuntimeState) counts() (packsCount, ready, unavailable int) {
	if s.Registry != nil {
		packsCount = len(s.Registry.Packs())
	}
	for _, tool := range s.Discovery.Tools() {
		if tool.Healthy() {
			ready++
		} else {
			unavailable++
		}
	}
	return
}
