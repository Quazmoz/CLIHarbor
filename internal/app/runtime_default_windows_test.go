//go:build windows

package app

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

type testProvisionerFunc func(context.Context, discovery.ToolRef) (string, bool, error)

func (f testProvisionerFunc) Ensure(ctx context.Context, ref discovery.ToolRef) (string, bool, error) {
	return f(ctx, ref)
}

func TestPrepareRuntimePropagatesAutoProvisionCancellation(t *testing.T) {
	t.Setenv("PATH", t.TempDir())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls int
	provisioner := testProvisionerFunc(func(provisionCtx context.Context, ref discovery.ToolRef) (string, bool, error) {
		calls++
		if ref.PackID != "cyberark-conjur-v9" || ref.ToolID != "conjur" {
			t.Fatalf("unexpected provision ref: %#v", ref)
		}
		cancel()
		<-provisionCtx.Done()
		return "", false, provisionCtx.Err()
	})

	var out bytes.Buffer
	_, err := prepareRuntime(ctx, Options{
		Out:                &out,
		LoadDefaultPacks:   true,
		AutoProvisionTools: true,
		ToolProvisioner:    provisioner,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("prepareRuntime() error = %v, want context.Canceled", err)
	}
	if calls != 1 {
		t.Fatalf("provisioner calls = %d, want 1", calls)
	}
}

func TestPrepareRuntimeKeepsOrdinaryProvisionFailureFailClosed(t *testing.T) {
	t.Setenv("PATH", t.TempDir())

	provisioner := testProvisionerFunc(func(_ context.Context, ref discovery.ToolRef) (string, bool, error) {
		if ref.PackID != "cyberark-conjur-v9" || ref.ToolID != "conjur" {
			t.Fatalf("unexpected provision ref: %#v", ref)
		}
		return "", false, errors.New("sensitive network failure details")
	})

	var out bytes.Buffer
	state, err := prepareRuntime(context.Background(), Options{
		Out:                &out,
		LoadDefaultPacks:   true,
		AutoProvisionTools: true,
		ToolProvisioner:    provisioner,
	})
	if err != nil {
		t.Fatalf("prepareRuntime() error = %v", err)
	}
	conjur, ok := state.Discovery.Find(discovery.ToolRef{PackID: "cyberark-conjur-v9", ToolID: "conjur"})
	if !ok || conjur.Status != discovery.StatusMissing {
		t.Fatalf("Conjur state = %#v, want missing", conjur)
	}
	if len(state.SetupMessages) != 1 || strings.Contains(state.SetupMessages[0], "sensitive network failure details") {
		t.Fatalf("setup messages leaked or omitted sanitized failure guidance: %#v", state.SetupMessages)
	}
}

func TestPrepareRuntimeDoesNotClaimManagedConjurReadyWhenProbeFails(t *testing.T) {
	t.Setenv("PATH", t.TempDir())

	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "conjur.exe")
	if err := os.WriteFile(target, payload, 0o700); err != nil {
		t.Fatal(err)
	}

	provisioner := testProvisionerFunc(func(_ context.Context, ref discovery.ToolRef) (string, bool, error) {
		if ref.PackID != "cyberark-conjur-v9" || ref.ToolID != "conjur" {
			t.Fatalf("unexpected provision ref: %#v", ref)
		}
		return target, true, nil
	})

	var out bytes.Buffer
	state, err := prepareRuntime(context.Background(), Options{
		Out:                &out,
		LoadDefaultPacks:   true,
		AutoProvisionTools: true,
		ToolProvisioner:    provisioner,
	})
	if err != nil {
		t.Fatalf("prepareRuntime() error = %v", err)
	}
	conjur, ok := state.Discovery.Find(discovery.ToolRef{PackID: "cyberark-conjur-v9", ToolID: "conjur"})
	if !ok || conjur.Status != discovery.StatusProbeFailed {
		t.Fatalf("Conjur state = %#v, want probe-failed", conjur)
	}
	joined := strings.Join(state.SetupMessages, "\n")
	if !strings.Contains(joined, "byte-verified but did not pass local readiness qualification (probe-failed)") {
		t.Fatalf("setup messages did not explain readiness failure: %#v", state.SetupMessages)
	}
	if strings.Contains(joined, "Installed, byte-verified, and qualified") {
		t.Fatalf("setup messages incorrectly claimed readiness: %#v", state.SetupMessages)
	}
}
