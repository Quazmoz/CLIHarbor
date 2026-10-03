package discovery

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

type fakeProbeRunner struct {
	output string
	err    error
	calls  int
	path   string
	probe  packs.VersionProbe
}

func (f *fakeProbeRunner) Run(_ context.Context, path string, probe packs.VersionProbe) (string, error) {
	f.calls++
	f.path = path
	f.probe = probe
	return f.output, f.err
}

type mutatingProbeRunner struct {
	output string
}

func (m mutatingProbeRunner) Run(_ context.Context, path string, _ packs.VersionProbe) (string, error) {
	if err := os.WriteFile(path, []byte("replacement executable bytes"), 0o755); err != nil {
		return "", err
	}
	return m.output, nil
}

func TestDiscoverSingleCandidateAndCompatibleVersion(t *testing.T) {
	dir := t.TempDir()
	candidate := createExecutable(t, dir, platformExecutableName("fixture"))
	probe := &fakeProbeRunner{output: "fixture version v1.2.3\n"}
	resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: dir, ProbeRunner: probe})

	snapshot, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{
		ExecutableNames:   []string{"fixture"},
		VersionProbe:      &packs.VersionProbe{Args: []string{"--version"}, Parser: packs.VersionParserSemverText},
		VersionConstraint: ">=1.0.0 <2.0.0",
	}), nil)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	state, ok := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if !ok {
		t.Fatal("tool state missing")
	}
	if state.Status != StatusReady || state.Version != "1.2.3" || !state.ExecutableIdentity.Valid() {
		t.Fatalf("state = %#v, want ready 1.2.3 with executable identity", state)
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		t.Fatal(err)
	}
	resolved, _ = filepath.Abs(resolved)
	if state.Path != filepath.Clean(resolved) {
		t.Fatalf("path = %q, want %q", state.Path, resolved)
	}
	if probe.calls != 1 || probe.path != state.Path {
		t.Fatalf("probe calls/path = %d %q", probe.calls, probe.path)
	}
}

func TestDiscoverAmbiguousPATHFailsClosed(t *testing.T) {
	first := t.TempDir()
	second := t.TempDir()
	createExecutable(t, first, platformExecutableName("fixture"))
	createExecutable(t, second, platformExecutableName("fixture"))
	probe := &fakeProbeRunner{output: "1.0.0"}
	resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: strings.Join([]string{first, second}, string(os.PathListSeparator)), ProbeRunner: probe})

	snapshot, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{ExecutableNames: []string{"fixture"}}), nil)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	state, _ := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if state.Status != StatusAmbiguous || len(state.Candidates) != 2 {
		t.Fatalf("state = %#v, want ambiguous with two candidates", state)
	}
	if probe.calls != 0 {
		t.Fatalf("probe called %d times for ambiguous tool", probe.calls)
	}
}

func TestDiscoverIgnoresRelativePATHEntries(t *testing.T) {
	resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: ".", ProbeRunner: &fakeProbeRunner{}})
	snapshot, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{ExecutableNames: []string{"fixture"}}), nil)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	state, _ := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if state.Status != StatusMissing {
		t.Fatalf("status = %s, want missing", state.Status)
	}
}

func TestExplicitOverrideIsAuthoritative(t *testing.T) {
	dir := t.TempDir()
	createExecutable(t, dir, platformExecutableName("fixture"))
	resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: dir, ProbeRunner: &fakeProbeRunner{}})
	ref := ToolRef{PackID: "demo", ToolID: "fixture"}

	snapshot, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{ExecutableNames: []string{"fixture"}}), map[ToolRef]string{ref: "relative/fixture"})
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	state, _ := snapshot.Find(ref)
	if state.Status != StatusInvalidOverride {
		t.Fatalf("status = %s, want invalid override", state.Status)
	}
}

