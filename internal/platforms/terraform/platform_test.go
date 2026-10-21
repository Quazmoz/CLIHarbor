package terraform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
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
