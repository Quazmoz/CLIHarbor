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
	managedConjurSelected := false
	managedConjurInstalled := false
	for _, tool := range snapshot.Tools() {
		ref := discovery.ToolRef{PackID: tool.PackID, ToolID: tool.ToolID}
		if ref != toolbootstrap.ConjurRef || !shouldAutoProvision(tool, options.ToolOverrides) {
			continue
		}
		if ref == toolbootstrap.ConjurRef && options.Out != nil {
			if _, writeErr := fmt.Fprintf(options.Out,
				"Setup: Conjur CLI was not found; installing verified CyberArk Conjur CLI %s for the current user...\n",
				toolbootstrap.ConjurVersion,
			); writeErr != nil {
				return RuntimeState{}, fmt.Errorf("write automatic setup progress: %w", writeErr)
			}
		}
		path, installed, provisionErr := provisioner.Ensure(ctx, ref)
		if provisionErr != nil {
			// Cancellation is a lifecycle signal, not a dependency failure. Do
			// not swallow it and continue opening a browser/runtime after the
			// caller has already asked CLIHarbor to stop.
			if ctxErr := ctx.Err(); ctxErr != nil {
				return RuntimeState{}, ctxErr
			}
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
		if ref == toolbootstrap.ConjurRef {
			managedConjurSelected = true
			managedConjurInstalled = installed
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
	if managedConjurSelected {
		managed, ok := snapshot.Find(toolbootstrap.ConjurRef)
		if ok && managed.Healthy() {
			if managedConjurInstalled {
				state.SetupMessages = append(state.SetupMessages,
					"Installed, byte-verified, and qualified CyberArk Conjur CLI "+toolbootstrap.ConjurVersion+" for the current user; no administrator credentials or machine-wide changes were used.")
			}
		} else {
			status := "unavailable"
			if ok {
				status = string(managed.Status)
			}
			state.SetupMessages = append(state.SetupMessages,
				fmt.Sprintf("Managed CyberArk Conjur CLI %s is byte-verified but did not pass local readiness qualification (%s). No Conjur tasks were enabled; run cliharbor doctor for local diagnostic details.", toolbootstrap.ConjurVersion, status))
		}
	}
	return state, nil
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