func TestExplicitOverrideResolvesAmbiguity(t *testing.T) {
	first := t.TempDir()
	second := t.TempDir()
	chosen := createExecutable(t, first, platformExecutableName("fixture"))
	createExecutable(t, second, platformExecutableName("fixture"))
	resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: strings.Join([]string{first, second}, string(os.PathListSeparator)), ProbeRunner: &fakeProbeRunner{}})
	ref := ToolRef{PackID: "demo", ToolID: "fixture"}

	snapshot, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{ExecutableNames: []string{"fixture"}}), map[ToolRef]string{ref: chosen})
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	state, _ := snapshot.Find(ref)
	if state.Status != StatusReady || len(state.Candidates) != 1 {
		t.Fatalf("state = %#v, want one ready override", state)
	}
}

func TestDiscoverRejectsUnknownOverride(t *testing.T) {
	resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: t.TempDir(), ProbeRunner: &fakeProbeRunner{}})
	_, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{ExecutableNames: []string{"fixture"}}), map[ToolRef]string{{PackID: "other", ToolID: "fixture"}: "/tmp/nope"})
	if err == nil || !strings.Contains(err.Error(), "unknown tool") {
		t.Fatalf("error = %v, want unknown tool error", err)
	}
}

func TestDiscoverMarksIncompatibleVersion(t *testing.T) {
	dir := t.TempDir()
	createExecutable(t, dir, platformExecutableName("fixture"))
	resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: dir, ProbeRunner: &fakeProbeRunner{output: "fixture 2.4.0"}})
	snapshot, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{
		ExecutableNames:   []string{"fixture"},
		VersionProbe:      &packs.VersionProbe{Parser: packs.VersionParserSemverText},
		VersionConstraint: "<2.0.0",
	}), nil)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	state, _ := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if state.Status != StatusIncompatible || state.Version != "2.4.0" {
		t.Fatalf("state = %#v, want incompatible 2.4.0", state)
	}
}

func TestDiscoverAcceptsVendorReleaseCommitSuffixWithinConstraint(t *testing.T) {
	dir := t.TempDir()
	createExecutable(t, dir, platformExecutableName("fixture"))
	resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: dir, ProbeRunner: &fakeProbeRunner{
		output: "Idira™ Secrets Manager CLI version 9.3.1-7207d6a\n",
	}})
	snapshot, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{
		ExecutableNames:   []string{"fixture"},
		VersionProbe:      &packs.VersionProbe{Parser: packs.VersionParserSemverText},
		VersionConstraint: ">=9.3.1-0 <10.0.0-0",
	}), nil)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	state, _ := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if state.Status != StatusReady || state.Version != "9.3.1-7207d6a" {
		t.Fatalf("state = %#v, want ready official-release style version", state)
	}
}

func TestDiscoverFailsClosedOnAmbiguousVersionOutput(t *testing.T) {
	dir := t.TempDir()
	createExecutable(t, dir, platformExecutableName("fixture"))
	resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: dir, ProbeRunner: &fakeProbeRunner{output: "client 1.2.3 runtime 4.5.6"}})
	snapshot, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{
		ExecutableNames: []string{"fixture"},
		VersionProbe:    &packs.VersionProbe{Parser: packs.VersionParserSemverText},
	}), nil)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	state, _ := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if state.Status != StatusProbeFailed || !strings.Contains(state.Message, "ambiguous") {
		t.Fatalf("state = %#v, want ambiguous probe failure", state)
	}
}

func TestDiscoverVersionPrefixSelectsLabelledToken(t *testing.T) {
	output := "Client Version: v1.36.1\nKustomize Version: v5.8.1\n"
	for _, tc := range []struct {
		prefix, output, want string
	}{
		{"Client Version:", output, "1.36.1"},
		{"aws-cli/", "aws-cli/2.15.0 Python/3.11.6 Darwin/23.0.0", "2.15.0"},
		{"Client Version:", "Client Version: v1.2.3\nClient Version: v1.2.4", ""}, // still fails closed
		{"Server Version:", output, ""},
	} {
		dir := t.TempDir()
		createExecutable(t, dir, platformExecutableName("fixture"))
		resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: dir, ProbeRunner: &fakeProbeRunner{output: tc.output}})
		snapshot, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{
			ExecutableNames: []string{"fixture"},
			VersionProbe:    &packs.VersionProbe{Parser: packs.VersionParserSemverText, Prefix: tc.prefix},
		}), nil)
		if err != nil {
			t.Fatalf("Discover() error = %v", err)
		}
		state, _ := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
		if tc.want == "" {
			if state.Status != StatusProbeFailed {
				t.Fatalf("prefix %q output %q: state = %#v, want probe failure", tc.prefix, tc.output, state)
			}
			continue
		}
		if state.Version != tc.want {
			t.Fatalf("prefix %q: version = %q (state %#v), want %q", tc.prefix, state.Version, state, tc.want)
		}
	}
}

