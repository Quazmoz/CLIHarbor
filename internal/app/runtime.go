package app

import (
	"context"
	"fmt"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/toolbootstrap"
	packassets "github.com/Quazmoz/CLIHarbor/packs"
)

type RuntimeState struct {
	Registry      *packs.Registry
	Discovery     discovery.Snapshot
	SetupMessages []string
}

func prepareRuntime(ctx context.Context, options Options) (RuntimeState, error) {
	if options.PackDirectory != "" && len(options.PackFiles) != 0 {
		return RuntimeState{}, fmt.Errorf("configure either --pack-dir or --pack-file, not both")
	}

	loader := packs.NewLoader()
	var (
		registry          *packs.Registry
		err               error
		usingDefaultPacks bool
	)
	switch {
	case options.PackDirectory != "":
		registry, err = loader.LoadDirectory(options.PackDirectory)
	case len(options.PackFiles) != 0:
		registry, err = loader.LoadFiles(options.PackFiles)
	case options.LoadDefaultPacks:
		registry, err = loader.LoadBuiltins(packassets.Builtins())
		usingDefaultPacks = true
	default:
		registry, err = packs.NewRegistry(nil)
	}
	if err != nil {
		return RuntimeState{}, fmt.Errorf("load configured packs: %w", err)
	}

	overrides := cloneToolOverrides(options.ToolOverrides)
	resolver := discovery.NewResolver(discovery.Config{})
	snapshot, err := resolver.Discover(ctx, registry, overrides)
	if err != nil {
		return RuntimeState{}, err
	}

	state := RuntimeState{Registry: registry, Discovery: snapshot}
	if !usingDefaultPacks || !options.AutoProvisionTools {
		return state, nil
	}

	provisioner := options.ToolProvisioner
	if provisioner == nil {
		provisioner = toolbootstrap.NewConjurProvisioner()
	}
	changed := false
	for _, tool := range snapshot.Tools() {
		if tool.Status != discovery.StatusMissing {
			continue
		}
		ref := discovery.ToolRef{PackID: tool.PackID, ToolID: tool.ToolID}
		if _, explicitlyOverridden := options.ToolOverrides[ref]; explicitlyOverridden {
			continue
		}
		path, installed, provisionErr := provisioner.Ensure(ctx, ref)
		if provisionErr != nil {
			if ref == toolbootstrap.ConjurRef {
				state.SetupMessages = append(state.SetupMessages,
					"Automatic Conjur setup could not complete. CLIHarbor did not bypass device policy; use an approved existing Conjur installation or allow the pinned CyberArk download and restart CLIHarbor.")
			}
			continue
		}
		if path == "" {
			continue
		}
		overrides[ref] = path
		changed = true
		if installed && ref == toolbootstrap.ConjurRef {
			state.SetupMessages = append(state.SetupMessages,
				"Installed and verified CyberArk Conjur CLI "+toolbootstrap.ConjurVersion+" for the current user; no administrator credentials or machine-wide changes were used.")
		}
	}
	if !changed {
		return state, nil
	}

	snapshot, err = resolver.Discover(ctx, registry, overrides)
	if err != nil {
		return RuntimeState{}, err
	}
	state.Discovery = snapshot
	return state, nil
}

func cloneToolOverrides(source map[discovery.ToolRef]string) map[discovery.ToolRef]string {
	if len(source) == 0 {
		return make(map[discovery.ToolRef]string)
	}
	cloned := make(map[discovery.ToolRef]string, len(source))
	for ref, path := range source {
		cloned[ref] = path
	}
	return cloned
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
