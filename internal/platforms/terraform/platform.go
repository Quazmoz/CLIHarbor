// Package terraform provides a deliberately read-only local state inventory.
// It is not a Terraform provider, CLI executor, or mutation approval authority.
package terraform

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

const (
	maxProjects   = 16
	maxStates     = 128
	maxStateBytes = 8 << 20
	maxResources  = 5000
)

var (
	identifier    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)
	moduleAddress = regexp.MustCompile(`^module\.[A-Za-z_][A-Za-z0-9_-]*(\[(?:[0-9]+|"(?:[^"\\]|\\.)*")\])?(\.module\.[A-Za-z_][A-Za-z0-9_-]*(\[(?:[0-9]+|"(?:[^"\\]|\\.)*")\])?)*$`)
)

type approvedRoot struct {
	path string
	info os.FileInfo
}
type Platform struct {
	roots []approvedRoot
	mu sync.RWMutex
	tool discovery.ToolState
	formatSlot chan struct{}
}

// Paths can be approved only by the local process operator at startup, never
// by a loopback browser request. Relative, UNC and symlinked roots fail closed.
func New(paths []string) (*Platform, error) {
	if len(paths) > maxProjects {
		return nil, errors.New("too many Terraform project approvals")
	}
	p := &Platform{roots: make([]approvedRoot, 0, len(paths)), formatSlot: make(chan struct{}, 1)}
	seen := map[string]bool{}
	for _, path := range paths {
		if path == "" || !filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
			return nil, errors.New("Terraform projects require absolute local directories")
		}
		if runtime.GOOS == "windows" && strings.HasPrefix(path, "\\\\") {
			return nil, errors.New("UNC Terraform projects are not supported")
		}
		clean := filepath.Clean(path)
		resolved, err := filepath.EvalSymlinks(clean)
		// Windows EvalSymlinks also canonicalizes drive and component case, so a
		// case-only difference is the same directory, not a junction.
		if err != nil || (resolved != clean && !(runtime.GOOS == "windows" && strings.EqualFold(resolved, clean))) {
			return nil, errors.New("Terraform project roots cannot contain symlinks or junctions")
		}
		// Keep the canonical spelling: later redirect checks compare exactly.
		clean = resolved
		info, err := os.Stat(clean)
		if err != nil || !info.IsDir() {
			return nil, errors.New("Terraform project root must be an accessible directory")
		}
		key := clean
		if runtime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if seen[key] {
			return nil, errors.New("duplicate Terraform project root")
		}
		seen[key] = true
		p.roots = append(p.roots, approvedRoot{path: clean, info: info})
	}
	return p, nil
}

func (p *Platform) Descriptor() server.Platform {
	return server.Platform{
		ID: "terraform", Name: "HashiCorp Terraform", PackID: "terraform-cli", ToolID: "terraform",
		Summary:  "Approved local configuration formatting checks and state-address inventory. Remote operations and state mutations remain disabled.",
		Features: []server.PlatformFeature{{ID: "tasks", Name: "Offline CLI help"}},
	}
}
func (p *Platform) ActivateTool(state discovery.ToolState) {
	if state.PackID != "terraform-cli" || state.ToolID != "terraform" { return }
	p.mu.Lock()
	p.tool = state
	p.mu.Unlock()
}
func (p *Platform) TaskAvailable(packID, commandID string) bool {
	if packID != "terraform-cli" {
		return false
	}
	switch commandID {
	case "version", "command-reference", "provider-reference", "formatting-reference", "workflow-reference":
		return true
	default:
		return false
	}
}
func (p *Platform) ResolveExecutionContext(planner.Plan) (runs.ExecutionContext, error) {
	return runs.ExecutionContext{}, errors.New("Terraform state mutations are not authorized")
}

