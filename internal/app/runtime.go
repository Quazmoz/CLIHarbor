package app

import (
	"context"
	"fmt"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/platforms"
	"github.com/Quazmoz/CLIHarbor/internal/platforms/conjur"
	"github.com/Quazmoz/CLIHarbor/internal/toolbootstrap"
	packassets "github.com/Quazmoz/CLIHarbor/packs"
)

type RuntimeState struct {
	Registry      *packs.Registry
	Discovery     discovery.Snapshot
	SetupMessages []string
}

func prepareRuntime(ctx context.Context, options Options) (RuntimeState, error) {
	loader := packs.NewLoader()
	loaded := make([]packs.LoadedPack, 0)
	usingDefaultPacks := options.LoadDefaultPacks

	if options.LoadDefaultPacks {
		registry, err := loader.LoadBuiltins(packassets.Builtins())
		if err != nil {
			return RuntimeState{}, fmt.Errorf("load default packs: %w", err)
		}
		loaded = append(loaded, registry.Packs()...)
	}
	if options.PackDirectory != "" {
		registry, err := loader.LoadDirectory(options.PackDirectory)
		if err != nil {
			return RuntimeState{}, fmt.Errorf("load explicit pack directory: %w", err)
		}
		loaded = append(loaded, registry.Packs()...)
	}
	if len(options.PackFiles) != 0 {
		registry, err := loader.LoadFiles(options.PackFiles)
		if err != nil {
			return RuntimeState{}, fmt.Errorf("load explicit pack files: %w", err)
		}
		loaded = append(loaded, registry.Packs()...)
	}

	registry, err := packs.NewRegistry(loaded)
	if err != nil {
		return RuntimeState{}, fmt.Errorf("combine configured packs: %w", err)
	}

	overrides := cloneToolOverrides(options.ToolOverrides)
	portable := toolbootstrap.NewPortableProvisioner()
	managedLocations := map[discovery.ToolRef]string{}
	if locationStore, locationErr := newManagedInstallLocationStore(); locationErr == nil {
		managedLocations = locationStore.Load()
	}
	for _, loaded := range registry.Packs() {
		for _, named := range registry.Tools(loaded.Pack.Metadata.ID) {
			ref := discovery.ToolRef{PackID: loaded.Pack.Metadata.ID, ToolID: named.ID}
			if _, explicit := overrides[ref]; explicit || named.Tool.Install == nil {
				continue
			}
			path, found, resolveErr := portable.ResolveInstalled(ref, named.Tool)
			if resolveErr != nil {
				return RuntimeState{}, fmt.Errorf("resolve managed tool %s: %w", ref.String(), resolveErr)
			}
			if !found {
				if customRoot := managedLocations[ref]; customRoot != "" {
					path, found, resolveErr = portable.ResolveInstalledAt(ref, named.Tool, customRoot)
					if resolveErr != nil {
						return RuntimeState{}, fmt.Errorf("resolve custom managed tool %s: %w", ref.String(), resolveErr)
					}
				}
			}
			if found {
				overrides[ref] = path
			}
		}
	}
	resolver := discovery.NewResolver(discovery.Config{FallbackDirs: discovery.DefaultUserSearchDirectories("")})
	snapshot, err := resolver.Discover(ctx, registry, overrides)
	if err != nil {
		return RuntimeState{}, err
	}

	state := RuntimeState{Registry: registry, Discovery: snapshot}
	if !usingDefaultPacks || !options.AutoProvisionTools {
		return state, nil
	}

	for _, setup := range defaultAutoSetups {
		var err error
		state, overrides, err = runAutoSetup(ctx, options, setup, resolver, registry, state, overrides)
		if err != nil {
			return RuntimeState{}, err
		}
	}
	return state, nil
}

// defaultAutoSetups lists every dedicated platform's reviewed zero-config
// bootstrap. The generic runtime carries no vendor knowledge beyond this list.
var defaultAutoSetups = []platforms.AutoSetup{conjur.AutoSetup}

func runAutoSetup(ctx context.Context, options Options, setup platforms.AutoSetup, resolver *discovery.Resolver, registry *packs.Registry, state RuntimeState, overrides map[discovery.ToolRef]string) (RuntimeState, map[discovery.ToolRef]string, error) {
	tool, ok := state.Discovery.Find(setup.Ref)
	if !ok || !shouldAutoProvision(tool, options.ToolOverrides) {
		return state, overrides, nil
	}
	provisioner := options.ToolProvisioner
	if provisioner == nil {
		// Reviewed automatic artifacts exist only for the hosts a platform
		// declares. Other hosts use discovery or pack-declared installation.
		if !setup.Supported() {
			return state, overrides, nil
		}
		provisioner = setup.NewProvisioner()
	}
	if options.Out != nil {
		if _, writeErr := fmt.Fprintf(options.Out,
			"Setup: %s CLI was not found; installing verified %s %s for the current user...\n",
			setup.ShortName, setup.DisplayName, setup.Version,
		); writeErr != nil {
			return RuntimeState{}, nil, fmt.Errorf("write automatic setup progress: %w", writeErr)
		}
	}
	path, installed, provisionErr := provisioner.Ensure(ctx, setup.Ref)
	if provisionErr != nil {
		// Cancellation is a lifecycle signal, not a dependency failure. Do
		// not swallow it and continue opening a browser/runtime after the
		// caller has already asked CLIHarbor to stop.
		if ctxErr := ctx.Err(); ctxErr != nil {
			return RuntimeState{}, nil, ctxErr
		}
		state.SetupMessages = append(state.SetupMessages, setup.FailureGuidance)
		return state, overrides, nil
	}
	if path == "" {
		return state, overrides, nil
	}
	overrides[setup.Ref] = path

	snapshot, err := resolver.Discover(ctx, registry, overrides)
	if err != nil {
		return RuntimeState{}, nil, err
	}
	state.Discovery = snapshot
	managed, ok := snapshot.Find(setup.Ref)
	switch {
	case ok && managed.Healthy():
		if installed {
			state.SetupMessages = append(state.SetupMessages,
				"Installed, byte-verified, and qualified "+setup.DisplayName+" "+setup.Version+" for the current user; no administrator credentials or machine-wide changes were used.")
		}
	default:
		status := "unavailable"
		if ok {
			status = string(managed.Status)
		}
		state.SetupMessages = append(state.SetupMessages,
			fmt.Sprintf("Managed %s %s is byte-verified but did not pass local readiness qualification (%s). No %s tasks were enabled; run cliharbor doctor for local diagnostic details.", setup.DisplayName, setup.Version, status, setup.ShortName))
	}
	return state, overrides, nil
}

func shouldAutoProvision(tool discovery.ToolState, explicit map[discovery.ToolRef]string) bool {
	if tool.Status != discovery.StatusMissing {
		return false
	}
	ref := discovery.ToolRef{PackID: tool.PackID, ToolID: tool.ToolID}
	_, overridden := explicit[ref]
	return !overridden
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
