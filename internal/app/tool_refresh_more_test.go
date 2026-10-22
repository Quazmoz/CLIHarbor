package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

func TestManualToolRefreshSerializesConcurrentRequests(t *testing.T) {
	fixture := executionFixtureConfigForTest(t)
	state, err := prepareRuntime(t.Context(), fixture.options)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(fixture.executable))
	installer := newManagedToolInstaller(state.Registry, missingInstallSnapshot(state.Registry), &fakeManagedProvisioner{}, nil)
	var activated int
	installer.activate = func(_ discovery.Snapshot, candidate discovery.ToolState) error {
		if !candidate.Healthy() {
			t.Fatal("unqualified tool activated")
		}
		activated++
		return nil
	}
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			result, err := installer.RefreshTool(t.Context(), server.ToolInstallRequest{PackID: fixture.ref.PackID, ToolID: fixture.ref.ToolID})
			if err != nil || !result.Ready {
				t.Errorf("concurrent refresh = %#v, %v", result, err)
			}
		}()
	}
	workers.Wait()
	if activated != 1 {
		t.Fatalf("activation count = %d, want 1", activated)
	}
}

func TestManualToolRefreshNeverActivatesAmbiguousCandidates(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows executable copies and reparse points require native acceptance")
	}
	fixture := executionFixtureConfigForTest(t)
	state, err := prepareRuntime(t.Context(), fixture.options)
	if err != nil {
		t.Fatal(err)
	}
	secondDir := t.TempDir()
	second := filepath.Join(secondDir, filepath.Base(fixture.executable))
	bytes, err := os.ReadFile(fixture.executable)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, bytes, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(fixture.executable)+string(os.PathListSeparator)+secondDir)
	installer := newManagedToolInstaller(state.Registry, missingInstallSnapshot(state.Registry), &fakeManagedProvisioner{}, nil)
	installer.activate = func(discovery.Snapshot, discovery.ToolState) error {
		t.Fatal("ambiguous tool activated")
		return nil
	}
	result, err := installer.RefreshTool(t.Context(), server.ToolInstallRequest{PackID: fixture.ref.PackID, ToolID: fixture.ref.ToolID})
	if err != nil || result.Ready || result.Status != string(discovery.StatusAmbiguous) {
		t.Fatalf("ambiguous refresh = %#v, %v", result, err)
	}
}

func TestManualToolRefreshCancellationDoesNotActivate(t *testing.T) {
	fixture := executionFixtureConfigForTest(t)
	state, err := prepareRuntime(t.Context(), fixture.options)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(fixture.executable))
	installer := newManagedToolInstaller(state.Registry, missingInstallSnapshot(state.Registry), &fakeManagedProvisioner{}, nil)
	installer.activate = func(discovery.Snapshot, discovery.ToolState) error {
		t.Fatal("cancelled request activated")
		return nil
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = installer.RefreshTool(ctx, server.ToolInstallRequest{PackID: fixture.ref.PackID, ToolID: fixture.ref.ToolID})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled refresh error = %v", err)
	}
}
