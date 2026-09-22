package app

import (
	"context"
	"testing"
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
