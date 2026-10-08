// Package audittrail maintains a private, fail-closed, append-only journal of
// approved mutations. It intentionally records metadata, never command I/O.
package audittrail

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/runs"
)

const maxBytes int64 = 16 << 20
const maxEntries = 25000

type Entry struct {
	Sequence     uint64    `json:"sequence"`
	PreviousHash string    `json:"previousHash"`
	Hash         string    `json:"hash"`
	RunID        string    `json:"runId"`
	Time         time.Time `json:"time"`
	Action       string    `json:"action"`
	PackID       string    `json:"packId,omitempty"`
	CommandID    string    `json:"commandId,omitempty"`
	Risk         string    `json:"risk,omitempty"`
	TargetLabel  string    `json:"targetLabel,omitempty"`
	Target       string    `json:"target,omitempty"`
	Effect       string    `json:"effect,omitempty"`
	Scope        string    `json:"scope,omitempty"`
	Status       string    `json:"status,omitempty"`
	ExitCode     *int      `json:"exitCode,omitempty"`
	Undo         string    `json:"undo"`
}

type Store struct {
	mu       sync.Mutex
	file     *os.File
	lock     *os.File
	lockPath string
	entries  []Entry
	seen     map[string]bool
	size     int64
	failed   bool
}

func DefaultPath() (string, error) {
	config, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(config, "CLIHarbor", "audit", "mutation-trail.jsonl"), nil
}

func Open(path string) (*Store, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, errors.New("audit path must be absolute")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create audit directory: %w", err)
	}
	if st, err := os.Lstat(dir); err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 ||
		(runtime.GOOS != "windows" && st.Mode().Perm()&0077 != 0) {
		return nil, errors.New("audit directory must be private and regular")
	}
	if st, err := os.Lstat(path); err == nil {
		if !st.Mode().IsRegular() || st.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("audit trail is not a regular file")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	lockPath := path + ".lock"
	lock, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, fmt.Errorf("audit trail already locked or inaccessible: %w", err)
	}
	fail := func(err error) (*Store, error) {
		_ = lock.Close()
		_ = os.Remove(lockPath)
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		return fail(err)
	}
	stat, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return fail(err)
	}
	if !stat.Mode().IsRegular() || stat.Size() > maxBytes ||
		(runtime.GOOS != "windows" && stat.Mode().Perm()&0077 != 0) {
		_ = file.Close()
		return fail(errors.New("audit trail must be private and below capacity"))
	}
	entries, err := readEntries(file)
	if err != nil {
		_ = file.Close()
		return fail(fmt.Errorf("audit trail integrity check failed: %w", err))
	}
	seen := make(map[string]bool, len(entries))
	for _, e := range entries {
		if e.Action == "approved" {
			seen[e.RunID] = true
		} else {
			seen[e.RunID] = false
		}
	}
	return &Store{file: file, lock: lock, lockPath: lockPath, entries: entries, seen: seen, size: stat.Size()}, nil
}

func readEntries(file *os.File) ([]Entry, error) {
	if _, err := file.Seek(0, 0); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(file)
	entries := make([]Entry, 0)
	seen := make(map[string]bool)
	prev := ""
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		if len(line) == 0 && errors.Is(err, io.EOF) {
			break
		}
		if len(line) == 0 || len(line) > 4096 || line[len(line)-1] != '\n' {
			return nil, errors.New("partial or oversized audit entry")
		}
		var entry Entry
		decoder := json.NewDecoder(bytes.NewReader(line))
		decoder.DisallowUnknownFields()
		if decodeErr := decoder.Decode(&entry); decodeErr != nil {
			return nil, decodeErr
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			return nil, errors.New("audit entry contains trailing content")
		}
		if len(entries) >= maxEntries || entry.Sequence != uint64(len(entries)+1) || entry.PreviousHash != prev ||
			!validEntry(entry) || entry.Hash != calculateHash(entry) {
			return nil, errors.New("audit chain mismatch")
		}
		if entry.Action == "approved" {
			if _, duplicate := seen[entry.RunID]; duplicate {
				return nil, errors.New("duplicate approval record")
			}
			seen[entry.RunID] = true
		} else {
			if !seen[entry.RunID] {
				return nil, errors.New("orphan or duplicate completion")
			}
			seen[entry.RunID] = false
		}
		prev = entry.Hash
		entries = append(entries, entry)
		if err != nil {
			break
		}
	}
	return entries, nil
}

