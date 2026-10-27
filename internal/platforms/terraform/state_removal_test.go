package terraform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

// TestMain lets this package's test binary double as a fake `terraform` CLI
// when the platform invokes it as `<test-binary> state rm ...`. The fake's
// behaviour is chosen by a mode file beside the state, because the platform
// runs Terraform with a neutral environment (no env var can reach it).
func TestMain(m *testing.M) {
	if len(os.Args) > 2 && os.Args[1] == "state" && os.Args[2] == "rm" {
		os.Exit(fakeTerraformStateRm(os.Args[3:]))
	}
	os.Exit(m.Run())
}

const fakeModeFile = ".fake-terraform-mode"

func fakeTerraformStateRm(args []string) int {
	var statePath, backupPath string
	dryRun := false
	var addresses []string
	for i, arg := range args {
		switch {
		case arg == "--":
			addresses = args[i+1:]
		case arg == "-dry-run":
			dryRun = true
		case strings.HasPrefix(arg, "-state="):
			statePath = strings.TrimPrefix(arg, "-state=")
		case strings.HasPrefix(arg, "-backup="):
			backupPath = strings.TrimPrefix(arg, "-backup=")
		case arg == "-lock=true" || arg == "-lock-timeout=0s":
		default:
			if addresses == nil {
				fmt.Fprintln(os.Stderr, "unexpected argument", arg)
				return 64
			}
		}
		if addresses != nil {
			break
		}
	}
	if statePath == "" || !filepath.IsAbs(statePath) || len(addresses) == 0 {
		return 65
	}
	modeBytes, _ := os.ReadFile(filepath.Join(filepath.Dir(statePath), fakeModeFile))
	mode := strings.TrimSpace(string(modeBytes))
	if mode == "locked" {
		fmt.Fprintln(os.Stderr, "Error acquiring the state lock")
		return 1
	}
	if mode == "concurrent-writer" && !dryRun {
		// Another process rewrites the state between CLIHarbor's last check
		// and Terraform's read.
		raw, _ := os.ReadFile(statePath)
		var doc map[string]any
		_ = json.Unmarshal(raw, &doc)
		doc["serial"] = doc["serial"].(float64) + 100
		changed, _ := json.Marshal(doc)
		_ = os.WriteFile(statePath, changed, 0o600)
	}
	raw, err := os.ReadFile(statePath)
	if err != nil {
		return 66
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return 67
	}
	remove := map[string]bool{}
	for _, address := range addresses {
		remove[address] = true
	}
	if mode == "overreach" {
		remove["null_resource.keep"] = true
	}
	if dryRun {
		if mode == "dry-run-mismatch" {
			fmt.Println("Would remove something.else")
			return 0
		}
		for _, address := range addresses {
			fmt.Println("Would remove " + address)
		}
		return 0
	}
	if backupPath != "" {
		if err := os.WriteFile(backupPath, raw, 0o600); err != nil {
			return 68
		}
	}
	resources := doc["resources"].([]any)
	kept := make([]any, 0, len(resources))
	for _, item := range resources {
		resource := item.(map[string]any)
		address := resource["type"].(string) + "." + resource["name"].(string)
		if module, ok := resource["module"].(string); ok && module != "" {
			address = module + "." + address
		}
		if !remove[address] {
			kept = append(kept, resource)
		}
	}
	doc["resources"] = kept
	doc["serial"] = doc["serial"].(float64) + 1
	updated, _ := json.Marshal(doc)
	if err := os.WriteFile(statePath, updated, 0o600); err != nil {
		return 69
	}
	if mode == "fail-after-write" {
		return 1
	}
	for _, address := range addresses {
		fmt.Println("Removed " + address)
	}
	return 0
}

const removalFixture = `{"version":4,"terraform_version":"1.9.8","serial":7,"lineage":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","outputs":{},"resources":[
{"mode":"managed","type":"null_resource","name":"gone","instances":[{"attributes":{"id":"1"}}]},
{"mode":"managed","type":"null_resource","name":"keep","instances":[{"attributes":{"id":"2"}}]},
{"module":"module.m","mode":"managed","type":"null_resource","name":"also","instances":[{"attributes":{"id":"3"}}]}
]}`

type memoryAudit struct {
	mu     sync.Mutex
	events []runs.AuditEvent
	fail   bool
}

