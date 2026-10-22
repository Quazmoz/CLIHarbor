package app

import (
	"context"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

// RefreshTool is deliberately narrower than a general rescan: only a formerly
// missing tool may gain authority. It shares the installer's mutex so install,
// refresh, and the authoritative catalog transition cannot overlap.
func (i *managedToolInstaller) RefreshTool(ctx context.Context, request server.ToolInstallRequest) (server.ToolRefreshResult, error) {
	if i == nil || i.registry == nil || i.activate == nil || request.InstallRoot != "" {
		return server.ToolRefreshResult{}, &server.ToolInstallError{Code: server.ToolInstallUnsupported}
	}
	i.mu.Lock()
	defer i.mu.Unlock()

	ref := discovery.ToolRef{PackID: request.PackID, ToolID: request.ToolID}
	before, exists := i.snapshot.Find(ref)
	if !exists {
		return server.ToolRefreshResult{}, &server.ToolInstallError{Code: server.ToolInstallUnsupported}
	}
	if before.Status != discovery.StatusMissing {
		return server.ToolRefreshResult{
			Status: string(before.Status), Ready: before.Healthy(),
			Message: "The existing tool selection is unchanged. Relaunch CLIHarbor to change an approved installation or configured override.",
		}, nil
	}
	loaded, packFound := i.registry.FindPack(ref.PackID)
	tool, toolFound := i.registry.FindTool(ref.PackID, ref.ToolID)
	if !packFound || !toolFound {
		return server.ToolRefreshResult{}, &server.ToolInstallError{Code: server.ToolInstallUnsupported}
	}
	// Keep the registry trusted and scoped to one declared executable. Search
	// current process PATH and the same user directories as startup.
	loaded.Pack.Runtime.Tools = map[string]packs.Tool{ref.ToolID: tool}
	loaded.Pack.Commands = map[string]packs.Command{}
	scoped, err := packs.NewRegistry([]packs.LoadedPack{loaded})
	if err != nil {
		return server.ToolRefreshResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
	}
	resolver := discovery.NewResolver(discovery.Config{FallbackDirs: discovery.DefaultUserSearchDirectories("")})
	found, err := resolver.Discover(ctx, scoped, nil)
	if ctx.Err() != nil {
		return server.ToolRefreshResult{}, ctx.Err()
	}
	if err != nil {
		return server.ToolRefreshResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
	}
	candidate, exists := found.Find(ref)
	if !exists {
		return server.ToolRefreshResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
	}
	if !candidate.Healthy() {
		return server.ToolRefreshResult{
			Status: string(candidate.Status), Ready: false,
			Message: "Tool verification did not succeed. Check the approved installation or local application-control restrictions; no tasks were enabled.",
		}, nil
	}
	states := i.snapshot.Tools()
	for index := range states {
		if states[index].PackID == ref.PackID && states[index].ToolID == ref.ToolID {
			states[index] = candidate
			break
		}
	}
	next := discovery.NewSnapshot(states)
	if err := i.activate(next, candidate); err != nil {
		return server.ToolRefreshResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
	}
	i.snapshot = next
	return server.ToolRefreshResult{
		Status: string(discovery.StatusReady), Ready: true,
		Message: "CLI verified and ready. Its approved tasks are now available.",
	}, nil
}