func TestDiscoverFailsClosedWhenExecutableChangesDuringVersionProbe(t *testing.T) {
	dir := t.TempDir()
	createExecutable(t, dir, platformExecutableName("fixture"))
	resolver := NewResolver(Config{
		GOOS:        runtime.GOOS,
		PathValue:   dir,
		ProbeRunner: mutatingProbeRunner{output: "fixture 1.2.3"},
	})
	snapshot, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{
		ExecutableNames: []string{"fixture"},
		VersionProbe:    &packs.VersionProbe{Parser: packs.VersionParserSemverText},
	}), nil)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	state, _ := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if state.Status != StatusIdentityFailed || !strings.Contains(state.Message, "changed during version probe") {
		t.Fatalf("state = %#v, want identity failure after probe mutation", state)
	}
	if state.Version != "" {
		t.Fatalf("version = %q, want no accepted version after executable mutation", state.Version)
	}
}

func TestDiscoverProbeFailureDoesNotExposeOutput(t *testing.T) {
	dir := t.TempDir()
	createExecutable(t, dir, platformExecutableName("fixture"))
	resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: dir, ProbeRunner: &fakeProbeRunner{output: "SECRET_TOKEN", err: errors.New("boom")}})
	snapshot, err := resolver.Discover(context.Background(), testRegistry(t, packs.Tool{
		ExecutableNames: []string{"fixture"},
		VersionProbe:    &packs.VersionProbe{Parser: packs.VersionParserSemverText},
	}), nil)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	state, _ := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if state.Status != StatusProbeFailed || strings.Contains(state.Message, "SECRET_TOKEN") {
		t.Fatalf("state = %#v, want redacted probe failure", state)
	}
}

