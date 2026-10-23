package terraform

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/executor"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

// State removal ("forget") contract, enforced here rather than in the browser:
//
//   - Only the official, version-qualified, identity-checked Terraform CLI
//     mutates state (`terraform state rm`). CLIHarbor never edits state JSON.
//   - Only addresses present in a pinned snapshot of a startup-approved
//     direct-child .tfstate file can be named.
//   - A successful `-dry-run` that lists exactly those addresses is a
//     precondition. It mints a one-use, time-limited preview bound to the file
//     identity, SHA-256, address set and executable identity.
//   - Execution consumes the preview once, requires the state to be
//     byte-identical to the preview, records an audit approval first (fail
//     closed), writes and verifies a CLIHarbor backup before Terraform starts,
//     and runs with Terraform's lock (-lock=true, -lock-timeout=0s).
//   - A post-check proves the new state is the old one minus exactly those
//     addresses (same lineage, higher serial) and that Terraform's own backup
//     describes the previewed snapshot (same lineage, serial and address set),
//     i.e. no other Terraform writer changed the file between the last check
//     and Terraform's read. Anything else is
//     reported as "unverified", with both backup names. There is no automatic
//     retry or restore.
//
// Terraform runs in a neutral temporary directory with a minimal environment,
// so the project's backend configuration, TF_CLI_ARGS* and TF_DATA_DIR cannot
// redirect or extend the command.

const (
	removalPreviewTTL     = 5 * time.Minute
	maxPendingRemovals    = 8
	removalCommandTimeout = 10 * time.Second
	removalOutputBytes    = 64 << 10
	maxRemovalAddresses   = 50
)

var (
	ansiEscape       = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
	terraformEnvVars = []string{"CHECKPOINT_DISABLE=1", "TF_IN_AUTOMATION=1", "TF_INPUT=0"}
)

type removalPreview struct {
	projectID string
	stateID   string
	stateName string
	rootPath  string
	addresses []string
	digest    [sha256.Size]byte
	identity  os.FileInfo
	serial    int64
	lineage   string
	toolPath  string
	toolHash  [sha256.Size]byte
	expires   time.Time
}

func refuse(code server.TerraformStateRemovalErrorCode) error {
	return &server.TerraformStateRemovalError{Code: code}
}

// SetAudit wires the mutation audit journal. Without it, execution refuses.
func (p *Platform) SetAudit(sink runs.AuditSink) {
	p.removalMu.Lock()
	p.audit = sink
	p.removalMu.Unlock()
}

func (p *Platform) readyTool() (discovery.ToolState, error) {
	p.mu.RLock()
	tool := p.tool
	p.mu.RUnlock()
	if tool.Status != discovery.StatusReady || !tool.ExecutableIdentity.Valid() || tool.Path == "" {
		return tool, refuse(server.TerraformRemovalUnavailable)
	}
	if !tool.ExecutableIdentity.Matches(tool.Path) {
		return tool, refuse(server.TerraformRemovalToolChanged)
	}
	return tool, nil
}

func (p *Platform) acquireRemovalSlot() (func(), error) {
	select {
	case p.removalSlot <- struct{}{}:
		return func() { <-p.removalSlot }, nil
	default:
		return nil, refuse(server.TerraformRemovalBusy)
	}
}

func normalizedAddresses(addresses []string) ([]string, bool) {
	if len(addresses) == 0 || len(addresses) > maxRemovalAddresses {
		return nil, false
	}
	result := append([]string(nil), addresses...)
	sort.Strings(result)
	for i, address := range result {
		if address == "" || strings.HasPrefix(address, "-") || (i > 0 && result[i-1] == address) {
			return nil, false
		}
	}
	return result, true
}

func stateRemovalArgs(statePath string, backupPath string, dryRun bool, addresses []string) []string {
	args := []string{"state", "rm"}
	if dryRun {
		args = append(args, "-dry-run")
	} else {
		args = append(args, "-backup="+backupPath)
	}
	args = append(args, "-lock=true", "-lock-timeout=0s", "-state="+statePath, "--")
	return append(args, addresses...)
}

