package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/diagnostics"
	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/hostinfo"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestDiagnosticBundleAllowlistExcludesSensitiveRuntimeFields(t *testing.T) {
	secret := "DO_NOT_EXPORT_SECRET_9173"
	t.Setenv("CLIHARBOR_TEST_SECRET", secret)

	registry, err := packs.NewRegistry([]packs.LoadedPack{{
		Source: packs.Source{Kind: packs.SourceExplicitLocal, Name: filepath.Join(string(filepath.Separator), "Users", "operator", secret, "pack.yaml")},
		Pack: packs.Pack{
			Metadata: packs.Metadata{ID: "demo", Version: "1.2.3", Name: secret},
			Runtime:  packs.Runtime{Tools: map[string]packs.Tool{"fixture": {}}},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	state := RuntimeState{
		Registry: registry,
		Discovery: discovery.NewSnapshot([]discovery.ToolState{{
			PackID: "demo", PackVersion: "1.2.3", ToolID: "fixture",
			Status: discovery.StatusReady, Version: "2.3.4",
			Path:           filepath.Join(string(filepath.Separator), "Users", "operator", secret, "tool.exe"),
			ExecutableName: secret + ".exe",
			Candidates:     []discovery.Candidate{{Path: secret, ExecutableName: secret}},
			Message:        "stdout token=" + secret,
		}}),
	}
	bundle := buildDiagnosticBundle(
		Options{Version: "test", Commit: "abc123", BuildMode: "test", PackFiles: []string{secret + ".yaml"}},
		state,
		hostinfo.Info{OS: "windows", Version: "10.0.26100", Architecture: "amd64"},
	)
	payload, err := diagnostics.MarshalBundle(bundle)
	if err != nil {
		t.Fatalf("MarshalBundle() error = %v", err)
	}
	text := string(payload)
	for _, forbidden := range []string{
		secret, "Users", "operator", "tool.exe", "stdout", "token=", "pack.yaml",
		`"path":`, `"candidates":`, `"message":`, "environment", "csrf", "session", "argv",
	} {
		if strings.Contains(strings.ToLower(text), strings.ToLower(forbidden)) {
			t.Fatalf("diagnostics payload contains forbidden material %q: %s", forbidden, text)
		}
	}
}

func TestDiagnosticBundleIsStableAcrossIrrelevantEnvironmentChanges(t *testing.T) {
	registry, err := packs.NewRegistry(nil)
	if err != nil {
		t.Fatal(err)
	}
	state := RuntimeState{Registry: registry, Discovery: discovery.NewSnapshot(nil)}
	options := Options{Version: "test", Commit: "abc123", BuildMode: "test"}
	host := hostinfo.Info{OS: "linux", Architecture: "amd64"}

	first, err := diagnostics.MarshalBundle(buildDiagnosticBundle(options, state, host))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Setenv("CLIHARBOR_DIAGNOSTICS_IRRELEVANT", "first-secret"); err != nil {
		t.Fatal(err)
	}
	defer os.Unsetenv("CLIHARBOR_DIAGNOSTICS_IRRELEVANT")
	second, err := diagnostics.MarshalBundle(buildDiagnosticBundle(options, state, host))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatal("irrelevant environment changed deterministic diagnostics payload")
	}
}

func TestDiagnosticBundleSortsPrefixPackIDsByCompositeToolKey(t *testing.T) {
	registry, err := packs.NewRegistry([]packs.LoadedPack{
		{Pack: packs.Pack{Metadata: packs.Metadata{ID: "demo", Version: "1.0.0"}}},
		{Pack: packs.Pack{Metadata: packs.Metadata{ID: "demo-alt", Version: "1.0.0"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	state := RuntimeState{Registry: registry, Discovery: discovery.NewSnapshot([]discovery.ToolState{
		{PackID: "demo", PackVersion: "1.0.0", ToolID: "fixture", Status: discovery.StatusMissing},
		{PackID: "demo-alt", PackVersion: "1.0.0", ToolID: "fixture", Status: discovery.StatusMissing},
	})}
	bundle := buildDiagnosticBundle(Options{}, state, hostinfo.Info{OS: "windows", Architecture: "amd64"})
	if _, err := diagnostics.MarshalBundle(bundle); err != nil {
		t.Fatalf("prefix pack IDs must remain exportable: %v", err)
	}
	if bundle.Tools[0].PackID != "demo-alt" || bundle.Tools[1].PackID != "demo" {
		t.Fatalf("unexpected diagnostic ordering: %+v", bundle.Tools)
	}
}
