package app

import (
	"context"
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

func TestPrepareRuntimeExplicitPackSelectionSuppressesDefaultPack(t *testing.T) {
	t.Parallel()

	state, err := prepareRuntime(context.Background(), Options{})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	if len(state.Registry.Packs()) != 0 {
		t.Fatalf("zero-value app options unexpectedly loaded defaults: %d packs", len(state.Registry.Packs()))
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
