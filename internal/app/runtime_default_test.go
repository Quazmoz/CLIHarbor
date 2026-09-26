package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

func TestPrepareRuntimeLoadsEmbeddedConjurPackWhenDefaultsEnabled(t *testing.T) {
	t.Parallel()

	state, err := prepareRuntime(context.Background(), Options{LoadDefaultPacks: true})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	loaded, ok := state.Registry.FindPack("cyberark-conjur-v9")
	if !ok {
		t.Fatal("embedded Conjur pack was not loaded")
	}
	if loaded.Pack.Metadata.Name == "" {
		t.Fatal("embedded Conjur pack metadata was empty")
	}
	if len(state.Registry.Commands("cyberark-conjur-v9")) == 0 {
		t.Fatal("embedded Conjur pack exposed no commands")
	}
}

func TestPrepareRuntimeCombinesDefaultAndExplicitPacks(t *testing.T) {
	t.Parallel()

	packPath := filepath.Join(t.TempDir(), "other.yaml")
	data := []byte(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: other-cli
  name: Other CLI
  version: 0.1.0
runtime:
  platforms: [windows, linux, darwin]
  tools:
    other:
      executableNames: [definitely-not-a-real-cli-binary]
commands: {}
`)
	if err := os.WriteFile(packPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	state, err := prepareRuntime(context.Background(), Options{
		LoadDefaultPacks: true,
		PackFiles:        []string{packPath},
	})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	if _, ok := state.Registry.FindPack("cyberark-conjur-v9"); !ok {
		t.Fatal("embedded Conjur pack was not retained")
	}
	if _, ok := state.Registry.FindPack("other-cli"); !ok {
		t.Fatal("explicit non-Conjur pack was not added")
	}
	if got := len(state.Registry.Packs()); got != 2 {
		t.Fatalf("configured packs = %d, want 2", got)
	}
}

func TestPrepareRuntimeCombinesPackDirectoryAndPackFiles(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	directory := filepath.Join(root, "packs")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	pack := func(id, tool, executable string) []byte {
		return []byte("apiVersion: cliharbor.dev/v1\nkind: CliPack\nmetadata:\n  id: " + id +
			"\n  name: " + id + "\n  version: 0.1.0\nruntime:\n  platforms: [windows, linux, darwin]\n  tools:\n    " +
			tool + ":\n      executableNames: [" + executable + "]\ncommands: {}\n")
	}
	if err := os.WriteFile(filepath.Join(directory, "alpha.yaml"), pack("alpha-cli", "alpha", "alpha-cli"), 0o600); err != nil {
		t.Fatal(err)
	}
	beta := filepath.Join(root, "beta.yaml")
	if err := os.WriteFile(beta, pack("beta-cli", "beta", "beta-cli"), 0o600); err != nil {
		t.Fatal(err)
	}

	state, err := prepareRuntime(context.Background(), Options{
		PackDirectory: directory,
		PackFiles:     []string{beta},
	})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	if got := len(state.Registry.Packs()); got != 2 {
		t.Fatalf("configured packs = %d, want 2", got)
	}
}

func TestPrepareRuntimeZeroValueOptionsDoNotLoadDefaults(t *testing.T) {
	t.Parallel()

	state, err := prepareRuntime(context.Background(), Options{})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	if len(state.Registry.Packs()) != 0 {
		t.Fatalf("zero-value app options unexpectedly loaded defaults: %d packs", len(state.Registry.Packs()))
	}
}

type recordingProvisioner struct {
	refs []discovery.ToolRef
}

func (p *recordingProvisioner) Ensure(_ context.Context, ref discovery.ToolRef) (string, bool, error) {
	p.refs = append(p.refs, ref)
	return "", false, nil
}

func TestPrepareRuntimeDoesNotProvisionCustomTools(t *testing.T) {
	packPath := filepath.Join(t.TempDir(), "other.yaml")
	data := []byte(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: other-cli
  name: Other CLI
  version: 0.1.0
runtime:
  platforms: [windows, linux, darwin]
  tools:
    other:
      executableNames: [definitely-not-a-real-cli-binary]
commands: {}
`)
	if err := os.WriteFile(packPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	provisioner := &recordingProvisioner{}
	_, err := prepareRuntime(context.Background(), Options{
		LoadDefaultPacks:   true,
		AutoProvisionTools: true,
		PackFiles:          []string{packPath},
		ToolProvisioner:    provisioner,
	})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	for _, ref := range provisioner.refs {
		if ref.PackID == "other-cli" {
			t.Fatalf("custom tool unexpectedly reached automatic provisioner: %s", ref.String())
		}
	}
}

func TestPrepareRuntimeRejectsDuplicatePackIDAcrossSources(t *testing.T) {
	packPath := filepath.Join(t.TempDir(), "duplicate.yaml")
	data := []byte(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: cyberark-conjur-v9
  name: Conflicting Pack
  version: 0.1.0
runtime:
  platforms: [windows, linux, darwin]
  tools:
    other:
      executableNames: [other-cli]
commands: {}
`)
	if err := os.WriteFile(packPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := prepareRuntime(context.Background(), Options{
		LoadDefaultPacks: true,
		PackFiles:        []string{packPath},
	}); err == nil {
		t.Fatal("duplicate custom/default pack id unexpectedly succeeded")
	}
}

func TestShouldAutoProvisionOnlyMissingUnpinnedTool(t *testing.T) {
	t.Parallel()

	base := discovery.ToolState{PackID: "cyberark-conjur-v9", ToolID: "conjur"}
	for _, status := range []discovery.Status{
		discovery.StatusReady,
		discovery.StatusAmbiguous,
		discovery.StatusIncompatible,
		discovery.StatusProbeFailed,
		discovery.StatusInvalidOverride,
		discovery.StatusIdentityFailed,
		discovery.StatusUnsupportedPlatform,
	} {
		state := base
		state.Status = status
		if shouldAutoProvision(state, nil) {
			t.Fatalf("status %q unexpectedly eligible for automatic provisioning", status)
		}
	}

	missing := base
	missing.Status = discovery.StatusMissing
	if !shouldAutoProvision(missing, nil) {
		t.Fatal("missing unpinned tool was not eligible for automatic provisioning")
	}

	ref := discovery.ToolRef{PackID: missing.PackID, ToolID: missing.ToolID}
	if shouldAutoProvision(missing, map[discovery.ToolRef]string{ref: `C:\approved\conjur.exe`}) {
		t.Fatal("explicitly overridden missing tool unexpectedly eligible for automatic provisioning")
	}
}
