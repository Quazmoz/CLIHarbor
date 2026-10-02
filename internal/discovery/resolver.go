package discovery

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	semver "github.com/Masterminds/semver/v3"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

type Config struct {
	GOOS         string
	PathValue    string
	FallbackDirs []string
	ProbeRunner  ProbeRunner
}

type Resolver struct {
	goos         string
	pathValue    string
	fallbackDirs []string
	probeRunner  ProbeRunner
}

func NewResolver(config Config) *Resolver {
	if config.GOOS == "" {
		config.GOOS = runtime.GOOS
	}
	if config.PathValue == "" {
		config.PathValue = os.Getenv("PATH")
	}
	if config.ProbeRunner == nil {
		config.ProbeRunner = ExecProbeRunner{}
	}
	return &Resolver{
		goos:         config.GOOS,
		pathValue:    config.PathValue,
		fallbackDirs: append([]string(nil), config.FallbackDirs...),
		probeRunner:  config.ProbeRunner,
	}
}

func (r *Resolver) Discover(ctx context.Context, registry *packs.Registry, overrides map[ToolRef]string) (Snapshot, error) {
	if r == nil {
		r = NewResolver(Config{})
	}
	if registry == nil {
		return Snapshot{}, fmt.Errorf("pack registry is required")
	}

	known := make(map[ToolRef]struct{})
	states := make([]ToolState, 0)
	for _, loaded := range registry.Packs() {
		pack := loaded.Pack
		platformSupported := containsString(pack.Runtime.Platforms, r.goos)
		for _, named := range registry.Tools(pack.Metadata.ID) {
			ref := ToolRef{PackID: pack.Metadata.ID, ToolID: named.ID}
			known[ref] = struct{}{}
			base := ToolState{
				PackID:            pack.Metadata.ID,
				PackVersion:       pack.Metadata.Version,
				ToolID:            named.ID,
				VersionConstraint: named.Tool.VersionConstraint,
			}
			if !platformSupported {
				base.Status = StatusUnsupportedPlatform
				base.Message = "pack does not support this operating system"
				states = append(states, base)
				continue
			}

			state, err := r.resolveTool(ctx, base, named.Tool, overrides[ref])
			if err != nil {
				return Snapshot{}, fmt.Errorf("discover %s: %w", ref.String(), err)
			}
			states = append(states, state)
		}
	}
	for ref := range overrides {
		if _, ok := known[ref]; !ok {
			return Snapshot{}, fmt.Errorf("tool path override references unknown tool %s", ref.String())
		}
	}
	return NewSnapshot(states), nil
}

func (r *Resolver) resolveTool(ctx context.Context, state ToolState, tool packs.Tool, override string) (ToolState, error) {
	var candidates []Candidate
	if override != "" {
		candidate, ok := r.explicitCandidate(override, tool.ExecutableNames)
		if !ok {
			state.Status = StatusInvalidOverride
			state.Message = "configured tool path must be an absolute regular executable matching a declared executable name"
			return state, nil
		}
		candidates = []Candidate{candidate}
	} else {
		candidates = r.pathCandidates(tool.ExecutableNames)
		if len(candidates) == 0 {
			candidates = r.directoryCandidates(tool.ExecutableNames, r.fallbackDirs)
		}
	}
	state.Candidates = candidates

	switch len(candidates) {
	case 0:
		state.Status = StatusMissing
		state.Message = "tool was not found in the configured PATH or approved current-user fallback locations; install it or configure an explicit tool path"
		return state, nil
	case 1:
		state.Path = candidates[0].Path
		state.ExecutableName = candidates[0].ExecutableName
		identity, err := CaptureExecutableIdentity(state.Path)
		if err != nil {
			state.Status = StatusIdentityFailed
			state.Message = "resolved executable identity could not be recorded"
			return state, nil
		}
		state.ExecutableIdentity = identity
	default:
		state.Status = StatusAmbiguous
		state.Message = "multiple matching executables were found; configure an explicit tool path"
		return state, nil
	}

	if tool.VersionProbe == nil {
		state.Status = StatusReady
		return state, nil
	}

	output, err := r.probeRunner.Run(ctx, state.Path, *tool.VersionProbe)
	if err != nil {
		// Shutdown during discovery is not a tool fault; abort instead of
		// reporting probe failures and continuing startup.
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ToolState{}, ctxErr
		}
		state.Status = StatusProbeFailed
		state.Message = err.Error()
		return state, nil
	}
	if !state.ExecutableIdentity.Matches(state.Path) {
		state.Status = StatusIdentityFailed
		state.Message = "resolved executable changed during version probe"
		return state, nil
	}
	version, err := parseVersion(tool.VersionProbe.Parser, output)
	if err != nil {
		state.Status = StatusProbeFailed
		state.Message = err.Error()
		return state, nil
	}
	state.Version = version.String()

	if tool.VersionConstraint != "" {
		constraint, err := semver.NewConstraint(tool.VersionConstraint)
		if err != nil {
			return ToolState{}, fmt.Errorf("validated pack contains invalid version constraint")
		}
		if !constraint.Check(version) {
			state.Status = StatusIncompatible
			state.Message = "detected version does not satisfy the pack constraint"
			return state, nil
		}
	}
	state.Status = StatusReady
	return state, nil
}

