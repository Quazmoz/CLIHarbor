package audittrail

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

func TestMutationAuditLockPersistsAndReacquires(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit", "trail.jsonl")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path); err == nil {
		t.Fatal("second writer acquired a live mutation audit lock")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	marker, err := os.ReadFile(path + ".lock")
	if err != nil || string(marker) != auditLockMarker {
		t.Fatalf("OS-managed lock marker disappeared: %q, %v", marker, err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatalf("closed OS-managed lock could not be reacquired: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestMutationAuditLegacyLockFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit", "trail.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	legacy := path + ".lock"
	if err := os.WriteFile(legacy, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path); err == nil || !strings.Contains(err.Error(), "legacy mutation audit lock") {
		t.Fatalf("legacy O_EXCL sentinel was accepted: %v", err)
	}
	st, err := os.Stat(legacy)
	if err != nil || st.Size() != 0 {
		t.Fatalf("legacy evidence modified by failed startup: %v, %v", st, err)
	}
	if err := os.Rename(legacy, legacy+".preserved"); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatalf("new OS lock failed after legacy evidence was preserved: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestMutationAuditRejectsInvalidAndRedirectedLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit", "trail.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	lockPath := path + ".lock"
	if err := os.WriteFile(lockPath, []byte("unknown lock version\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path); err == nil || !strings.Contains(err.Error(), "unrecognized mutation audit lock") {
		t.Fatalf("unrecognized lock was accepted: %v", err)
	}
	original, err := os.ReadFile(lockPath)
	if err != nil || string(original) != "unknown lock version\n" {
		t.Fatalf("unrecognized lock evidence modified: %q, %v", original, err)
	}
	if err := os.Remove(lockPath); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside-lock")
	if err := os.WriteFile(outside, []byte(auditLockMarker), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, lockPath); err != nil {
		t.Skipf("symlink unavailable on this host: %v", err)
	}
	if _, err := Open(path); err == nil {
		t.Fatal("redirected mutation audit lock was accepted")
	}
	original, err = os.ReadFile(outside)
	if err != nil || string(original) != auditLockMarker {
		t.Fatalf("redirected lock target was changed: %q, %v", original, err)
	}
}

func TestMutationAuditLockChild(t *testing.T) {
	path := os.Getenv("CLIHARBOR_TEST_AUDIT_LOCK_CHILD")
	if path == "" {
		return
	}
	s, err := Open(path)
	if err != nil {
		t.Fatalf("child acquire: %v", err)
	}
	defer s.Close()
	if err := s.Append(runs.AuditEvent{
		RunID: strings.Repeat("f", 32), Action: "approved", PackID: "fixture",
		CommandID: "fixture-change", Risk: "change", TargetLabel: "Fixture target",
		Target: "fixture/one", Effect: "simulated change", Scope: "single",
	}); err != nil {
		t.Fatalf("child journal sync: %v", err)
	}
	fmt.Println("AUDIT_LOCK_ACQUIRED")
	_, _ = io.Copy(io.Discard, os.Stdin)
}

func TestMutationAuditLockReleasedAfterHardKill(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit", "trail.jsonl")
	command := exec.Command(os.Args[0], "-test.run=^TestMutationAuditLockChild$")
	command.Env = append(os.Environ(), "CLIHARBOR_TEST_AUDIT_LOCK_CHILD="+path)
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = command.Process.Kill()
		_ = command.Wait()
		_ = stdin.Close()
	}()
	ready := make(chan error, 1)
	go func() {
		line, err := bufio.NewReader(stdout).ReadString('\n')
		if err == nil && strings.TrimSpace(line) != "AUDIT_LOCK_ACQUIRED" {
			err = fmt.Errorf("unexpected child readiness: %q", line)
		}
		ready <- err
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatalf("child did not acquire lock: %v; stderr: %s", err, stderr.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("child lock readiness timed out; stderr: %s", stderr.String())
	}
	if _, err := Open(path); err == nil {
		t.Fatal("live child did not exclude concurrent writer")
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err == nil {
		t.Fatal("killed child unexpectedly exited cleanly")
	}
	s, err := Open(path)
	if err != nil {
		t.Fatalf("OS lock was not released after hard kill: %v", err)
	}
	entries := s.List()
	if len(entries) != 1 || entries[0].Action != "approved" || entries[0].RunID != strings.Repeat("f", 32) {
		t.Fatalf("pending mutation evidence was lost or incorrectly completed: %#v", entries)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}
