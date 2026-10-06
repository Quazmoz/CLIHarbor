package app

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

type fakeManagedProvisioner struct {
	ref         discovery.ToolRef
	tool        packs.Tool
	path        string
	installed   bool
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
	installer := newManagedToolInstaller(registry, missingInstallSnapshot(registry), provisioner, nil)
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
	installer := newManagedToolInstaller(registry, missingInstallSnapshot(registry), &fakeManagedProvisioner{}, nil)
	_, err = installer.InstallTool(context.Background(), server.ToolInstallRequest{PackID: "fixture", ToolID: "fixture"})
	var installErr *server.ToolInstallError
	if !errors.As(err, &installErr) || installErr.Code != server.ToolInstallUnsupported {
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
	installer := newManagedToolInstaller(registry, missingInstallSnapshot(registry), provisioner, store)
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
	installer := newManagedToolInstaller(registry, missingInstallSnapshot(registry), provisioner, store)
	_, err = installer.InstallTool(context.Background(), server.ToolInstallRequest{
		PackID: "fixture", ToolID: "fixture", InstallRoot: filepath.Dir(home),
	})
	var installErr *server.ToolInstallError
	if !errors.As(err, &installErr) || installErr.Code != server.ToolInstallInvalidLocation {
		t.Fatalf("error = %v", err)
	}
	if provisioner.ref != (discovery.ToolRef{}) {
		t.Fatalf("provisioner unexpectedly invoked: %#v", provisioner.ref)
	}
}

func missingInstallSnapshot(registry *packs.Registry) discovery.Snapshot {
	states := []discovery.ToolState{}
	for _, loaded := range registry.Packs() {
		for _, tool := range registry.Tools(loaded.Pack.Metadata.ID) {
			states = append(states, discovery.ToolState{PackID: loaded.Pack.Metadata.ID, PackVersion: loaded.Pack.Metadata.Version, ToolID: tool.ID, Status: discovery.StatusMissing, VersionConstraint: tool.Tool.VersionConstraint})
		}
	}
	return discovery.NewSnapshot(states)
}

func TestManagedInstallQualifiesAndPublishesTasksWithoutRestart(t *testing.T) {
	fixture := executionFixtureConfigForTest(t)
	state, err := prepareRuntime(t.Context(), fixture.options)
	if err != nil {
		t.Fatal(err)
	}
	loaded, _ := state.Registry.FindPack(fixture.ref.PackID)
	tool := loaded.Pack.Runtime.Tools[fixture.ref.ToolID]
	identity, err := discovery.CaptureExecutableIdentity(fixture.executable)
	if err != nil {
		t.Fatal(err)
	}
	digest := identity.ContentSHA256()
	tool.Install = &packs.ToolInstall{Version: "1.2.3", Artifacts: map[string]packs.InstallArtifact{
		runtime.GOOS + "-" + runtime.GOARCH: {Format: packs.InstallFormatExecutable, SHA256: hex.EncodeToString(digest[:])},
	}}
	loaded.Pack.Runtime.Tools[fixture.ref.ToolID] = tool
	registry, err := packs.NewRegistry([]packs.LoadedPack{loaded})
	if err != nil {
		t.Fatal(err)
	}
	missing := missingInstallSnapshot(registry)
	catalog := newTaskCatalog(registry, missing)
	manager, err := runs.NewManager(t.Context(), registry, missing, runs.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Shutdown(context.Background()) })
	provisioner := &fakeManagedProvisioner{path: fixture.executable, installed: true}
	installer := newManagedToolInstaller(registry, missing, provisioner, nil)
	installer.activate = func(snapshot discovery.Snapshot, qualified discovery.ToolState) error {
		if err := manager.ActivateTool(qualified); err != nil {
			return err
		}
		catalog.refresh(registry, snapshot)
		return nil
	}
	if len(catalog.ListTasks()) != 0 {
		t.Fatal("missing tool exposed tasks")
	}
	stopReads, readsDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(readsDone)
		for {
			select {
			case <-stopReads:
				return
			default:
				catalog.ListTools()
				catalog.ListTasks()
				_, _ = manager.Preview(runs.Request{PackID: fixture.ref.PackID, CommandID: "wait"})
				runtime.Gosched()
			}
		}
	}()
	defer func() { close(stopReads); <-readsDone }()
	result, err := installer.InstallTool(t.Context(), server.ToolInstallRequest{PackID: fixture.ref.PackID, ToolID: fixture.ref.ToolID})
	if err != nil || result.RestartRequired {
		t.Fatalf("install result = %#v, %v", result, err)
	}
	if len(catalog.ListTasks()) == 0 || catalog.ListTools()[0].Status != "ready" {
		t.Fatal("qualified tool did not populate catalog")
	}
	if _, err := manager.Preview(runs.Request{PackID: fixture.ref.PackID, CommandID: "wait"}); err != nil {
		t.Fatalf("activated task cannot be planned: %v", err)
	}
	_, err = installer.InstallTool(t.Context(), server.ToolInstallRequest{PackID: fixture.ref.PackID, ToolID: fixture.ref.ToolID})
	var installErr *server.ToolInstallError
	if !errors.As(err, &installErr) || installErr.Code != server.ToolInstallUnsupported {
		t.Fatal("ready tool can be reinstalled")
	}
}