// reportedAddresses extracts "<prefix><address>" lines from bounded stdout.
func reportedAddresses(stdout []byte, prefix string) []string {
	var result []string
	scanner := bufio.NewScanner(bytes.NewReader(ansiEscape.ReplaceAll(stdout, nil)))
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if address, ok := strings.CutPrefix(line, prefix); ok {
			result = append(result, address)
		}
	}
	sort.Strings(result)
	return result
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func randomHex(n int) (string, error) {
	raw := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

func previewKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// PreviewStateRemoval runs Terraform's dry-run against a pinned snapshot and
// mints a one-use preview. It never changes the state file.
func (p *Platform) PreviewStateRemoval(ctx context.Context, request server.TerraformStateRemovalPreviewRequest) (server.TerraformStateRemovalPreview, error) {
	var empty server.TerraformStateRemovalPreview
	addresses, ok := normalizedAddresses(request.Addresses)
	if !ok {
		return empty, refuse(server.TerraformRemovalInvalid)
	}
	release, err := p.acquireRemovalSlot()
	if err != nil {
		return empty, err
	}
	defer release()

	root, name, err := p.selectState(request.ProjectID, request.StateID)
	if err != nil {
		return empty, refuse(server.TerraformRemovalStale)
	}
	tool, err := p.readyTool()
	if err != nil {
		return empty, err
	}
	dir, err := openApprovedRoot(root)
	if err != nil {
		return empty, refuse(server.TerraformRemovalStale)
	}
	defer dir.Close()
	payload, identity, err := readStateFile(dir, name)
	if err != nil {
		return empty, refuse(server.TerraformRemovalStale)
	}
	inventory, err := parseInventory(payload)
	if err != nil || inventory.serial < 0 || inventory.lineage == "" {
		return empty, refuse(server.TerraformRemovalStale)
	}
	for _, address := range addresses {
		if !inventory.addresses[address] {
			return empty, refuse(server.TerraformRemovalInvalid)
		}
	}

	statePath := filepath.Join(root.path, name)
	result, runErr := executor.RunReadOnlyProbe(ctx, tool.Path, stateRemovalArgs(statePath, "", true, addresses),
		executor.ReadOnlyProbeConfig{Timeout: removalCommandTimeout, MaxOutputBytes: removalOutputBytes, ExtraEnv: terraformEnvVars})
	if !tool.ExecutableIdentity.Matches(tool.Path) {
		return empty, refuse(server.TerraformRemovalToolChanged)
	}
	if runErr != nil || result.ExitCode != 0 || result.TimedOut || result.Cancelled || result.Truncated ||
		!equalStrings(reportedAddresses(result.Stdout, "Would remove "), addresses) {
		return empty, refuse(server.TerraformRemovalRejected)
	}
	// A dry run must leave the snapshot untouched; anything else is a
	// concurrent writer and the preview would describe the wrong state.
	after, afterIdentity, err := readStateFile(dir, name)
	if err != nil || !sameSnapshotIdentity(identity, afterIdentity) || sha256.Sum256(after) != sha256.Sum256(payload) {
		return empty, refuse(server.TerraformRemovalStale)
	}

	token := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, token); err != nil {
		return empty, refuse(server.TerraformRemovalUnavailable)
	}
	previewID := base64.RawURLEncoding.EncodeToString(token)
	now := p.now()
	preview := &removalPreview{
		projectID: request.ProjectID, stateID: request.StateID, stateName: name, rootPath: root.path,
		addresses: addresses, digest: sha256.Sum256(payload), identity: identity,
		serial: inventory.serial, lineage: inventory.lineage,
		toolPath: tool.Path, toolHash: tool.ExecutableIdentity.ContentSHA256(),
		expires: now.Add(removalPreviewTTL),
	}
	p.removalMu.Lock()
	for key, pending := range p.previews {
		if !now.Before(pending.expires) {
			delete(p.previews, key)
		}
	}
	for len(p.previews) >= maxPendingRemovals {
		var oldestKey string
		for key, pending := range p.previews {
			if oldestKey == "" || pending.expires.Before(p.previews[oldestKey].expires) {
				oldestKey = key
			}
		}
		delete(p.previews, oldestKey)
	}
	p.previews[previewKey(previewID)] = preview
	p.removalMu.Unlock()

	return server.TerraformStateRemovalPreview{
		PreviewID: previewID, ProjectID: request.ProjectID, StateID: request.StateID, StateName: name,
		Addresses: append([]string(nil), addresses...), Serial: inventory.serial,
		TerraformVersion: tool.Version, ExpiresAt: preview.expires.UTC().Format(time.RFC3339),
	}, nil
}

func (p *Platform) consumePreview(previewID string) (*removalPreview, runs.AuditSink) {
	key := previewKey(previewID)
	p.removalMu.Lock()
	defer p.removalMu.Unlock()
	preview := p.previews[key]
	delete(p.previews, key)
	if preview == nil || !p.now().Before(preview.expires) {
		return nil, p.audit
	}
	return preview, p.audit
}

