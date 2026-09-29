package planner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestStage5FirstPartyReadOnlyArgv(t *testing.T) {
	tests := []struct {
		name      string
		packPath  string
		packID    string
		toolID    string
		version   string
		commandID string
		want      []string
	}{
		{
			name: "docker disk usage",
			packPath: filepath.Join("..", "..", "packs", "docker", "docker.yaml"),
			packID: "docker-cli", toolID: "docker", version: "29.0.0", commandID: "disk-usage",
			want: []string{"system", "df"},
		},
		{
			name: "docker one-shot stats",
			packPath: filepath.Join("..", "..", "packs", "docker", "docker.yaml"),
			packID: "docker-cli", toolID: "docker", version: "29.0.0", commandID: "container-stats",
			want: []string{"container", "stats", "--no-stream", "--format", "table {{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}"},
		},
		{
			name: "kubectl statefulsets",
			packPath: filepath.Join("..", "..", "packs", "kubectl", "kubectl.yaml"),
			packID: "kubectl-cli", toolID: "kubectl", version: "1.36.0", commandID: "statefulsets",
			want: []string{"get", "statefulsets", "--all-namespaces", "--output=custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.readyReplicas,CURRENT:.status.currentReplicas,UPDATED:.status.updatedReplicas", "--no-headers"},
		},
		{
			name: "kubectl daemonsets",
			packPath: filepath.Join("..", "..", "packs", "kubectl", "kubectl.yaml"),
			packID: "kubectl-cli", toolID: "kubectl", version: "1.36.0", commandID: "daemonsets",
			want: []string{"get", "daemonsets", "--all-namespaces", "--output=custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,DESIRED:.status.desiredNumberScheduled,READY:.status.numberReady,AVAILABLE:.status.numberAvailable", "--no-headers"},
		},
		{
			name: "kubectl jobs",
			packPath: filepath.Join("..", "..", "packs", "kubectl", "kubectl.yaml"),
			packID: "kubectl-cli", toolID: "kubectl", version: "1.36.0", commandID: "jobs",
			want: []string{"get", "jobs", "--all-namespaces", "--output=custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,SUCCEEDED:.status.succeeded,ACTIVE:.status.active,FAILED:.status.failed", "--no-headers"},
		},
		{
			name: "kubectl node usage",
			packPath: filepath.Join("..", "..", "packs", "kubectl", "kubectl.yaml"),
			packID: "kubectl-cli", toolID: "kubectl", version: "1.36.0", commandID: "node-usage",
			want: []string{"top", "node"},
		},
		{
			name: "kubectl pod usage",
			packPath: filepath.Join("..", "..", "packs", "kubectl", "kubectl.yaml"),
			packID: "kubectl-cli", toolID: "kubectl", version: "1.36.0", commandID: "pod-usage",
			want: []string{"top", "pod", "--all-namespaces"},
		},
	}

	fixtures := map[string]struct {
		registry *packs.Registry
		snapshot discovery.Snapshot
	}{}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture, ok := fixtures[test.packID]
			if !ok {
				registry, snapshot := stage5PlannerFixture(t, test.packPath, test.packID, test.toolID, test.version)
				fixture = struct {
					registry *packs.Registry
					snapshot discovery.Snapshot
				}{registry: registry, snapshot: snapshot}
				fixtures[test.packID] = fixture
			}
			plan, err := Build(fixture.registry, fixture.snapshot, Request{
				PackID: test.packID, CommandID: test.commandID, Values: map[string]json.RawMessage{},
			})
			if err != nil {
				t.Fatalf("Build(%s) error = %v", test.commandID, err)
			}
			if !reflect.DeepEqual(plan.Args, test.want) {
				t.Fatalf("%s args = %#v, want %#v", test.commandID, plan.Args, test.want)
			}
			if plan.Risk != packs.RiskRead || plan.Output.Sensitivity.ContainsSecrets {
				t.Fatalf("%s escaped read-only/non-secret boundary: risk=%q sensitivity=%#v", test.commandID, plan.Risk, plan.Output.Sensitivity)
			}
		})
	}
}

func stage5PlannerFixture(t *testing.T, packPath, packID, toolID, version string) (*packs.Registry, discovery.Snapshot) {
	t.Helper()
	data, err := os.ReadFile(packPath)
	if err != nil {
		t.Fatalf("read pack: %v", err)
	}
	pack, err := packs.Parse(data)
	if err != nil {
		t.Fatalf("parse pack: %v", err)
	}
	registry, err := packs.NewRegistry([]packs.LoadedPack{{Pack: pack}})
	if err != nil {
		t.Fatalf("create registry: %v", err)
	}
	executable := filepath.Join(t.TempDir(), toolID)
	if err := os.WriteFile(executable, []byte("fixture"), 0o755); err != nil {
		t.Fatalf("write executable fixture: %v", err)
	}
	identity, err := discovery.CaptureExecutableIdentity(executable)
	if err != nil {
		t.Fatalf("capture executable identity: %v", err)
	}
	snapshot := discovery.NewSnapshot([]discovery.ToolState{{
		PackID: packID,
		PackVersion: pack.Metadata.Version,
		ToolID: toolID,
		Status: discovery.StatusReady,
		Path: executable,
		ExecutableName: filepath.Base(executable),
		Version: version,
		ExecutableIdentity: identity,
	}})
	return registry, snapshot
}
