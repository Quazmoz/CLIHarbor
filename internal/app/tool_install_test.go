package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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
	err         error
	installRoot string
}

func (f *fakeManagedProvisioner) EnsureAt(_ context.Context, ref discovery.ToolRef, tool packs.Tool, installRoot string) (string, bool, error) {
	f.ref = ref
	f.tool = tool
	f.installRoot = installRoot
	return f.path, f.installed, f.err
}

func TestManagedToolInstallerUsesOnlyRegistryDeclaredInstallContract(t *testing.T) {
	tool := packs.Tool{Install: &packs.ToolInstall{Version: "1.2.3", Artifacts: map[string]packs.InstallArtifact{}}}
	registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: packs.Pack{
		APIVersion: packs.SupportedAPIVersion,
		Kind:       packs.PackKind,
		Metadata:   packs.Metadata{ID: "fixture", Name: "Fixture", Version: "1.0.0"},
		Runtime:    packs.Runtime{Platforms: []string{"windows"}, Tools: map[string]packs.Tool{"fixture": tool}},
		Commands:   map[string]packs.Command{},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	provisioner := &fakeManagedProvisioner{path: "managed-fixture", installed: true}
	installer := newManagedToolInstaller(registry, provisioner, nil)
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
		Kind:       packs.PackKind,
		Metadata:   packs.Metadata{ID: "fixture", Name: "Fixture", Version: "1.0.0"},
		Runtime:    packs.Runtime{Platforms: []string{"windows"}, Tools: map[string]packs.Tool{"fixture": {}}},
		Commands:   map[string]packs.Command{},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	installer := newManagedToolInstaller(registry, &fakeManagedProvisioner{}, nil)
	_, err = installer.InstallTool(context.Background(), server.ToolInstallRequest{PackID: "fixture", ToolID: "fixture"})
	var installErr *server.ToolInstallError
	if !errors.As(err, &installErr) || installErr.Code != server.ToolInstallInvalidLocation {
		t.Fatalf("error = %v", err)
	}
}


func TestManagedToolInstallerAcceptsAndPersistsCustomRootUnderUserHome(t *testing.T) {
	home := t.TempDir()
	store := newManagedInstallLocationStoreAt(filepath.Join(t.TempDir(), "locations.json"), home)
	tool := packs.Tool{Install: &packs.ToolInstall{Version: "1.2.3", Artifacts: map[string]packs.InstallArtifact{}}}
	registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: packs.Pack{
		APIVersion: packs.SupportedAPIVersion,
		Kind:       packs.PackKind,
		Metadata:   packs.Metadata{ID: "fixture", Name: "Fixture", Version: "1.0.0"},
		Runtime:    packs.Runtime{Platforms: []string{"windows"}, Tools: map[string]packs.Tool{"fixture": tool}},
		Commands:   map[string]packs.Command{},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	customRoot := filepath.Join(home, "tools")
	provisioner := &fakeManagedProvisioner{path: filepath.Join(customRoot, "managed-fixture"), installed: true}
	installer := newManagedToolInstaller(registry, provisioner, store)
	_, err = installer.InstallTool(context.Background(), server.ToolInstallRequest{
		PackID: "fixture", ToolID: "fixture", InstallRoot: customRoot,
	})
	if err != nil {
		t.Fatalf("InstallTool: %v", err)
	}
	if provisioner.installRoot != customRoot {
		t.Fatalf("install root = %q, want %q", provisioner.installRoot, customRoot)
	}
	loaded := store.Load()
	if loaded[discovery.ToolRef{PackID: "fixture", ToolID: "fixture"}] != customRoot {
		t.Fatalf("persisted locations = %#v", loaded)
	}
}

func TestManagedToolInstallerRejectsCustomRootOutsideUserHome(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	store := newManagedInstallLocationStoreAt(filepath.Join(t.TempDir(), "locations.json"), home)
	tool := packs.Tool{Install: &packs.ToolInstall{Version: "1.2.3", Artifacts: map[string]packs.InstallArtifact{}}}
	registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: packs.Pack{
		APIVersion: packs.SupportedAPIVersion,
		Kind:       packs.PackKind,
		Metadata:   packs.Metadata{ID: "fixture", Name: "Fixture", Version: "1.0.0"},
		Runtime:    packs.Runtime{Platforms: []string{"windows"}, Tools: map[string]packs.Tool{"fixture": tool}},
		Commands:   map[string]packs.Command{},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	provisioner := &fakeManagedProvisioner{path: "should-not-run"}
	installer := newManagedToolInstaller(registry, provisioner, store)
	_, err = installer.InstallTool(context.Background(), server.ToolInstallRequest{
		PackID: "fixture", ToolID: "fixture", InstallRoot: filepath.Dir(home),
	})
	var installErr *server.ToolInstallError
	if !errors.As(err, &installErr) || installErr.Code != server.ToolInstallUnsupported {
		t.Fatalf("error = %v", err)
	}
	if provisioner.ref != (discovery.ToolRef{}) {
		t.Fatalf("provisioner unexpectedly invoked: %#v", provisioner.ref)
	}
}
