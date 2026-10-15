package audittrail

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

func TestDurableAuditChainAndTampering(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit", "trail.jsonl")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	event := runs.AuditEvent{RunID: strings.Repeat("a", 32), Action: "approved", PackID: "conjur", CommandID: "secret-delete", Risk: "destructive", TargetLabel: "Variable ID", Target: "apps/test/key", Effect: "Deletes variable", Scope: "single"}
	if err := store.Append(event); err != nil {
		t.Fatal(err)
	}
	if err := store.Append(runs.AuditEvent{RunID: event.RunID, Action: "completed", Status: "exited"}); err != nil {
		t.Fatal(err)
	}
	if len(store.List()) != 2 || store.List()[0].Status != "exited" {
		t.Fatal("out-of-order or absent audit")
	}
	if _, err := Open(path); err == nil {
		t.Fatal("concurrent writer admitted")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.List()) != 2 {
		t.Fatal("lost audit on restart")
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	raw[35] ^= 1
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path); err == nil {
		t.Fatal("tampered audit admitted")
	}
}
func TestAuditRejectsUnsafeDataAndPartialAppend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit", "trail")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.Append(runs.AuditEvent{RunID: strings.Repeat("a", 32), Action: "approved", Risk: "destructive", PackID: "p", CommandID: "c", TargetLabel: "target", Target: "bad\nvalue", Scope: "single"}); err == nil {
		t.Fatal("multiline target admitted")
	}
	if len(s.List()) != 0 {
		t.Fatal("invalid event persisted")
	}
	if err := s.Append(runs.AuditEvent{RunID: strings.Repeat("b", 32), Action: "completed", Status: "exited"}); err == nil {
		t.Fatal("orphan completion admitted")
	}
	approved := runs.AuditEvent{RunID: strings.Repeat("a", 32), Action: "approved", Risk: "change", PackID: "p", CommandID: "c", TargetLabel: "ID", Target: "target", Effect: "changes object", Scope: "single"}
	if err := s.Append(approved); err != nil {
		t.Fatal(err)
	}
	if err := s.Append(approved); err == nil {
		t.Fatal("duplicate approval admitted")
	}
	if err := s.Append(runs.AuditEvent{RunID: approved.RunID, Action: "completed", Status: "exited"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Append(runs.AuditEvent{RunID: approved.RunID, Action: "completed", Status: "exited"}); err == nil {
		t.Fatal("duplicate completion admitted")
	}
}

// Recovery must never touch intact evidence, never run beside a live instance,
// and must keep a corrupt journal byte-for-byte while letting a new chain start.
func TestQuarantinePreservesOnlyCorruptJournals(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit", "mutation-trail.jsonl")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Append(runs.AuditEvent{RunID: strings.Repeat("a", 32), Action: "approved", PackID: "p", CommandID: "c", Risk: "change", TargetLabel: "ID", Target: "t", Effect: "changes", Scope: "single"}); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 15, 10, 0, 0, 0, time.UTC)
	if _, _, err := Quarantine(path, now); err == nil {
		t.Fatal("quarantined a journal held by a running instance")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if n, err := Verify(path); err != nil || n != 1 {
		t.Fatalf("Verify intact = %d, %v", n, err)
	}
	if _, _, err := Quarantine(path, now); err == nil {
		t.Fatal("quarantined an intact journal")
	}

	raw, _ := os.ReadFile(path)
	corrupt := append(raw[:len(raw)-1:len(raw)-1], []byte("garbage")...) // partial final entry
	if err := os.WriteFile(path, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path); !errors.Is(err, ErrIntegrity) {
		t.Fatalf("Open corrupt = %v, want ErrIntegrity", err)
	}
	if _, err := Verify(path); !errors.Is(err, ErrIntegrity) {
		t.Fatalf("Verify corrupt = %v, want ErrIntegrity", err)
	}
	preserved, digest, err := Quarantine(path, now)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(preserved); !bytes.Equal(got, corrupt) {
		t.Fatal("quarantined evidence was altered")
	}
	if sum := sha256.Sum256(corrupt); digest != hex.EncodeToString(sum[:]) {
		t.Fatalf("digest = %s", digest)
	}
	// Same timestamp again must not replace the preserved file.
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Quarantine(path, now); err == nil {
		t.Fatal("quarantine replaced an existing preserved journal")
	}
	if got, _ := os.ReadFile(preserved); !bytes.Equal(got, corrupt) {
		t.Fatal("preserved evidence changed by a colliding quarantine")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	fresh, err := Open(path)
	if err != nil {
		t.Fatalf("new chain after quarantine: %v", err)
	}
	_ = fresh.Close()
}