// ExecuteStateRemoval consumes a preview exactly once and performs the
// removal only against the byte-identical previewed snapshot.
func (p *Platform) ExecuteStateRemoval(ctx context.Context, request server.TerraformStateRemovalExecuteRequest) (server.TerraformStateRemovalResult, error) {
	var empty server.TerraformStateRemovalResult
	release, err := p.acquireRemovalSlot()
	if err != nil {
		return empty, err
	}
	defer release()

	preview, audit := p.consumePreview(request.PreviewID)
	if preview == nil {
		return empty, refuse(server.TerraformRemovalStale)
	}
	if subtle.ConstantTimeCompare([]byte(request.Confirm), []byte(preview.stateName)) != 1 {
		return empty, refuse(server.TerraformRemovalInvalid)
	}
	if audit == nil {
		return empty, refuse(server.TerraformRemovalAudit)
	}
	root, name, err := p.selectState(preview.projectID, preview.stateID)
	if err != nil || name != preview.stateName || root.path != preview.rootPath {
		return empty, refuse(server.TerraformRemovalStale)
	}
	tool, err := p.readyTool()
	if err != nil {
		return empty, err
	}
	if tool.Path != preview.toolPath || tool.ExecutableIdentity.ContentSHA256() != preview.toolHash {
		return empty, refuse(server.TerraformRemovalToolChanged)
	}
	dir, err := openApprovedRoot(root)
	if err != nil {
		return empty, refuse(server.TerraformRemovalStale)
	}
	defer dir.Close()
	payload, identity, err := readStateFile(dir, name)
	if err != nil || !sameSnapshotIdentity(preview.identity, identity) || sha256.Sum256(payload) != preview.digest {
		return empty, refuse(server.TerraformRemovalStale)
	}
	before, err := parseInventory(payload)
	if err != nil {
		return empty, refuse(server.TerraformRemovalStale)
	}

	runID, err := randomHex(16)
	if err != nil {
		return empty, refuse(server.TerraformRemovalUnavailable)
	}
	if err := audit.Append(removalAuditApproval(runID, root, name, preview.addresses)); err != nil {
		return empty, refuse(server.TerraformRemovalAudit)
	}
	complete := func(status string, exitCode *int) {
		_ = audit.Append(runs.AuditEvent{RunID: runID, Action: "completed", Status: status, ExitCode: exitCode})
	}

	stamp := p.now().UTC().Format("20060102T150405Z")
	suffix, err := randomHex(4)
	if err != nil {
		complete("failed", nil)
		return empty, refuse(server.TerraformRemovalUnavailable)
	}
	backupName := name + ".cliharbor-" + stamp + "-" + suffix + ".backup"
	terraformBackupName := name + ".terraform-" + stamp + "-" + suffix + ".backup"
	if err := writeVerifiedBackup(dir, backupName, payload, preview.digest); err != nil {
		complete("failed", nil)
		return empty, refuse(server.TerraformRemovalRejected)
	}

	// Last identity check before Terraform takes its own lock.
	if _, current, err := readStateFile(dir, name); err != nil || !sameSnapshotIdentity(identity, current) ||
		!tool.ExecutableIdentity.Matches(tool.Path) {
		complete("failed", nil)
		return empty, refuse(server.TerraformRemovalStale)
	}

	result, runErr := executor.RunReadOnlyProbe(ctx, tool.Path,
		stateRemovalArgs(filepath.Join(root.path, name), filepath.Join(root.path, terraformBackupName), false, preview.addresses),
		executor.ReadOnlyProbeConfig{Timeout: removalCommandTimeout, MaxOutputBytes: removalOutputBytes, ExtraEnv: terraformEnvVars})

	outcome := server.TerraformStateRemovalResult{
		Outcome: "unverified", ProjectID: preview.projectID, StateID: preview.stateID, StateName: name,
		Removed: []string{}, Serial: before.serial, Backup: backupName, CompletedAt: p.now().UTC().Format(time.RFC3339),
	}
	exitCode := result.ExitCode
	status := "exited"
	switch {
	case runErr != nil:
		status = "failed"
	case result.TimedOut:
		status = "timed-out"
	case result.Cancelled:
		status = "cancelled"
	}

	afterPayload, _, afterErr := readStateFile(dir, name)
	unchanged := afterErr == nil && sha256.Sum256(afterPayload) == preview.digest
	if status != "exited" || exitCode != 0 {
		if status == "exited" {
			complete(status, &exitCode)
		} else {
			complete(status, nil)
		}
		if unchanged {
			// Terraform refused (lock held, version mismatch, ...) and the
			// state is provably untouched. Our verified backup stays as
			// harmless evidence.
			return empty, refuse(server.TerraformRemovalRejected)
		}
		outcome.Problem = "Terraform did not finish cleanly and the state file changed. Compare it with the backups before doing anything else."
		return outcome, nil
	}
	complete(status, &exitCode)

	if _, err := dir.Lstat(terraformBackupName); err == nil {
		outcome.TerraformBackup = terraformBackupName
	}
	problem := verifyRemoval(dir, before, preview, afterPayload, afterErr, terraformBackupName)
	if _, err := p.root(preview.projectID); err != nil {
		problem = "The approved project directory changed during removal."
	}
	if problem != "" {
		outcome.Problem = problem
		if afterErr == nil {
			if inventory, err := parseInventory(afterPayload); err == nil {
				outcome.Serial = inventory.serial
			}
		}
		return outcome, nil
	}
	after, _ := parseInventory(afterPayload)
	outcome.Outcome = "removed"
	outcome.Removed = append([]string(nil), preview.addresses...)
	outcome.Serial = after.serial
	return outcome, nil
}

