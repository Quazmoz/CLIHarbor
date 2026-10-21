package app

import (
	"context"
	"reflect"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

func TestPrepareRuntimeLoadsEmbeddedFirstPartyPacksWhenDefaultsEnabled(t *testing.T) {
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
	docker, ok := state.Registry.FindPack("docker-cli")
	if !ok {
		t.Fatal("embedded Docker pack was not loaded")
	}
	if docker.Pack.Metadata.Name == "" {
		t.Fatal("embedded Docker pack metadata was empty")
	}
	if len(state.Registry.Commands("docker-cli")) != 8 {
		t.Fatalf("embedded Docker commands = %d, want 8", len(state.Registry.Commands("docker-cli")))
	}
	kubectl, ok := state.Registry.FindPack("kubectl-cli")
	if !ok {
		t.Fatal("embedded kubectl pack was not loaded")
	}
	if kubectl.Pack.Metadata.Name == "" {
		t.Fatal("embedded kubectl pack metadata was empty")
	}
	if len(state.Registry.Commands("kubectl-cli")) != 11 {
		t.Fatalf("embedded kubectl commands = %d, want 11", len(state.Registry.Commands("kubectl-cli")))
	}
	github, ok := state.Registry.FindPack("github-cli")
	if !ok || github.Pack.Metadata.Name == "" {
		t.Fatal("embedded GitHub pack was not loaded with metadata")
	}
	if len(state.Registry.Commands("github-cli")) != 6 {
		t.Fatalf("embedded GitHub commands = %d, want 6", len(state.Registry.Commands("github-cli")))
	}
	for id, want := range map[string]int{"aws-cli": 5, "helm-cli": 4, "vault-cli": 5, "terraform-cli": 8} {
		if got := len(state.Registry.Commands(id)); got != want {
			t.Fatalf("embedded %s commands = %d, want %d", id, got, want)
		}
	}

	terraform, ok := state.Registry.FindPack("terraform-cli")
	if !ok {
		t.Fatal("embedded Terraform pack was not loaded")
	}
	tool, ok := terraform.Pack.Runtime.Tools["terraform"]
	if !ok || tool.Install != nil {
		t.Fatal("Terraform tool missing or an unreviewed managed installation was enabled")
	}
	if tool.VersionProbe == nil || tool.VersionProbe.Parser != packs.VersionParserSemverText ||
		strings.Join(tool.VersionProbe.Args, " ") != "version -json" ||
		tool.VersionProbe.Prefix != `"terraform_version": "` {
		t.Fatal("Terraform version discovery must match the CLI version field, not provider versions")
	}
	// This is a regression guard on the embedded authority, not merely on the
	// separately-maintained packtest fixture: no workspaces, state, or mutations.
	approvedTerraform := map[string][]string{
		"version": {"version", "-json"},
		"command-reference": {"help"},
		"provider-reference": {"providers", "-help"},
		"formatting-reference": {"fmt", "-help"},
	}
	approvedWorkflow := map[string]string{
		"init": "init", "validate": "validate", "plan": "plan", "apply": "apply",
		"destroy": "destroy", "workspace": "workspace", "state": "state", "output": "output",
	}
	if len(terraform.Pack.Commands) != len(approvedTerraform)+4 {
		t.Fatal("Terraform builtin command count changed without security review")
	}
	for id, command := range terraform.Pack.Commands {
		if command.Tool != "terraform" || command.Risk != packs.RiskRead ||
			command.Requirements.RequiresAuth || command.Requirements.AuthMode != "" ||
			command.Stdin != nil || command.Impact != nil ||
			command.Output.Sensitivity.ContainsSecrets || command.Output.Sensitivity.PersistRawOutput ||
			command.Output.Sensitivity.RevealByDefault {
			t.Fatalf("unsafe embedded Terraform task %s", id)
		}
		if id == "local-state-resources" || id == "local-state-forget-preview" || id == "local-state-forget" {
			continue // Exact approved state argv and input contracts checked below.
		}
		if id == "workflow-reference" {
			if len(command.Inputs) != 1 || len(command.Argv) != 2 ||
				command.Inputs[0].ID != "workflow" || command.Inputs[0].Type != packs.InputEnum ||
				!command.Inputs[0].Required || !command.Inputs[0].Validation.DisallowLeadingDash ||
				!reflect.DeepEqual(command.Inputs[0].Validation.Enum, []string{
					"init", "validate", "plan", "apply", "destroy", "workspace", "state", "output",
				}) ||
				command.Argv[0].Map == nil || command.Argv[0].Map.ValueFrom != "workflow" ||
				!reflect.DeepEqual(command.Argv[0].Map.Values, approvedWorkflow) ||
				command.Argv[0].Literal != "" || command.Argv[0].Flag != nil ||
				command.Argv[0].Switch != nil || command.Argv[0].Positional != nil ||
				command.Argv[1].Literal != "-help" || command.Argv[1].Map != nil ||
				command.Argv[1].Flag != nil || command.Argv[1].Positional != nil ||
				command.Argv[1].Switch != nil {
				t.Fatal("Terraform workflow help must select only an allowlisted command and append -help")
			}
			for _, value := range command.Inputs[0].Validation.Enum {
				if approvedWorkflow[value] != value {
					t.Fatalf("Terraform workflow enum contains unreviewed command %q", value)
				}
			}
			continue
		}
		expected, approved := approvedTerraform[id]
		if !approved || len(command.Inputs) != 0 || len(command.Argv) != len(expected) {
			t.Fatalf("unsafe embedded Terraform task %s", id)
		}
		for i, arg := range command.Argv {
			if arg.Literal != expected[i] || arg.Flag != nil || arg.Switch != nil ||
				arg.Map != nil || arg.Positional != nil {
				t.Fatalf("Terraform task %s argv[%d] must be a fixed reviewed literal", id, i)
			}
		}
	}
	// The trusted built-in state workflow never allows the browser to select
	// alternate subcommands, backup destinations, or disable Terraform locking.
	stateCases := map[string]struct {
		risk packs.Risk
		argv []string
		inputCount int
	}{
		"local-state-resources": {packs.RiskRead, []string{"state", "list", "<state-file>"}, 1},
		"local-state-forget-preview": {packs.RiskRead, []string{"state", "rm", "-dry-run", "<state-file>", "<address>"}, 2},
		"local-state-forget": {packs.RiskChange, []string{"state", "rm", "-lock-timeout=5s", "<state-file>", "<address>"}, 2},
	}
	for id, tc := range stateCases {
		command, ok := terraform.Pack.Commands[id]
		if !ok || command.Risk != tc.risk || command.Tool != "terraform" ||
			len(command.Inputs) != tc.inputCount || len(command.Argv) != len(tc.argv) ||
			command.Requirements.RequiresAuth || command.Requirements.AuthMode != "" ||
			command.Output.Sensitivity.ContainsSecrets || command.Stdin != nil {
			t.Fatalf("Terraform local-state task %s has an unreviewed contract", id)
		}
		if command.Inputs[0].ID != "state-file" || !command.Inputs[0].Required ||
			command.Inputs[0].Type != packs.InputString || command.Inputs[0].Validation.Pattern == "" {
			t.Fatalf("Terraform local-state task %s lost state path validation", id)
		}
		for n, expected := range tc.argv {
			arg := command.Argv[n]
			switch expected {
			case "<state-file>":
				if arg.Flag == nil || arg.Flag.Name != "-state" || arg.Flag.ValueFrom != "state-file" {
					t.Fatalf("%s argv[%d] must use the state-file input", id, n)
				}
			case "<address>":
				if arg.Positional == nil || arg.Positional.ValueFrom != "address" {
					t.Fatalf("%s argv[%d] must use resource address as one argv token", id, n)
				}
			default:
				if arg.Literal != expected || arg.Flag != nil || arg.Positional != nil ||
					arg.Map != nil || arg.Switch != nil {
					t.Fatalf("%s argv[%d] must be a fixed reviewed literal", id, n)
				}
			}
		}
		if id != "local-state-resources" && (command.Inputs[1].ID != "address" ||
			!command.Inputs[1].Required || command.Inputs[1].Validation.Pattern == "") {
			t.Fatalf("%s resource address validation is missing", id)
		}
		if id == "local-state-forget" {
			if command.Impact == nil || command.Impact.TargetInput != "address" ||
				command.Impact.Scope != packs.ImpactScopeMultiple {
				t.Fatal("state removal must require typed multiple-resource approval")
			}
		} else if command.Impact != nil {
			t.Fatalf("read-only state task %s unexpectedly has mutation impact", id)
		}
	}

	versionOutput := terraform.Pack.Commands["version"].Output
	if versionOutput.Mode != packs.OutputJSON || versionOutput.Renderer != "cards" ||
		versionOutput.Structured == nil || len(versionOutput.Structured.Fields) != 2 ||
		versionOutput.Structured.Fields[0].Key != "terraform_version" ||
		versionOutput.Structured.Fields[1].Key != "platform" {
		t.Fatal("Terraform version must display only its reviewed version/platform card fields")
	}

	idiraPack, ok := state.Registry.FindPack("cyberark-idira-pam")
	if !ok || len(idiraPack.Pack.Commands) != 4 {
		t.Fatal("embedded Idira PAM pack was not loaded with four reviewed tasks")
	}
	// Even with no installed executables, every supported CLI remains discoverable
	// in Add a CLI; only executable tasks are withheld until qualification.
	catalog := newTaskCatalog(state.Registry, missingInstallSnapshot(state.Registry))
	tools := catalog.ListTools()
	if len(tools) != 9 || len(catalog.ListTasks()) != 0 {
		t.Fatalf("missing-tool catalog = %#v; tasks = %#v", tools, catalog.ListTasks())
	}
	for _, tool := range tools {
		if tool.PackID != "cyberark-conjur-v9" {
			continue
		}
		if !strings.Contains(tool.PackName, "Conjur") || tool.Status != "missing" {
			t.Fatalf("Conjur catalog entry = %#v", tool)
		}
		if (runtime.GOOS == "darwin" || runtime.GOOS == "windows" && runtime.GOARCH == "amd64") && tool.Install == nil {
			t.Fatal("missing Conjur has no supported native installer")
		}
	}
}

func TestPrepareRuntimeCombinesDefaultAndExplicitPacks(t *testing.T) {
	t.Parallel()

	packPath := filepath.Join(t.TempDir(), "other.yaml")
	data := []byte(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: other-cli
  name: Other CLI
  version: 0.1.0
runtime:
  platforms: [windows, linux, darwin]
  tools:
    other:
      executableNames: [definitely-not-a-real-cli-binary]
commands: {}
`)
	if err := os.WriteFile(packPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	state, err := prepareRuntime(context.Background(), Options{
		LoadDefaultPacks: true,
		PackFiles:        []string{packPath},
	})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	if _, ok := state.Registry.FindPack("cyberark-conjur-v9"); !ok {
		t.Fatal("embedded Conjur pack was not retained")
	}
	if _, ok := state.Registry.FindPack("other-cli"); !ok {
		t.Fatal("explicit non-Conjur pack was not added")
	}
	if got := len(state.Registry.Packs()); got != 10 {
		t.Fatalf("configured packs = %d, want 10", got)
	}
}

func TestPrepareRuntimeCombinesPackDirectoryAndPackFiles(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	directory := filepath.Join(root, "packs")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	pack := func(id, tool, executable string) []byte {
		return []byte("apiVersion: cliharbor.dev/v1\nkind: CliPack\nmetadata:\n  id: " + id +
			"\n  name: " + id + "\n  version: 0.1.0\nruntime:\n  platforms: [windows, linux, darwin]\n  tools:\n    " +
			tool + ":\n      executableNames: [" + executable + "]\ncommands: {}\n")
	}
	if err := os.WriteFile(filepath.Join(directory, "alpha.yaml"), pack("alpha-cli", "alpha", "alpha-cli"), 0o600); err != nil {
		t.Fatal(err)
	}
	beta := filepath.Join(root, "beta.yaml")
	if err := os.WriteFile(beta, pack("beta-cli", "beta", "beta-cli"), 0o600); err != nil {
		t.Fatal(err)
	}

	state, err := prepareRuntime(context.Background(), Options{
		PackDirectory: directory,
		PackFiles:     []string{beta},
	})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	if got := len(state.Registry.Packs()); got != 2 {
		t.Fatalf("configured packs = %d, want 2", got)
	}
}

func TestPrepareRuntimeRejectsFirstPartyIDImpersonationWithoutDefaults(t *testing.T) {
	for _, id := range []string{"cyberark-idira-pam", "cyberark-conjur-v9", "docker-cli", "kubectl-cli", "github-cli", "aws-cli", "helm-cli", "vault-cli", "terraform-cli"} {
		for _, source := range []string{"file", "directory"} {
			t.Run(id+"/"+source, func(t *testing.T) {
				dir := t.TempDir()
				path := filepath.Join(dir, "impostor.yaml")
				data := []byte("apiVersion: cliharbor.dev/v1\nkind: CliPack\nmetadata:\n  id: " + id +
					"\n  name: Impostor\n  version: 0.1.0\nruntime:\n  platforms: [windows, linux, darwin]\n" +
					"  tools:\n    impostor:\n      executableNames: [impostor]\ncommands: {}\n")
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
				options := Options{}
				if source == "directory" {
					options.PackDirectory = dir
				} else {
					options.PackFiles = []string{path}
				}
				_, err := prepareRuntime(context.Background(), options)
				if err == nil || !strings.Contains(err.Error(), "reserved for a built-in CLI") {
					t.Fatalf("custom pack impersonation of %q was not rejected: %v", id, err)
				}
			})
		}
	}
}

func TestPrepareRuntimePermitsOnlyExactFirstPartyCopyWithoutDefaults(t *testing.T) {
	source := filepath.Join("..", "..", "packs", "conjur", "conjur-v9.yaml")
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	exact := filepath.Join(dir, "exact.yaml")
	if err := os.WriteFile(exact, data, 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := prepareRuntime(context.Background(), Options{PackFiles: []string{exact}})
	if err != nil {
		t.Fatalf("exact embedded Conjur pack could not load without defaults: %v", err)
	}
	if got := len(state.Registry.Packs()); got != 1 {
		t.Fatalf("loaded %d packs, want the exact first-party Conjur pack", got)
	}
	changed := filepath.Join(dir, "changed.yaml")
	if err := os.WriteFile(changed, append(append([]byte(nil), data...), '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareRuntime(context.Background(), Options{PackFiles: []string{changed}}); err == nil ||
		!strings.Contains(err.Error(), "reserved for a built-in CLI") {
		t.Fatalf("modified first-party pack was allowed despite changed bytes: %v", err)
	}
}

func TestPrepareRuntimeZeroValueOptionsDoNotLoadDefaults(t *testing.T) {
	t.Parallel()

	state, err := prepareRuntime(context.Background(), Options{})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	if len(state.Registry.Packs()) != 0 {
		t.Fatalf("zero-value app options unexpectedly loaded defaults: %d packs", len(state.Registry.Packs()))
	}
}

type recordingProvisioner struct {
	refs []discovery.ToolRef
}

func (p *recordingProvisioner) Ensure(_ context.Context, ref discovery.ToolRef) (string, bool, error) {
	p.refs = append(p.refs, ref)
	return "", false, nil
}

func TestPrepareRuntimeDoesNotProvisionCustomTools(t *testing.T) {
	packPath := filepath.Join(t.TempDir(), "other.yaml")
	data := []byte(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: other-cli
  name: Other CLI
  version: 0.1.0
runtime:
  platforms: [windows, linux, darwin]
  tools:
    other:
      executableNames: [definitely-not-a-real-cli-binary]
commands: {}
`)
	if err := os.WriteFile(packPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	provisioner := &recordingProvisioner{}
	_, err := prepareRuntime(context.Background(), Options{
		LoadDefaultPacks:   true,
		AutoProvisionTools: true,
		PackFiles:          []string{packPath},
		ToolProvisioner:    provisioner,
	})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	for _, ref := range provisioner.refs {
		if ref.PackID == "other-cli" {
			t.Fatalf("custom tool unexpectedly reached automatic provisioner: %s", ref.String())
		}
	}
}

func TestPrepareRuntimeNeverAutoProvisionsDocker(t *testing.T) {
	t.Parallel()

	provisioner := &recordingProvisioner{}
	_, err := prepareRuntime(context.Background(), Options{
		LoadDefaultPacks:   true,
		AutoProvisionTools: true,
		ToolProvisioner:    provisioner,
	})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	for _, ref := range provisioner.refs {
		if ref.PackID != "cyberark-conjur-v9" || ref.ToolID != "conjur" {
			t.Fatalf("unreviewed tool unexpectedly reached automatic provisioner: %s", ref.String())
		}
	}
}

func TestPrepareRuntimeNeverAutoProvisionsKubectl(t *testing.T) {
	t.Parallel()

	provisioner := &recordingProvisioner{}
	_, err := prepareRuntime(context.Background(), Options{
		LoadDefaultPacks:   true,
		AutoProvisionTools: true,
		ToolProvisioner:    provisioner,
	})
	if err != nil {
		t.Fatalf("prepareRuntime: %v", err)
	}
	for _, ref := range provisioner.refs {
		if ref.PackID == "kubectl-cli" || ref.ToolID == "kubectl" {
			t.Fatalf("kubectl unexpectedly reached automatic provisioner: %s", ref.String())
		}
	}
}

func TestPrepareRuntimeRejectsDuplicatePackIDAcrossSources(t *testing.T) {
	packPath := filepath.Join(t.TempDir(), "duplicate.yaml")
	data := []byte(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: cyberark-conjur-v9
  name: Conflicting Pack
  version: 0.1.0
runtime:
  platforms: [windows, linux, darwin]
  tools:
    other:
      executableNames: [other-cli]
commands: {}
`)
	if err := os.WriteFile(packPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := prepareRuntime(context.Background(), Options{
		LoadDefaultPacks: true,
		PackFiles:        []string{packPath},
	}); err == nil {
		t.Fatal("duplicate custom/default pack id unexpectedly succeeded")
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
