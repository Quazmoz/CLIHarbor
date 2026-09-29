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
	mu          sync.Mutex
}

func newManagedToolInstaller(registry *packs.Registry, provisioner toolbootstrap.ManagedProvisioner) *managedToolInstaller {
	if provisioner == nil {
		provisioner = toolbootstrap.NewPortableProvisioner()
	}
	return &managedToolInstaller{registry: registry, provisioner: provisioner}
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

	path, installed, err := i.provisioner.Ensure(ctx, ref, tool)
	if err != nil {
		if ctx.Err() != nil {
			return server.ToolInstallResult{}, ctx.Err()
		}
		return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnavailable}
	}
	if path == "" {
		return server.ToolInstallResult{}, &server.ToolInstallError{Code: server.ToolInstallUnsupported}
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
