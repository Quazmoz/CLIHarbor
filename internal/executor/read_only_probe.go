package executor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	defaultReadOnlyProbeTimeout = 3 * time.Second
	maxReadOnlyProbeTimeout     = 10 * time.Second
	defaultReadOnlyProbeBytes   = 64 << 10
	maxReadOnlyProbeBytes       = 64 << 10
	readOnlyProbeWaitDelay      = 2 * time.Second
)

// ReadOnlyProbeConfig bounds operator-invoked evidence probes. Callers must
// source executablePath and args only from trusted backend-owned declarations.
type ReadOnlyProbeConfig struct {
	Timeout        time.Duration
	MaxOutputBytes int
}

// ReadOnlyProbeResult preserves process evidence without interpreting command
// semantics. Stdout and stderr are independently bounded.
type ReadOnlyProbeResult struct {
	Stdout    []byte
	Stderr    []byte
	ExitCode  int
	TimedOut  bool
	Cancelled bool
	Truncated bool
	StartedAt time.Time
	EndedAt   time.Time
}

// RunReadOnlyProbe directly executes one already-authorized executable plus a
// fixed argv. It never invokes a shell, never supplies interactive stdin, uses
// a neutral temporary working directory, and reuses the platform process-tree
// controller used by normal CLIHarbor execution.
func RunReadOnlyProbe(ctx context.Context, executablePath string, args []string, config ReadOnlyProbeConfig) (ReadOnlyProbeResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if !filepath.IsAbs(executablePath) {
		return ReadOnlyProbeResult{}, fmt.Errorf("probe executable path must be absolute")
	}
	if strings.ContainsRune(executablePath, '\x00') {
		return ReadOnlyProbeResult{}, fmt.Errorf("probe executable path contains NUL")
	}
	for _, arg := range args {
		if strings.ContainsRune(arg, '\x00') {
			return ReadOnlyProbeResult{}, fmt.Errorf("probe argument contains NUL")
		}
	}

	timeout := config.Timeout
	if timeout <= 0 {
		timeout = defaultReadOnlyProbeTimeout
	}
	if timeout > maxReadOnlyProbeTimeout {
		return ReadOnlyProbeResult{}, fmt.Errorf("probe timeout exceeds %s", maxReadOnlyProbeTimeout)
	}
	maxBytes := config.MaxOutputBytes
	if maxBytes <= 0 {
		maxBytes = defaultReadOnlyProbeBytes
	}
	if maxBytes > maxReadOnlyProbeBytes {
		return ReadOnlyProbeResult{}, fmt.Errorf("probe output limit exceeds %d bytes", maxReadOnlyProbeBytes)
	}

	workdir, err := os.MkdirTemp("", "cliharbor-probe-")
	if err != nil {
		return ReadOnlyProbeResult{}, fmt.Errorf("create probe working directory: %w", err)
	}
	defer os.RemoveAll(workdir)

	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	controller, err := newProcessController()
	if err != nil {
		return ReadOnlyProbeResult{}, fmt.Errorf("create probe process controller: %w", err)
	}
	defer controller.close()

	cmd := exec.CommandContext(probeCtx, executablePath, args...)
	cmd.Dir = workdir
	cmd.Stdin = nil
	cmd.Env = readOnlyProbeEnvironment()
	cmd.WaitDelay = readOnlyProbeWaitDelay
	cmd.Cancel = func() error { return controller.cancel(cmd) }
	if err := controller.configure(cmd); err != nil {
		return ReadOnlyProbeResult{}, fmt.Errorf("configure probe process: %w", err)
	}

	stdout := &probeBuffer{max: maxBytes}
	stderr := &probeBuffer{max: maxBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	result := ReadOnlyProbeResult{ExitCode: -1, StartedAt: time.Now().UTC()}
	if err := cmd.Start(); err != nil {
		result.EndedAt = time.Now().UTC()
		return result, fmt.Errorf("start probe process: %w", err)
	}
	if err := controller.afterStart(cmd); err != nil {
		_ = controller.cancel(cmd)
		_ = cmd.Wait()
		result.EndedAt = time.Now().UTC()
		return result, fmt.Errorf("establish probe process ownership: %w", err)
	}

	waitErr := cmd.Wait()
	result.EndedAt = time.Now().UTC()
	result.Stdout = append([]byte(nil), stdout.Bytes()...)
	result.Stderr = append([]byte(nil), stderr.Bytes()...)
	result.Truncated = stdout.truncated || stderr.truncated
	if cmd.ProcessState != nil {
		result.ExitCode = cmd.ProcessState.ExitCode()
	}

	if waitErr == nil {
		return result, nil
	}
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		switch {
		case errors.Is(probeCtx.Err(), context.DeadlineExceeded):
			result.TimedOut = true
		case errors.Is(ctx.Err(), context.Canceled):
			result.Cancelled = true
		}
		return result, nil
	}
	return result, fmt.Errorf("wait for probe process: %w", waitErr)
}

type probeBuffer struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (b *probeBuffer) Write(p []byte) (int, error) {
	original := len(p)
	remaining := b.max - b.buf.Len()
	if remaining <= 0 {
		b.truncated = true
		return original, nil
	}
	if len(p) > remaining {
		_, _ = b.buf.Write(p[:remaining])
		b.truncated = true
		return original, nil
	}
	_, _ = b.buf.Write(p)
	return original, nil
}

func (b *probeBuffer) Bytes() []byte { return b.buf.Bytes() }


func readOnlyProbeEnvironment() []string {
	names := []string{"LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"}
	if runtime.GOOS == "windows" {
		names = []string{"SystemRoot", "WINDIR", "TEMP", "TMP"}
	}
	env := make([]string, 0, len(names))
	for _, name := range names {
		if value, ok := os.LookupEnv(name); ok && value != "" {
			env = append(env, name+"="+value)
		}
	}
	return env
}
