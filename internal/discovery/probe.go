package discovery

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	semver "github.com/Masterminds/semver/v3"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/processenv"
)

const (
	defaultProbeTimeout = 3 * time.Second
	maxProbeStreamBytes = 16 << 10
)

type ProbeRunner interface {
	Run(ctx context.Context, executablePath string, probe packs.VersionProbe) (string, error)
}

type ExecProbeRunner struct{}

func (ExecProbeRunner) Run(ctx context.Context, executablePath string, probe packs.VersionProbe) (string, error) {
	timeout := defaultProbeTimeout
	if probe.TimeoutMillis > 0 {
		timeout = time.Duration(probe.TimeoutMillis) * time.Millisecond
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	workdir, err := os.MkdirTemp("", "cliharbor-version-probe-")
	if err != nil {
		return "", fmt.Errorf("create version probe working directory")
	}
	defer os.RemoveAll(workdir)

	cmd := exec.CommandContext(probeCtx, executablePath, probe.Args...)
	cmd.Dir = workdir
	cmd.Stdin = nil
	cmd.Env = processenv.Minimal()
	var stdout, stderr boundedBuffer
	stdout.max = maxProbeStreamBytes
	stderr.max = maxProbeStreamBytes
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("version probe timed out")
		}
		if errors.Is(probeCtx.Err(), context.Canceled) {
			return "", context.Canceled
		}
		return "", fmt.Errorf("version probe exited unsuccessfully")
	}
	if stdout.truncated || stderr.truncated {
		return "", fmt.Errorf("version probe output exceeded limit")
	}
	if !utf8.Valid(stdout.buf.Bytes()) || !utf8.Valid(stderr.buf.Bytes()) {
		return "", fmt.Errorf("version probe output was not valid UTF-8")
	}
	return stdout.String() + "\n" + stderr.String(), nil
}

type boundedBuffer struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
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

func (b *boundedBuffer) String() string { return b.buf.String() }

var semverToken = regexp.MustCompile(`(?i)\bv?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\b`)

func parseVersion(parser, output string) (*semver.Version, error) {
	if parser != packs.VersionParserSemverText {
		return nil, fmt.Errorf("unsupported version parser")
	}

	matches := semverToken.FindAllStringSubmatch(output, -1)
	versions := make(map[string]*semver.Version)
	for _, match := range matches {
		version, err := semver.StrictNewVersion(match[1])
		if err != nil {
			continue
		}
		versions[version.String()] = version
	}
	if len(versions) == 0 {
		return nil, fmt.Errorf("version output contained no semantic version")
	}
	if len(versions) > 1 {
		values := make([]string, 0, len(versions))
		for value := range versions {
			values = append(values, value)
		}
		sort.Strings(values)
		return nil, fmt.Errorf("version output was ambiguous: %s", strings.Join(values, ", "))
	}
	for _, version := range versions {
		return version, nil
	}
	panic("unreachable")
}
