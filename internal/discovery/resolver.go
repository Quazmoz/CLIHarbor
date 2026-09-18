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
	GOOS        string
	PathValue   string
	ProbeRunner ProbeRunner
}

type Resolver struct {
	goos        string
	pathValue   string
	probeRunner ProbeRunner
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
	return &Resolver{goos: config.GOOS, pathValue: config.PathValue, probeRunner: config.ProbeRunner}
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
	}
	state.Candidates = candidates

	switch len(candidates) {
	case 0:
		state.Status = StatusMissing
		state.Message = "tool was not found on absolute PATH entries; install it or configure an explicit tool path"
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
		state.Status = StatusProbeFailed
		state.Message = err.Error()
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
	seen := make(map[string]struct{})
	var candidates []Candidate
	for _, directory := range filepath.SplitList(r.pathValue) {
		if directory == "" || !filepath.IsAbs(directory) {
			continue
		}
		directory = filepath.Clean(directory)
		for _, executable := range declared {
			for _, name := range executableVariants(executable, r.goos) {
				resolved, ok := r.inspectExecutable(filepath.Join(directory, name))
				if !ok || !matchesDeclaredExecutable(filepath.Base(resolved), declared, r.goos) {
					continue
				}
				key := resolved
				if r.goos == "windows" {
					key = strings.ToLower(key)
				}
				if _, exists := seen[key]; exists {
					continue
				}
				seen[key] = struct{}{}
				candidates = append(candidates, Candidate{Path: resolved, ExecutableName: filepath.Base(resolved)})
			}
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Path < candidates[j].Path })
	return candidates
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
