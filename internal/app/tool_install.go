package app

import (
	"context"
	"encoding/hex"
	"runtime"
	"strings"
	"sync"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/Quazmoz/CLIHarbor/internal/toolbootstrap"
)

type managedToolInstaller struct {
	registry    *packs.Registry
	provisioner toolbootstrap.ManagedProvisioner
	locations   *managedInstallLocationStore
	snapshot    discovery.Snapshot
	activate    func(discovery.Snapshot, discovery.ToolState) error
	mu          sync.Mutex
}

func newManagedToolInstaller(registry *packs.Registry, snapshot discovery.Snapshot, provisioner toolbootstrap.ManagedProvisioner, locations *managedInstallLocationStore) *managedToolInstaller {
	if provisioner == nil {
		provisioner = toolbootstrap.NewPortableProvisioner()
	}
	if locations == nil {
		locations, _ = newManagedInstallLocationStore()
	}
	return &managedToolInstaller{registry: registry, snapshot: snapshot, provisioner: provisioner, locations: locations}
}

func (i *managedToolInstaller) InstallTool(ctx context.Context, request server.ToolInstallRequest) (server.ToolInstallResult, error) {
	if i == nil || i.registry == nil || i.provisioner == nil {
		return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnsupported}
	}
	tool, ok := i.registry.FindTool(request.PackID, request.ToolID)
	if !ok || tool.Install == nil {
		return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnsupported}
	}
	ref := discovery.ToolRef{PackID: request.PackID, ToolID: request.ToolID}
	i.mu.Lock()
	defer i.mu.Unlock()
	state, exists := i.snapshot.Find(ref)
	if !exists || state.Status != discovery.StatusMissing {
		return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnsupported}
	}
	installRoot := ""
	if request.InstallRoot != "" {
		if i.locations == nil {
			return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnsupported}
		}
		validated, ok := validateManagedInstallRoot(request.InstallRoot, i.locations.homeDir)
		if !ok {
			return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallInvalidLocation}
		}
		installRoot = validated
	}

	path, installed, err := i.provisioner.EnsureAt(ctx, ref, tool, installRoot)
	if err != nil {
		if ctx.Err() != nil {
			return server.ToolInstallResult{}, ctx.Err()
		}
		return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
	}
	if path == "" {
		return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnsupported}
	}
	restartRequired := i.activate == nil
	message := "Verified CLI installed for the current user. Restart CLIHarbor to activate it."
	if i.activate != nil {
		// Qualify only this tool through ordinary discovery; unrelated tools and
		// their existing executable identities stay unchanged.
		loaded, _ := i.registry.FindPack(ref.PackID)
		loaded.Pack.Runtime.Tools = map[string]packs.Tool{ref.ToolID: tool}
		loaded.Pack.Commands = map[string]packs.Command{}
		registry, err := packs.NewRegistry([]packs.LoadedPack{loaded})
		if err != nil {
			return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
		}
		qualified, err := discovery.NewResolver(discovery.Config{}).Discover(ctx, registry, map[discovery.ToolRef]string{ref: path})
		if err != nil {
			return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
		}
		state, ok := qualified.Find(ref)
		if !ok || !state.Healthy() || state.Version != tool.Install.Version {
			return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
		}
		artifact, supported := tool.Install.Artifacts[runtime.GOOS+"-"+runtime.GOARCH]
		expectedSHA := artifact.SHA256
		if artifact.Format == packs.InstallFormatZIP {
			expectedSHA = artifact.ExecutableSHA256
		}
		digest := state.ExecutableIdentity.ContentSHA256()
		if !supported || !strings.EqualFold(hex.EncodeToString(digest[:]), expectedSHA) {
			return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
		}
		states := i.snapshot.Tools()
		for index := range states {
			if states[index].PackID == ref.PackID && states[index].ToolID == ref.ToolID {
				states[index] = state
			}
		}
		next := discovery.NewSnapshot(states)
		// Do not persist a custom location until the discovered executable,
		// version and pinned content have passed independent qualification.
		if installRoot != "" {
			if err := i.locations.Save(ref, installRoot); err != nil {
				return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
			}
		}
		if err := i.activate(next, state); err != nil {
			return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
		}
		i.snapshot = next
		message = "Verified CLI installed and ready. Its approved tasks are now available."
	} else if installRoot != "" {
		// Explicit restart-mode installation has no live activation contract.
		if err := i.locations.Save(ref, installRoot); err != nil {
			return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
		}
	}
	return server.ToolInstallResult{
		Installed:       installed,
		Version:         tool.Install.Version,
		RestartRequired: restartRequired,
		Message:         message,
	}, nil
}