func validEntry(e Entry) bool {
	if len(e.RunID) != 32 || e.Time.IsZero() || e.Undo != "not-available" {
		return false
	}
	for _, ch := range e.RunID {
		if !((ch >= 'a' && ch <= 'f') || (ch >= '0' && ch <= '9')) {
			return false
		}
	}
	if e.Action != "approved" && e.Action != "completed" {
		return false
	}
	if e.Action == "approved" && ((e.Risk != "change" && e.Risk != "destructive") || e.PackID == "" || e.CommandID == "" ||
		e.TargetLabel == "" || e.Effect == "" || (e.Scope != "single" && e.Scope != "multiple") ||
		e.Status != "" || e.ExitCode != nil) {
		return false
	}
	if e.Action == "completed" && (e.Status != "exited" && e.Status != "cancelled" && e.Status != "timed-out" && e.Status != "failed" ||
		e.PackID != "" || e.CommandID != "" || e.Risk != "" || e.TargetLabel != "" || e.Target != "" || e.Effect != "" || e.Scope != "") {
		return false
	}
	for _, value := range []string{e.PackID, e.CommandID, e.Risk, e.TargetLabel, e.Target, e.Effect, e.Scope, e.Status} {
		if len(value) > 2048 {
			return false
		}
		for _, r := range value {
			if r < 32 || r == 127 {
				return false
			}
		}
	}
	return true
}

func calculateHash(e Entry) string {
	e.Hash = ""
	raw, _ := json.Marshal(e)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (s *Store) Append(event runs.AuditEvent) error {
	if s == nil {
		return errors.New("mutation audit not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failed || s.file == nil {
		return errors.New("mutation audit unavailable")
	}
	if len(s.entries) >= maxEntries || s.size >= maxBytes {
		return errors.New("mutation audit at capacity")
	}
	e := Entry{RunID: event.RunID, Time: time.Now().UTC(), Action: event.Action, PackID: event.PackID,
		CommandID: event.CommandID, Risk: event.Risk, TargetLabel: event.TargetLabel, Target: event.Target,
		Effect: event.Effect, Scope: event.Scope, Status: event.Status, ExitCode: event.ExitCode, Undo: "not-available",
		Sequence: uint64(len(s.entries) + 1)}
	if len(s.entries) > 0 {
		e.PreviousHash = s.entries[len(s.entries)-1].Hash
	}
	if !validEntry(e) {
		return errors.New("mutation audit metadata invalid")
	}
	if e.Action == "approved" {
		if _, exists := s.seen[e.RunID]; exists {
			return errors.New("mutation approval already recorded")
		}
	} else if !s.seen[e.RunID] {
		return errors.New("mutation completion has no pending approval")
	}
	e.Hash = calculateHash(e)
	raw, err := json.Marshal(e)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if len(raw) > 4096 || s.size+int64(len(raw)) > maxBytes {
		return errors.New("mutation audit at capacity")
	}
	n, err := s.file.Write(raw)
	if err != nil || n != len(raw) {
		s.failed = true
		return errors.New("mutation audit write failed")
	}
	if err := s.file.Sync(); err != nil {
		s.failed = true
		return errors.New("mutation audit sync failed")
	}
	s.size += int64(n)
	s.entries = append(s.entries, e)
	s.seen[e.RunID] = e.Action == "approved"
	return nil
}

func (s *Store) List() []Entry {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	start := len(s.entries) - 100
	if start < 0 {
		start = 0
	}
	out := make([]Entry, 0, len(s.entries)-start)
	for i := len(s.entries) - 1; i >= start; i-- {
		e := s.entries[i]
		if e.ExitCode != nil {
			n := *e.ExitCode
			e.ExitCode = &n
		}
		out = append(out, e)
	}
	return out
}

func (s *Store) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil {
		return nil
	}
	a := s.file.Close()
	b := s.lock.Close()
	c := os.Remove(s.lockPath)
	s.file = nil
	if a != nil {
		return a
	}
	if b != nil {
		return b
	}
	return c
}