// verifyRemoval returns "" only when the new state equals the previewed one
// minus exactly the previewed addresses, and Terraform's backup proves it read
// the previewed bytes.
func verifyRemoval(dir *os.Root, before stateInventory, preview *removalPreview, afterPayload []byte, afterErr error, terraformBackupName string) string {
	if afterErr != nil {
		return "The state file could not be re-read after removal."
	}
	after, err := parseInventory(afterPayload)
	if err != nil {
		return "The new state file could not be parsed."
	}
	if after.lineage != before.lineage || after.serial <= before.serial {
		return "The new state has an unexpected lineage or serial."
	}
	removed := make(map[string]bool, len(preview.addresses))
	for _, address := range preview.addresses {
		removed[address] = true
	}
	expected := 0
	for address := range before.addresses {
		if removed[address] {
			if after.addresses[address] {
				return "A previewed address is still present in the state."
			}
			continue
		}
		if !after.addresses[address] {
			return "An address that was not previewed is missing from the new state."
		}
		expected++
	}
	if len(after.addresses) != expected {
		return "The new state contains addresses that were not in the previewed snapshot."
	}
	// Terraform re-serializes the state it read into its backup, so compare
	// meaning rather than bytes: same lineage, same serial and same address
	// set as the previewed snapshot. Every Terraform writer bumps the serial,
	// so a concurrent Terraform run between our last check and its read shows
	// up here.
	backupPayload, _, err := readStateFile(dir, terraformBackupName)
	if err != nil {
		return "Terraform's backup is missing, so CLIHarbor cannot prove which state it changed."
	}
	backup, err := parseInventory(backupPayload)
	if err != nil || backup.lineage != before.lineage || backup.serial != before.serial || len(backup.addresses) != len(before.addresses) {
		return "Terraform's backup does not match the previewed snapshot, so another writer may have changed the state."
	}
	for address := range before.addresses {
		if !backup.addresses[address] {
			return "Terraform's backup does not match the previewed snapshot, so another writer may have changed the state."
		}
	}
	return ""
}

func writeVerifiedBackup(dir *os.Root, name string, payload []byte, digest [sha256.Size]byte) error {
	file, err := dir.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(payload); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	written, _, err := readStateFile(dir, name)
	if err != nil || sha256.Sum256(written) != digest {
		return errors.New("backup verification failed")
	}
	return nil
}

func removalAuditApproval(runID string, root approvedRoot, stateName string, addresses []string) runs.AuditEvent {
	target := strings.Join(addresses, ", ")
	if len(target) > 2000 {
		target = strconv.Itoa(len(addresses)) + " resource instances"
	}
	scope := "single"
	if len(addresses) > 1 {
		scope = "multiple"
	}
	label := filepath.Base(root.path) + "/" + stateName
	if len(label) > 512 {
		label = stateName
	}
	return runs.AuditEvent{
		RunID: runID, Action: "approved", PackID: "terraform-cli", CommandID: "state-rm", Risk: "destructive",
		TargetLabel: label, Target: target, Scope: scope,
		Effect: "Forget " + strconv.Itoa(len(addresses)) + " resource instance(s) from local Terraform state. Real infrastructure is not destroyed.",
	}
}