func TestDiscoverUnsupportedPlatformDoesNotProbe(t *testing.T) {
	unsupported := "windows"
	if runtime.GOOS == "windows" {
		unsupported = "linux"
	}
	probe := &fakeProbeRunner{output: "1.2.3"}
	resolver := NewResolver(Config{GOOS: runtime.GOOS, PathValue: t.TempDir(), ProbeRunner: probe})
	registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: packs.Pack{
		Metadata: packs.Metadata{ID: "demo", Version: "1.0.0"},
		Runtime:  packs.Runtime{Platforms: []string{unsupported}, Tools: map[string]packs.Tool{"fixture": {ExecutableNames: []string{"fixture"}}}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := resolver.Discover(context.Background(), registry, nil)
	if err != nil {
		t.Fatal(err)
	}
	state, _ := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if state.Status != StatusUnsupportedPlatform || probe.calls != 0 {
		t.Fatalf("state/probe = %#v/%d", state, probe.calls)
	}
}

func TestSnapshotReturnsDefensiveCopies(t *testing.T) {
	snapshot := NewSnapshot([]ToolState{{PackID: "demo", ToolID: "fixture", Status: StatusAmbiguous, Candidates: []Candidate{{Path: "/one"}}}})
	tools := snapshot.Tools()
	tools[0].Candidates[0].Path = "/mutated"
	state, _ := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if state.Candidates[0].Path != "/one" {
		t.Fatalf("snapshot mutated through accessor: %#v", state)
	}
}

func testRegistry(t *testing.T, tool packs.Tool) *packs.Registry {
	t.Helper()
	registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: packs.Pack{
		Metadata: packs.Metadata{ID: "demo", Version: "1.0.0"},
		Runtime:  packs.Runtime{Platforms: []string{runtime.GOOS}, Tools: map[string]packs.Tool{"fixture": tool}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func platformExecutableName(base string) string {
	if runtime.GOOS == "windows" {
		return base + ".exe"
	}
	return base
}

func createExecutable(t *testing.T, directory, name string) string {
	t.Helper()
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return absolute
}

func resolvedTestPath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	absolute, err := filepath.Abs(resolved)
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Clean(absolute)
}

func TestDiscoverUsesFallbackDirectoryOnlyWhenPATHMisses(t *testing.T) {
	pathDir := t.TempDir()
	fallbackDir := t.TempDir()
	executable := filepath.Join(fallbackDir, "fallback-cli")
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	if err := os.WriteFile(executable, []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	executable = resolvedTestPath(t, executable)

	registry := testRegistry(t, packs.Tool{ExecutableNames: []string{"fallback-cli"}})
	resolver := NewResolver(Config{
		GOOS:         runtime.GOOS,
		PathValue:    pathDir,
		FallbackDirs: []string{fallbackDir},
	})
	snapshot, err := resolver.Discover(context.Background(), registry, nil)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	state, ok := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if !ok {
		t.Fatal("tool state missing")
	}
	if state.Status != StatusReady || state.Path != executable {
		t.Fatalf("state = %#v, want ready fallback executable %q", state, executable)
	}
}

func TestDiscoverPATHCandidateTakesPriorityOverFallbackDirectory(t *testing.T) {
	pathDir := t.TempDir()
	fallbackDir := t.TempDir()
	pathExecutable := filepath.Join(pathDir, "fallback-cli")
	fallbackExecutable := filepath.Join(fallbackDir, "fallback-cli")
	if runtime.GOOS == "windows" {
		pathExecutable += ".exe"
		fallbackExecutable += ".exe"
	}
	if err := os.WriteFile(pathExecutable, []byte("path"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fallbackExecutable, []byte("fallback"), 0o755); err != nil {
		t.Fatal(err)
	}
	pathExecutable = resolvedTestPath(t, pathExecutable)

	registry := testRegistry(t, packs.Tool{ExecutableNames: []string{"fallback-cli"}})
	resolver := NewResolver(Config{
		GOOS:         runtime.GOOS,
		PathValue:    pathDir,
		FallbackDirs: []string{fallbackDir},
	})
	snapshot, err := resolver.Discover(context.Background(), registry, nil)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	state, _ := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if state.Status != StatusReady || state.Path != pathExecutable {
		t.Fatalf("state = %#v, want PATH executable %q", state, pathExecutable)
	}
	if len(state.Candidates) != 1 {
		t.Fatalf("candidates = %#v, want only PATH tier", state.Candidates)
	}
}

func TestDefaultUserSearchDirectoriesIncludeDefaultGoBin(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	want := filepath.Join(home, "go", "bin")

	for _, goos := range []string{"windows", "linux"} {
		t.Run(goos, func(t *testing.T) {
			directories := defaultUserSearchDirectories(goos, home)
			found := false
			for _, directory := range directories {
				if directory == want {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("default user search directories = %#v, want %q", directories, want)
			}
		})
	}
}

func TestDiscoverUsesDefaultGoBinFallback(t *testing.T) {
	home := t.TempDir()
	goBin := filepath.Join(home, "go", "bin")
	if err := os.MkdirAll(goBin, 0o755); err != nil {
		t.Fatal(err)
	}
	executable := createExecutable(t, goBin, platformExecutableName("fixture"))
	executable = resolvedTestPath(t, executable)

	resolver := NewResolver(Config{
		GOOS:         runtime.GOOS,
		PathValue:    t.TempDir(),
		FallbackDirs: defaultUserSearchDirectories(runtime.GOOS, home),
		ProbeRunner:  &fakeProbeRunner{},
	})
	snapshot, err := resolver.Discover(
		context.Background(),
		testRegistry(t, packs.Tool{ExecutableNames: []string{"fixture"}}),
		nil,
	)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	state, ok := snapshot.Find(ToolRef{PackID: "demo", ToolID: "fixture"})
	if !ok {
		t.Fatal("tool state missing")
	}
	if state.Status != StatusReady || state.Path != executable {
		t.Fatalf("state = %#v, want ready Go-bin fallback executable %q", state, executable)
	}
}
