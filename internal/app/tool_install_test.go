package app

import (
	"context"
	"errors"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

type fakeManagedProvisioner struct {
	ref       discovery.ToolRef
	tool      packs.Tool
	path      string
	installed bool
	err       error
}

func (f *fakeManagedProvisioner) Ensure(_ context.Context, ref discovery.ToolRef, tool packs.Tool) (string, bool, error) {
	f.ref = ref
	f.tool = tool
	return f.path, f.installed, f.err
}

func TestManagedToolInstallerUsesOnlyRegistryDeclaredInstallContract(t *testing.T) {
	tool := packs.Tool{Install: &packs.ToolInstall{Version: "1.2.3", Artifacts: map[string]packs.InstallArtifact{}}}
	registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: packs.Pack{
		APIVersion: packs.SupportedAPIVersion,
		Kind: packs.PackKind,
		Metadata: packs.Metadata{ID: "fixture", Name: "Fixture", Version: "1.0.0"},
		Runtime: packs.Runtime{Platforms: []string{"windows"}, Tools: map[string]packs.Tool{"fixture": tool}},
		Commands: map[string]packs.Command{},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	provisioner := &fakeManagedProvisioner{path: "managed-fixture", installed: true}
	installer := newManagedToolInstaller(registry, provisioner)
	result, err := installer.InstallTool(context.Background(), server.ToolInstallRequest{PackID: "fixture", ToolID: "fixture"})
	if err != nil {
		t.Fatalf("InstallTool: %v", err)
	}
	if provisioner.ref != (discovery.ToolRef{PackID: "fixture", ToolID: "fixture"}) {
		t.Fatalf("provisioned ref = %#v", provisioner.ref)
	}
	if provisioner.tool.Install == nil || provisioner.tool.Install.Version != "1.2.3" {
		t.Fatalf("provisioned tool = %#v", provisioner.tool)
	}
	if !result.Installed || !result.RestartRequired || result.Version != "1.2.3" {
		t.Fatalf("result = %#v", result)
	}
}

func TestManagedToolInstallerFailsClosedWithoutInstallContract(t *testing.T) {
	registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: packs.Pack{
		APIVersion: packs.SupportedAPIVersion,
		Kind: packs.PackKind,
		Metadata: packs.Metadata{ID: "fixture", Name: "Fixture", Version: "1.0.0"},
		Runtime: packs.Runtime{Platforms: []string{"windows"}, Tools: map[string]packs.Tool{"fixture": {}}},
		Commands: map[string]packs.Command{},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	installer := newManagedToolInstaller(registry, &fakeManagedProvisioner{})
	_, err = installer.InstallTool(context.Background(), server.ToolInstallRequest{PackID: "fixture", ToolID: "fixture"})
	var installErr *server.ToolInstallError
	if !errors.As(err, &installErr) || installErr.Code != server.ToolInstallUnsupported {
		t.Fatalf("error = %v", err)
	}
}
