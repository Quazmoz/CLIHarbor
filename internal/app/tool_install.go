package app

import (
	"context"
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
	mu          sync.Mutex
}

func newManagedToolInstaller(registry *packs.Registry, provisioner toolbootstrap.ManagedProvisioner, locations *managedInstallLocationStore) *managedToolInstaller {
	if provisioner == nil {
		provisioner = toolbootstrap.NewPortableProvisioner()
	}
	if locations == nil {
		locations, _ = newManagedInstallLocationStore()
	}
	return &managedToolInstaller{registry: registry, provisioner: provisioner, locations: locations}
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
	installRoot := ""
	if request.InstallRoot != "" {
		if i.locations == nil {
			return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnsupported}
		}
		validated, ok := validateManagedInstallRoot(request.InstallRoot, i.locations.homeDir)
		if !ok {
			return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnsupported}
		}
		installRoot = validated
	}

	i.mu.Lock()
	defer i.mu.Unlock()

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
	if installRoot != "" {
		if err := i.locations.Save(ref, installRoot); err != nil {
			return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
		}
	}
	message := "Verified CLI is already installed for the current user. Restart CLIHarbor to activate it."
	if installed {
		message = "Verified CLI installed for the current user. Restart CLIHarbor to activate it."
	}
	return server.ToolInstallResult{
		Installed:       installed,
		Version:         tool.Install.Version,
		RestartRequired: true,
		Message:         message,
	}, nil
}
