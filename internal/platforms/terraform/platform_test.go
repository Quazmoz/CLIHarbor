package terraform

import (
	"context"
	"encoding/json"
	"fmt"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

// resolvedTempDir strips OS-level ancestor symlinks (macOS /var -> /private/var),
// which New deliberately rejects.
func resolvedTempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func approvedFixture(t *testing.T, contents string) (*Platform, string) {
	t.Helper()
	root := resolvedTempDir(t)
	if err := os.WriteFile(filepath.Join(root, "terraform.tfstate"), []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	p, err := New([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	projects, err := p.Projects()
	if err != nil || len(projects) != 1 || len(projects[0].States) != 1 {
		t.Fatalf("approved inventory = %#v, %v", projects, err)
	}
	return p, projects[0].States[0].ID
}

func TestAddressInventoryExcludesStateAttributes(t *testing.T) {
	p, state := approvedFixture(t, `{"version":4,"resources":[
        {"mode":"managed","type":"aws_instance","name":"server","instances":[
            {"index_key":0,"attributes":{"password":"SECRET-MUST-NOT-LEAK"}},
            {"index_key":1,"attributes":{"password":"SECRET-MUST-NOT-LEAK"}}]},
        {"module":"module.app","mode":"data","type":"aws_ami","name":"linux","instances":[{"index_key":"blue"}]}
    ]}`)
	got, err := p.Resources("project-1", state)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].Address != "aws_instance.server[0]" ||
		got[1].Address != "aws_instance.server[1]" ||
		got[2].Address != `module.app.data.aws_ami.linux["blue"]` {
		t.Fatalf("unexpected inventory: %#v", got)
	}
	serialized, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(serialized), "SECRET-MUST-NOT-LEAK") {
		t.Fatal("state attribute escaped into API")
	}
}
func TestUnapprovedMalformedOversizedAndDuplicateStateRefused(t *testing.T) {
	p, state := approvedFixture(t, `{"version":4,"resources":[]}`)
	for _, pair := range [][2]string{{"project-2", state}, {"../../etc", state}, {"project-1", "state-other"}} {
		if _, err := p.Resources(pair[0], pair[1]); err == nil {
			t.Fatalf("unapproved selection %v accepted", pair)
		}
	}
	target := filepath.Join(p.roots[0].path, "terraform.tfstate")
	for _, contents := range []string{"not-json", strings.Repeat("x", maxStateBytes+1), `{"version":4,"resources":[{"mode":"managed","type":"aws_instance","name":"x","instances":[{},{}]}]}`} {
		if err := os.WriteFile(target, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := p.Resources("project-1", state); err == nil {
			t.Fatal("invalid state was admitted")
		}
	}
}
func TestStateSymlinkIsNotAdvertised(t *testing.T) {
	root := resolvedTempDir(t)
	target := filepath.Join(t.TempDir(), "outside.tfstate")
	if err := os.WriteFile(target, []byte(`{"version":4,"resources":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "outside.tfstate")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	p, err := New([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	projects, err := p.Projects()
	if err != nil {
		t.Fatal(err)
	}
	if len(projects[0].States) != 0 {
		t.Fatal("symlinked state advertised")
	}
	if _, err := p.Resources("project-1", stateID("outside.tfstate")); err == nil {
		t.Fatal("symlink target accessible")
	}
}
func TestStateMutationCommandsAreNotAuthorized(t *testing.T) {
	p, err := New(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"local-state-resources", "local-state-forget-preview", "local-state-forget", "apply", "destroy"} {
		if p.TaskAvailable("terraform-cli", command) {
			t.Fatalf("mutation-capable command %s admitted", command)
		}
	}
	if !p.TaskAvailable("terraform-cli", "workflow-reference") {
		t.Fatal("safe help blocked")
	}
}

func TestWindowsRootCaseDifferenceIsNotAJunction(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("EvalSymlinks canonicalizes case only on Windows")
	}
	root := resolvedTempDir(t)
	if err := os.WriteFile(filepath.Join(root, "terraform.tfstate"), []byte(`{"version":4,"resources":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	p, err := New([]string{strings.ToLower(root)})
	if err != nil {
		t.Fatalf("lower-case spelling of an approved root rejected: %v", err)
	}
	projects, err := p.Projects()
	if err != nil || len(projects) != 1 || len(projects[0].States) != 1 {
		t.Fatalf("projects = %#v, %v", projects, err)
	}
	if _, err := p.Resources("project-1", projects[0].States[0].ID); err != nil {
		t.Fatalf("state under case-variant root unreadable: %v", err)
	}
}

func TestConfigurationInventoryIsBoundedAndIgnoresVariableValues(t *testing.T) {
	root := resolvedTempDir(t)
	for name, contents := range map[string][]byte{
		"main.tf": []byte("variable \"name\" {}\n"),
		"secrets.tfvars": []byte("password = \"SECRET-MUST-NOT-LEAK\"\n"),
		"oversized.tf": bytes.Repeat([]byte("x"), maxConfigBytes+1),
		"terraform.tfstate": []byte("{\"version\":4,\"resources\":[]}"),
	} {
		if err := os.WriteFile(filepath.Join(root, name), contents, 0600); err != nil { t.Fatal(err) }
	}
	if err := os.Symlink(filepath.Join(root, "main.tf"), filepath.Join(root, "link.tf")); err != nil {
		t.Logf("symlink not supported here: %v", err)
	}
	p, err := New([]string{root})
	if err != nil { t.Fatal(err) }
	projects, err := p.Projects()
	if err != nil { t.Fatal(err) }
	if len(projects) != 1 || projects[0].ConfigurationFiles != 1 { t.Fatalf("eligible config count = %#v", projects) }
	entries, err := configurationEntries(p.roots[0])
	if err != nil { t.Fatal(err) }
	for _, entry := range entries {
		if entry.Name() == "secrets.tfvars" { t.Fatal("tfvars entered formatter inventory") }
	}
	dir, err := os.OpenRoot(root)
	if err != nil { t.Fatal(err) }
	defer dir.Close()
	if _, status := readConfiguration(dir, filepath.Join(root,"oversized.tf"),"oversized.tf"); status != "unsupported" { t.Fatalf("oversize status = %q", status) }
	if _, statErr := os.Lstat(filepath.Join(root,"link.tf")); statErr == nil {
		if _, status := readConfiguration(dir, filepath.Join(root,"link.tf"),"link.tf"); status != "unsupported" { t.Fatalf("symlink status = %q", status) }
	}
}

func TestFormatCheckRejectsUnknownProjectAndConcurrentOperation(t *testing.T) {
	p, err := New([]string{resolvedTempDir(t)})
	if err != nil { t.Fatal(err) }
	if _, err := p.FormatCheck(context.Background(), "project-2"); err == nil { t.Fatal("unapproved project accepted") }
	p.formatSlot <- struct{}{}
	if _, err := p.FormatCheck(context.Background(), "project-1"); err == nil { t.Fatal("duplicate operation accepted") }
	<-p.formatSlot
}

func TestFormatCheckWithInstalledTerraformDoesNotModifyFilesOrLeakSource(t *testing.T) {
	exe, err := exec.LookPath("terraform")
	if err != nil { t.Skip("real Terraform executable is not installed") }
	exe, err = filepath.Abs(exe)
	if err != nil { t.Fatal(err) }
	identity, err := discovery.CaptureExecutableIdentity(exe)
	if err != nil { t.Skipf("Terraform executable identity cannot be safely captured: %v", err) }
	root := resolvedTempDir(t)
	good := []byte("variable \"name\" {\n  type = string\n}\n")
	bad := []byte("variable \"region\" { default=\"us-east-1\" }\n")
	mustWrite := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil { t.Fatal(err) }
	}
	mustWrite("good.tf", good)
	mustWrite("bad.tf", bad)
	mustWrite("secret.tfvars", []byte("password = \"SECRET-MUST-NOT-LEAK\"\n"))
	p, err := New([]string{root})
	if err != nil { t.Fatal(err) }
	p.ActivateTool(discovery.ToolState{
		PackID: "terraform-cli", ToolID: "terraform", Status: discovery.StatusReady,
		Path: exe, ExecutableIdentity: identity, Version: "installed",
	})
	report, err := p.FormatCheck(context.Background(), "project-1")
	if err != nil { t.Fatal(err) }
	statuses := make(map[string]string)
	for _, file := range report.Files { statuses[file.Name] = file.Status }
	if statuses["good.tf"] != "formatted" || statuses["bad.tf"] != "needs-formatting" || len(statuses) != 2 {
		t.Fatalf("unexpected Terraform results: %#v", statuses)
	}
	for name, expected := range map[string][]byte{"good.tf":good, "bad.tf":bad} {
		actual, err := os.ReadFile(filepath.Join(root,name))
		if err != nil || !bytes.Equal(expected,actual) { t.Fatalf("%s modified after fmt: %v", name,err) }
	}
	encoded, err := json.Marshal(report)
	if err != nil { t.Fatal(err) }
	if bytes.Contains(encoded, []byte("SECRET-MUST-NOT-LEAK")) || bytes.Contains(encoded,bad) {
		t.Fatal("formatting result revealed source content")
	}
}

func TestLargeConfigurationProjectStillExposesStateInventory(t *testing.T) {
	root := resolvedTempDir(t)
	for i := range maxConfigFiles+1 {
		name := filepath.Join(root, fmt.Sprintf("config-%03d.tf", i))
		if err := os.WriteFile(name, []byte("locals {}\n"), 0600); err != nil { t.Fatal(err) }
	}
	if err := os.WriteFile(filepath.Join(root, "terraform.tfstate"), []byte(`{"version":4,"resources":[]}`), 0600); err != nil { t.Fatal(err) }
	p, err := New([]string{root})
	if err != nil { t.Fatal(err) }
	projects, err := p.Projects()
	if err != nil { t.Fatal(err) }
	if len(projects) != 1 || len(projects[0].States) != 1 || projects[0].ConfigurationFiles != maxConfigFiles+1 {
		t.Fatalf("state inventory or accurate eligible count lost: %#v", projects)
	}
	if _, err := configurationEntries(p.roots[0]); err == nil {
		t.Fatal("formatter file limit unexpectedly lifted")
	}
}

func TestMissingTerraformCLIRefusesFormatting(t *testing.T) {
	root := resolvedTempDir(t)
	if err := os.WriteFile(filepath.Join(root,"main.tf"), []byte("locals {}\n"), 0600); err != nil { t.Fatal(err) }
	p, err := New([]string{root})
	if err != nil { t.Fatal(err) }
	if _, err := p.FormatCheck(context.Background(), "project-1"); err == nil { t.Fatal("unavailable CLI was accepted") }
}