func TestManagedInstallDoesNotActivateFailedQualification(t *testing.T) {
	fixture := executionFixtureConfigForTest(t)
	state, err := prepareRuntime(t.Context(), fixture.options)
	if err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"1.9.0", "1.2.3"} {
		t.Run(version, func(t *testing.T) {
			loaded, _ := state.Registry.FindPack(fixture.ref.PackID)
			tool := loaded.Pack.Runtime.Tools[fixture.ref.ToolID]
			tool.Install = &packs.ToolInstall{Version: version, Artifacts: map[string]packs.InstallArtifact{
				runtime.GOOS + "-" + runtime.GOARCH: {Format: packs.InstallFormatExecutable, SHA256: strings.Repeat("0", 64)},
			}}
			loaded.Pack.Runtime.Tools[fixture.ref.ToolID] = tool
			registry, err := packs.NewRegistry([]packs.LoadedPack{loaded})
			if err != nil {
				t.Fatal(err)
			}
			installer := newManagedToolInstaller(registry, missingInstallSnapshot(registry), &fakeManagedProvisioner{path: fixture.executable}, nil)
			installer.activate = func(discovery.Snapshot, discovery.ToolState) error {
				t.Fatal("unexpected activation for wrong pinned version or content")
				return nil
			}
			_, err = installer.InstallTool(t.Context(), server.ToolInstallRequest{PackID: fixture.ref.PackID, ToolID: fixture.ref.ToolID})
			var installErr *server.ToolInstallError
			if !errors.As(err, &installErr) || installErr.Code != server.ToolInstallUnavailable {
				t.Fatalf("qualification error = %v", err)
			}
		})
	}
}

func TestManagedInstallNeverReplacesUnavailableOrExplicitToolState(t *testing.T) {
	for _, status := range []discovery.Status{discovery.StatusReady, discovery.StatusAmbiguous, discovery.StatusIncompatible,
		discovery.StatusProbeFailed, discovery.StatusInvalidOverride, discovery.StatusIdentityFailed, discovery.StatusUnsupportedPlatform} {
		t.Run(string(status), func(t *testing.T) {
			registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: packs.Pack{
				Metadata: packs.Metadata{ID: "fixture", Name: "Fixture", Version: "1.0.0"},
				Runtime:  packs.Runtime{Tools: map[string]packs.Tool{"fixture": {Install: &packs.ToolInstall{Version: "1.2.3"}}}},
			}}})
			if err != nil {
				t.Fatal(err)
			}
			provisioner := &fakeManagedProvisioner{path: "should-not-run"}
			installer := newManagedToolInstaller(registry, discovery.NewSnapshot([]discovery.ToolState{{PackID: "fixture", ToolID: "fixture", Status: status}}), provisioner, nil)
			if _, err := installer.InstallTool(t.Context(), server.ToolInstallRequest{PackID: "fixture", ToolID: "fixture"}); err == nil {
				t.Fatal("installation allowed for non-missing tool")
			}
			if provisioner.ref != (discovery.ToolRef{}) {
				t.Fatal("provisioner invoked for protected tool state")
			}
		})
	}
}