func (p *Platform) root(id string) (approvedRoot, error) {
	for i, root := range p.roots {
		if id == "project-"+strconv.Itoa(i+1) {
			current, err := os.Stat(root.path)
			if err != nil || !os.SameFile(current, root.info) || !current.IsDir() {
				return approvedRoot{}, errors.New("approved Terraform root changed")
			}
			resolved, err := filepath.EvalSymlinks(root.path)
			if err != nil || resolved != root.path {
				return approvedRoot{}, errors.New("approved Terraform root redirected")
			}
			return root, nil
		}
	}
	return approvedRoot{}, errors.New("unknown approved Terraform project")
}
func stateID(name string) string {
	sum := sha256.Sum256([]byte(name))
	return "state-" + hex.EncodeToString(sum[:12])
}
func states(root approvedRoot) ([]server.TerraformState, error) {
	files, err := boundedDirectoryEntries(root.path)
	if err != nil {
		return nil, err
	}
	result := make([]server.TerraformState, 0)
	for _, entry := range files {
		name := entry.Name()
		if entry.Type()&os.ModeSymlink != 0 || !strings.HasSuffix(strings.ToLower(name), ".tfstate") || entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if len(result) >= maxStates {
			return nil, errors.New("too many local state files")
		}
		result = append(result, server.TerraformState{ID: stateID(name), Name: name})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}
func (p *Platform) Projects() ([]server.TerraformProject, error) {
	result := make([]server.TerraformProject, 0, len(p.roots))
	for i := range p.roots {
		id := "project-" + strconv.Itoa(i+1)
		root, err := p.root(id)
		if err != nil {
			return nil, err
		}
		stateFiles, err := states(root)
		if err != nil {
			return nil, err
		}
		// Project/state discovery must remain usable even when a project
		// exceeds the stricter 64-file formatter limit.
		configs, err := boundedDirectoryEntries(root.path)
		if err != nil { return nil, err }
		eligible := 0
		for _, entry := range configs {
			if !strings.HasSuffix(entry.Name(), ".tf") ||
				entry.Type()&os.ModeSymlink != 0 || entry.IsDir() { continue }
			info, statErr := entry.Info()
			if statErr == nil && info.Mode().IsRegular() && info.Size() >= 0 && info.Size() <= maxConfigBytes { eligible++ }
		}
		result = append(result, server.TerraformProject{
			ID: id, Name: filepath.Base(root.path), States: stateFiles, ConfigurationFiles: eligible,
		})
	}
	return result, nil
}

type stateSnapshot struct {
	Version   int `json:"version"`
	Resources []struct {
		Module    string `json:"module"`
		Mode      string `json:"mode"`
		Type      string `json:"type"`
		Name      string `json:"name"`
		Instances []struct {
			IndexKey json.RawMessage `json:"index_key"`
		} `json:"instances"`
	} `json:"resources"`
}

func (p *Platform) Resources(projectID, selectedStateID string) ([]server.TerraformResource, error) {
	root, err := p.root(projectID)
	if err != nil {
		return nil, err
	}
	available, err := states(root)
	if err != nil {
		return nil, err
	}
	var name string
	for _, state := range available {
		if state.ID == selectedStateID {
			name = state.Name
			break
		}
	}
	if name == "" {
		return nil, errors.New("unknown approved local state file")
	}
	path := filepath.Join(root.path, name)
	if filepath.Dir(path) != root.path {
		return nil, errors.New("state file escaped approved root")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return nil, errors.New("state file symlink or junction rejected")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Size() > maxStateBytes {
		return nil, errors.New("state must be a bounded regular file")
	}
	current, err := os.Lstat(path)
	if err != nil || !os.SameFile(before, current) {
		return nil, errors.New("state file changed before inspection")
	}
	payload, err := io.ReadAll(io.LimitReader(file, maxStateBytes+1))
	if err != nil || len(payload) > maxStateBytes {
		return nil, errors.New("state read failed or oversized")
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() ||
		!before.ModTime().Equal(after.ModTime()) {
		return nil, errors.New("state changed while inspecting")
	}
	var snapshot stateSnapshot
	if err := json.Unmarshal(payload, &snapshot); err != nil || snapshot.Version != 4 {
		return nil, errors.New("unsupported or invalid local state snapshot")
	}
	if len(snapshot.Resources) > maxResources {
		return nil, errors.New("state resource inventory too large")
	}
	result := make([]server.TerraformResource, 0)
	unique := make(map[string]bool)
	for _, r := range snapshot.Resources {
		if !identifier.MatchString(r.Type) || !identifier.MatchString(r.Name) ||
			(r.Module != "" && !moduleAddress.MatchString(r.Module)) ||
			(r.Mode != "managed" && r.Mode != "data") {
			return nil, errors.New("unsupported Terraform state resource address")
		}
		category := r.Mode
		base := r.Type + "." + r.Name
		if r.Mode == "data" {
			base = "data." + base
		}
		if r.Module != "" {
			base = r.Module + "." + base
		}
		for _, instance := range r.Instances {
			address := base
			if len(instance.IndexKey) > 0 && string(instance.IndexKey) != "null" {
				var key any
				if err := json.Unmarshal(instance.IndexKey, &key); err != nil {
					return nil, errors.New("malformed resource instance key")
				}
				switch value := key.(type) {
				case string:
					if len(value) > 128 {
						return nil, errors.New("resource instance key too long")
					}
					encoded, _ := json.Marshal(value)
					address += "[" + string(encoded) + "]"
				case float64:
					if value < 0 || value >= 1e12 || value != float64(int64(value)) {
						return nil, errors.New("invalid instance index")
					}
					address += "[" + strconv.FormatInt(int64(value), 10) + "]"
				default:
					return nil, errors.New("unsupported resource instance key")
				}
			}
			if len(address) > 512 || unique[address] {
				return nil, errors.New("ambiguous resource address")
			}
			if len(result) >= maxResources {
				return nil, errors.New("state resource inventory too large")
			}
			unique[address] = true
			result = append(result, server.TerraformResource{
				Address: address, Type: r.Type, Module: r.Module, Category: category,
			})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Address < result[j].Address })
	return result, nil
}

// boundedDirectoryEntries never loads an unbounded directory into memory.
func boundedDirectoryEntries(path string) ([]os.DirEntry, error) {
	directory, err := os.Open(path)
	if err != nil { return nil, err }
	defer directory.Close()
	files, err := directory.ReadDir(4097)
	if err != nil && !errors.Is(err, io.EOF) { return nil, err }
	if len(files) > 4096 { return nil, errors.New("project directory too large") }
	return files, nil
}