func (a *memoryAudit) Append(event runs.AuditEvent) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.fail {
		return errors.New("audit down")
	}
	a.events = append(a.events, event)
	return nil
}

type removalHarness struct {
	p       *Platform
	root    string
	stateID string
	audit   *memoryAudit
}

func newRemovalHarness(t *testing.T, mode string) *removalHarness {
	t.Helper()
	p, stateID := approvedFixture(t, removalFixture)
	root := p.roots[0].path
	if mode != "" {
		if err := os.WriteFile(filepath.Join(root, fakeModeFile), []byte(mode), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	activateExecutable(t, p, exe)
	audit := &memoryAudit{}
	p.SetAudit(audit)
	return &removalHarness{p: p, root: root, stateID: stateID, audit: audit}
}

func activateExecutable(t *testing.T, p *Platform, exe string) {
	t.Helper()
	// Match discovery: identity capture receives the resolved executable, not
	// a PATH symlink (for example Homebrew's terraform link).
	exe, err := filepath.EvalSymlinks(exe)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := discovery.CaptureExecutableIdentity(exe)
	if err != nil {
		t.Fatal(err)
	}
	p.ActivateTool(discovery.ToolState{
		PackID: "terraform-cli", ToolID: "terraform", Status: discovery.StatusReady,
		Path: exe, ExecutableIdentity: identity, Version: "1.9.8-test",
	})
}

func (h *removalHarness) preview(t *testing.T, addresses ...string) server.TerraformStateRemovalPreview {
	t.Helper()
	preview, err := h.p.PreviewStateRemoval(context.Background(), server.TerraformStateRemovalPreviewRequest{
		ProjectID: "project-1", StateID: h.stateID, Addresses: addresses,
	})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	return preview
}

func (h *removalHarness) execute(previewID, confirm string) (server.TerraformStateRemovalResult, error) {
	return h.p.ExecuteStateRemoval(context.Background(), server.TerraformStateRemovalExecuteRequest{PreviewID: previewID, Confirm: confirm})
}

func (h *removalHarness) addresses(t *testing.T) []string {
	t.Helper()
	resources, err := h.p.Resources("project-1", h.stateID)
	if err != nil {
		t.Fatal(err)
	}
	result := make([]string, 0, len(resources))
	for _, resource := range resources {
		result = append(result, resource.Address)
	}
	return result
}

func (h *removalHarness) state(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(h.root, "terraform.tfstate"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func refusalCode(err error) server.TerraformStateRemovalErrorCode {
	var removal *server.TerraformStateRemovalError
	if errors.As(err, &removal) {
		return removal.Code
	}
	return ""
}

func TestStateRemovalRemovesExactlyPreviewedAddressesWithVerifiedBackups(t *testing.T) {
	h := newRemovalHarness(t, "")
	original := h.state(t)
	preview := h.preview(t, "null_resource.gone", "module.m.null_resource.also")
	if preview.StateName != "terraform.tfstate" || preview.Serial != 7 || len(preview.PreviewID) != 43 ||
		strings.Join(preview.Addresses, ",") != "module.m.null_resource.also,null_resource.gone" {
		t.Fatalf("preview = %#v", preview)
	}
	if string(h.state(t)) != string(original) {
		t.Fatal("dry-run preview changed the state")
	}
	result, err := h.execute(preview.PreviewID, "terraform.tfstate")
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != "removed" || result.Serial != 8 || len(result.Removed) != 2 || result.Problem != "" ||
		!strings.HasPrefix(result.Backup, "terraform.tfstate.cliharbor-") || result.TerraformBackup == "" {
		t.Fatalf("result = %#v", result)
	}
	if got := h.addresses(t); strings.Join(got, ",") != "null_resource.keep" {
		t.Fatalf("remaining = %v", got)
	}
	// CLIHarbor's backup is byte-identical; Terraform's is re-serialized by
	// real Terraform, so only CLIHarbor's is compared byte for byte.
	for _, name := range []string{result.Backup} {
		data, err := os.ReadFile(filepath.Join(h.root, name))
		if err != nil || string(data) != string(original) {
			t.Fatalf("backup %s does not hold the previewed snapshot: %v", name, err)
		}
		if strings.Contains(name, "/") || strings.Contains(name, `\`) {
			t.Fatalf("backup name leaks a path: %q", name)
		}
	}
	// Backups are not state files and must not appear in the selector.
	projects, _ := h.p.Projects()
	if len(projects[0].States) != 1 {
		t.Fatalf("backups were listed as state files: %#v", projects[0].States)
	}
	if len(h.audit.events) != 2 || h.audit.events[0].Action != "approved" || h.audit.events[0].Risk != "destructive" ||
		h.audit.events[0].CommandID != "state-rm" || h.audit.events[1].Action != "completed" ||
		h.audit.events[1].Status != "exited" || h.audit.events[1].ExitCode == nil || *h.audit.events[1].ExitCode != 0 ||
		h.audit.events[0].RunID != h.audit.events[1].RunID {
		t.Fatalf("audit = %#v", h.audit.events)
	}
}

func TestStateRemovalPreviewIsOneUse(t *testing.T) {
	h := newRemovalHarness(t, "")
	preview := h.preview(t, "null_resource.gone")
	if _, err := h.execute(preview.PreviewID, "terraform.tfstate"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.execute(preview.PreviewID, "terraform.tfstate"); refusalCode(err) != server.TerraformRemovalStale {
		t.Fatalf("replay err = %v, want stale", err)
	}
}

func TestStateRemovalWrongConfirmationConsumesPreviewAndChangesNothing(t *testing.T) {
	h := newRemovalHarness(t, "")
	original := h.state(t)
	preview := h.preview(t, "null_resource.gone")
	if _, err := h.execute(preview.PreviewID, "other.tfstate"); refusalCode(err) != server.TerraformRemovalInvalid {
		t.Fatalf("err = %v", err)
	}
	if _, err := h.execute(preview.PreviewID, "terraform.tfstate"); refusalCode(err) != server.TerraformRemovalStale {
		t.Fatalf("preview survived a failed confirmation: %v", err)
	}
	if string(h.state(t)) != string(original) || len(h.audit.events) != 0 {
		t.Fatal("refused execution changed state or wrote audit")
	}
}

func TestStateRemovalPreviewExpires(t *testing.T) {
	h := newRemovalHarness(t, "")
	now := time.Now()
	h.p.now = func() time.Time { return now }
	preview := h.preview(t, "null_resource.gone")
	h.p.now = func() time.Time { return now.Add(removalPreviewTTL) }
	if _, err := h.execute(preview.PreviewID, "terraform.tfstate"); refusalCode(err) != server.TerraformRemovalStale {
		t.Fatalf("expired preview err = %v", err)
	}
}

func TestStateRemovalRefusesWhenStateChangedAfterPreview(t *testing.T) {
	h := newRemovalHarness(t, "")
	preview := h.preview(t, "null_resource.gone")
	changed := strings.Replace(removalFixture, `"serial":7`, `"serial":9`, 1)
	if err := os.WriteFile(filepath.Join(h.root, "terraform.tfstate"), []byte(changed), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.execute(preview.PreviewID, "terraform.tfstate"); refusalCode(err) != server.TerraformRemovalStale {
		t.Fatalf("err = %v", err)
	}
	if len(h.audit.events) != 0 {
		t.Fatal("stale preview reached the audit journal")
	}
}

func TestStateRemovalRejectsAddressesOutsideTheSnapshot(t *testing.T) {
	h := newRemovalHarness(t, "")
	for _, addresses := range [][]string{
		{"null_resource.missing"},
		{"-lock=false"},
		{"null_resource.gone", "null_resource.gone"},
		{},
		{"module.m"}, // a whole module is not an instance address from the inventory
	} {
		_, err := h.p.PreviewStateRemoval(context.Background(), server.TerraformStateRemovalPreviewRequest{
			ProjectID: "project-1", StateID: h.stateID, Addresses: addresses,
		})
		if refusalCode(err) != server.TerraformRemovalInvalid {
			t.Fatalf("addresses %q err = %v, want invalid", addresses, err)
		}
	}
}

func TestStateRemovalRequiresDryRunToListExactlyTheAddresses(t *testing.T) {
	h := newRemovalHarness(t, "dry-run-mismatch")
	_, err := h.p.PreviewStateRemoval(context.Background(), server.TerraformStateRemovalPreviewRequest{
		ProjectID: "project-1", StateID: h.stateID, Addresses: []string{"null_resource.gone"},
	})
	if refusalCode(err) != server.TerraformRemovalRejected {
		t.Fatalf("err = %v, want rejected", err)
	}
}

func TestStateRemovalLockedStateIsRejectedAndUntouched(t *testing.T) {
	h := newRemovalHarness(t, "")
	original := h.state(t)
	preview := h.preview(t, "null_resource.gone")
	if err := os.WriteFile(filepath.Join(h.root, fakeModeFile), []byte("locked"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.execute(preview.PreviewID, "terraform.tfstate"); refusalCode(err) != server.TerraformRemovalRejected {
		t.Fatalf("err = %v", err)
	}
	if string(h.state(t)) != string(original) {
		t.Fatal("state changed on a refused removal")
	}
	if len(h.audit.events) != 2 || h.audit.events[1].Status != "exited" || *h.audit.events[1].ExitCode != 1 {
		t.Fatalf("audit = %#v", h.audit.events)
	}
}

func TestStateRemovalReportsUnverifiedOutcomes(t *testing.T) {
	for _, mode := range []string{"overreach", "concurrent-writer", "fail-after-write"} {
		t.Run(mode, func(t *testing.T) {
			h := newRemovalHarness(t, "")
			original := h.state(t)
			preview := h.preview(t, "null_resource.gone")
			if err := os.WriteFile(filepath.Join(h.root, fakeModeFile), []byte(mode), 0o600); err != nil {
				t.Fatal(err)
			}
			result, err := h.execute(preview.PreviewID, "terraform.tfstate")
			if err != nil {
				t.Fatalf("err = %v, want an unverified result", err)
			}
			if result.Outcome != "unverified" || result.Problem == "" || len(result.Removed) != 0 {
				t.Fatalf("result = %#v", result)
			}
			backup, err := os.ReadFile(filepath.Join(h.root, result.Backup))
			if err != nil || string(backup) != string(original) {
				t.Fatalf("CLIHarbor backup missing or wrong: %v", err)
			}
		})
	}
}

func TestStateRemovalFailsClosedWithoutAudit(t *testing.T) {
	h := newRemovalHarness(t, "")
	original := h.state(t)
	h.audit.fail = true
	preview := h.preview(t, "null_resource.gone")
	if _, err := h.execute(preview.PreviewID, "terraform.tfstate"); refusalCode(err) != server.TerraformRemovalAudit {
		t.Fatalf("err = %v", err)
	}
	h.p.SetAudit(nil)
	preview = h.preview(t, "null_resource.gone")
	if _, err := h.execute(preview.PreviewID, "terraform.tfstate"); refusalCode(err) != server.TerraformRemovalAudit {
		t.Fatalf("nil audit err = %v", err)
	}
	if string(h.state(t)) != string(original) {
		t.Fatal("state changed without an audit record")
	}
	entries, _ := os.ReadDir(h.root)
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".backup") {
			t.Fatalf("backup written before audit approval: %s", entry.Name())
		}
	}
}

func TestStateRemovalRefusesChangedOrMissingExecutable(t *testing.T) {
	h := newRemovalHarness(t, "")
	preview := h.preview(t, "null_resource.gone")
	h.p.ActivateTool(discovery.ToolState{PackID: "terraform-cli", ToolID: "terraform", Status: discovery.StatusMissing})
	if _, err := h.execute(preview.PreviewID, "terraform.tfstate"); refusalCode(err) != server.TerraformRemovalUnavailable {
		t.Fatalf("missing tool err = %v", err)
	}
}

func TestStateRemovalIsSingleFlight(t *testing.T) {
	h := newRemovalHarness(t, "")
	h.p.removalSlot <- struct{}{}
	defer func() { <-h.p.removalSlot }()
	_, err := h.p.PreviewStateRemoval(context.Background(), server.TerraformStateRemovalPreviewRequest{
		ProjectID: "project-1", StateID: h.stateID, Addresses: []string{"null_resource.gone"},
	})
	if refusalCode(err) != server.TerraformRemovalBusy {
		t.Fatalf("err = %v", err)
	}
}

func TestStateRemovalBoundsPendingPreviews(t *testing.T) {
	h := newRemovalHarness(t, "")
	ids := make([]string, 0, maxPendingRemovals+2)
	for i := 0; i < maxPendingRemovals+2; i++ {
		ids = append(ids, h.preview(t, "null_resource.gone").PreviewID)
	}
	if len(h.p.previews) != maxPendingRemovals {
		t.Fatalf("pending previews = %d", len(h.p.previews))
	}
	if _, err := h.execute(ids[len(ids)-1], "terraform.tfstate"); err != nil {
		t.Fatalf("newest preview evicted: %v", err)
	}
}

func TestStateRemovalArgsNeverAllowAddressFlagInjection(t *testing.T) {
	args := stateRemovalArgs("/s/terraform.tfstate", "/s/b.backup", false, []string{"a.b"})
	joined := strings.Join(args, " ")
	if joined != "state rm -backup=/s/b.backup -lock=true -lock-timeout=0s -state=/s/terraform.tfstate -- a.b" {
		t.Fatalf("args = %q", joined)
	}
	if got := reportedAddresses([]byte("\x1b[1mWould remove a\x1b[0m\r\nnoise\nWould remove b[\"x y\"]\n"), "Would remove "); strings.Join(got, "|") != `a|b["x y"]` {
		t.Fatalf("reported = %q", got)
	}
}

// TestStateRemovalWithInstalledTerraform runs the full flow against a real
// Terraform CLI. It skips when Terraform is not installed, so a passing unit
// suite alone is not evidence of real-CLI compatibility.
func TestStateRemovalWithInstalledTerraform(t *testing.T) {
	exe := os.Getenv("CLIHARBOR_TEST_TERRAFORM")
	if exe == "" {
		found, err := exec.LookPath("terraform")
		if err != nil {
			t.Skip("real Terraform executable is not installed (set CLIHARBOR_TEST_TERRAFORM)")
		}
		exe = found
	}
	exe, err := filepath.Abs(exe)
	if err != nil {
		t.Fatal(err)
	}
	fixture := `{"version":4,"terraform_version":"1.5.0","serial":3,"lineage":"11111111-2222-3333-4444-555555555555","outputs":{},"resources":[
{"mode":"managed","type":"null_resource","name":"a","provider":"provider[\"registry.terraform.io/hashicorp/null\"]","instances":[{"schema_version":0,"attributes":{"id":"1","triggers":null}}]},
{"mode":"managed","type":"null_resource","name":"many","provider":"provider[\"registry.terraform.io/hashicorp/null\"]","instances":[{"index_key":"x y","schema_version":0,"attributes":{"id":"2","triggers":null}},{"index_key":"z","schema_version":0,"attributes":{"id":"3","triggers":null}}]},
{"module":"module.m[0]","mode":"managed","type":"null_resource","name":"b","provider":"provider[\"registry.terraform.io/hashicorp/null\"]","instances":[{"schema_version":0,"attributes":{"id":"4","triggers":null}}]}
]}`
	p, stateID := approvedFixture(t, fixture)
	// A backend block in the project must not redirect the command: Terraform
	// runs in a neutral directory with an explicit -state path.
	if err := os.WriteFile(filepath.Join(p.roots[0].path, "main.tf"), []byte("terraform {\n  backend \"s3\" {}\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	activateExecutable(t, p, exe)
	audit := &memoryAudit{}
	p.SetAudit(audit)
	preview, err := p.PreviewStateRemoval(context.Background(), server.TerraformStateRemovalPreviewRequest{
		ProjectID: "project-1", StateID: stateID, Addresses: []string{`null_resource.many["x y"]`, "module.m[0].null_resource.b"},
	})
	if err != nil {
		t.Fatalf("preview with real Terraform: %v", err)
	}
	result, err := p.ExecuteStateRemoval(context.Background(), server.TerraformStateRemovalExecuteRequest{PreviewID: preview.PreviewID, Confirm: "terraform.tfstate"})
	if err != nil {
		t.Fatalf("execute with real Terraform: %v", err)
	}
	if result.Outcome != "removed" || result.Serial <= 3 || result.TerraformBackup == "" {
		t.Fatalf("result = %#v", result)
	}
	backup, err := os.ReadFile(filepath.Join(p.roots[0].path, result.Backup))
	if err != nil || string(backup) != fixture {
		t.Fatalf("CLIHarbor backup is not the exact previewed snapshot: %v", err)
	}
	resources, err := p.Resources("project-1", stateID)
	if err != nil {
		t.Fatal(err)
	}
	remaining := []string{}
	for _, resource := range resources {
		remaining = append(remaining, resource.Address)
	}
	sort.Strings(remaining)
	if strings.Join(remaining, "|") != `null_resource.a|null_resource.many["z"]` {
		t.Fatalf("remaining = %q", remaining)
	}
}