func (r *Resolver) explicitCandidate(path string, declared []string) (Candidate, bool) {
	if !filepath.IsAbs(path) {
		return Candidate{}, false
	}
	resolved, ok := r.inspectExecutable(filepath.Clean(path))
	if !ok || !matchesDeclaredExecutable(filepath.Base(resolved), declared, r.goos) {
		return Candidate{}, false
	}
	return Candidate{Path: resolved, ExecutableName: filepath.Base(resolved)}, true
}

func (r *Resolver) pathCandidates(declared []string) []Candidate {
	return r.directoryCandidates(declared, filepath.SplitList(r.pathValue))
}

func (r *Resolver) directoryCandidates(declared []string, directories []string) []Candidate {
	seenDirectories := make(map[string]struct{})
	seenCandidates := make(map[string]struct{})
	var candidates []Candidate
	for _, directory := range directories {
		directory = normalizeDiscoveryDirectory(directory, r.goos)
		if directory == "" {
			continue
		}
		directoryKey := directory
		if r.goos == "windows" {
			directoryKey = strings.ToLower(directoryKey)
		}
		if _, exists := seenDirectories[directoryKey]; exists {
			continue
		}
		seenDirectories[directoryKey] = struct{}{}
		for _, executable := range declared {
			for _, name := range executableVariants(executable, r.goos) {
				requested := filepath.Join(directory, name)
				resolved, ok := r.inspectExecutable(requested)
				if !ok || !matchesDeclaredExecutable(filepath.Base(resolved), declared, r.goos) {
					continue
				}
				key := resolved
				if r.goos == "windows" {
					key = strings.ToLower(key)
				}
				if _, exists := seenCandidates[key]; exists {
					continue
				}
				seenCandidates[key] = struct{}{}
				candidates = append(candidates, Candidate{Path: resolved, ExecutableName: filepath.Base(resolved)})
			}
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Path < candidates[j].Path })
	return candidates
}

func normalizeDiscoveryDirectory(directory, goos string) string {
	if goos == "windows" && len(directory) >= 2 && directory[0] == '"' && directory[len(directory)-1] == '"' {
		directory = directory[1 : len(directory)-1]
	}
	if directory == "" || !filepath.IsAbs(directory) {
		return ""
	}
	return filepath.Clean(directory)
}

func DefaultUserSearchDirectories(goos string) []string {
	if goos == "" {
		goos = runtime.GOOS
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" || !filepath.IsAbs(home) {
		return nil
	}
	return defaultUserSearchDirectories(goos, filepath.Clean(home))
}

func defaultUserSearchDirectories(goos, home string) []string {
	if goos == "windows" {
		return []string{
			filepath.Join(home, "AppData", "Local", "Microsoft", "WinGet", "Links"),
			filepath.Join(home, "scoop", "shims"),
			filepath.Join(home, "go", "bin"),
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, "bin"),
		}
	}
	return []string{
		filepath.Join(home, "go", "bin"),
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, "bin"),
	}
}

func (r *Resolver) inspectExecutable(path string) (string, bool) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	if r.goos != "windows" && info.Mode().Perm()&0o111 == 0 {
		return "", false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", false
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", false
	}
	return filepath.Clean(resolved), true
}

func executableVariants(name, goos string) []string {
	if goos != "windows" || filepath.Ext(name) != "" {
		return []string{name}
	}
	return []string{name, name + ".exe", name + ".com"}
}

func matchesDeclaredExecutable(actual string, declared []string, goos string) bool {
	for _, name := range declared {
		if goos == "windows" {
			if strings.EqualFold(actual, name) {
				return true
			}
			if filepath.Ext(name) == "" && (strings.EqualFold(actual, name+".exe") || strings.EqualFold(actual, name+".com")) {
				return true
			}
			continue
		}
		if actual == name {
			return true
		}
	}
	return false
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
