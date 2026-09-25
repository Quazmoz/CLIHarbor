package executor

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

const probeHelperMarker = "--cliharbor-readonly-probe-helper"

func TestReadOnlyProbePreservesStreamsAndExitCode(t *testing.T) {
	result, err := runProbeHelper(t, "success", ReadOnlyProbeConfig{Timeout: 2 * time.Second, MaxOutputBytes: 8 << 10})
	if err != nil {
		t.Fatalf("RunReadOnlyProbe() error = %v", err)
	}
	if result.ExitCode != 0 || result.TimedOut || result.Cancelled || result.Truncated {
		t.Fatalf("result = %#v", result)
	}
	if !bytes.Contains(result.Stdout, []byte("probe-stdout")) || !bytes.Contains(result.Stderr, []byte("probe-stderr")) {
		t.Fatalf("stdout/stderr = %q / %q", result.Stdout, result.Stderr)
	}
}

func TestReadOnlyProbePreservesNonzeroExit(t *testing.T) {
	result, err := runProbeHelper(t, "nonzero", ReadOnlyProbeConfig{Timeout: 2 * time.Second, MaxOutputBytes: 8 << 10})
	if err != nil {
		t.Fatalf("RunReadOnlyProbe() error = %v", err)
	}
	if result.ExitCode != 7 || result.TimedOut || result.Cancelled {
		t.Fatalf("result = %#v, want exit 7", result)
	}
}

func TestReadOnlyProbeBoundsOversizedOutput(t *testing.T) {
	result, err := runProbeHelper(t, "large", ReadOnlyProbeConfig{Timeout: 2 * time.Second, MaxOutputBytes: 128})
	if err != nil {
		t.Fatalf("RunReadOnlyProbe() error = %v", err)
	}
	if !result.Truncated || len(result.Stdout) != 128 {
		t.Fatalf("truncated/len = %t/%d, want true/128", result.Truncated, len(result.Stdout))
	}
}

func TestReadOnlyProbeTimeoutIsBounded(t *testing.T) {
	start := time.Now()
	result, err := runProbeHelper(t, "timeout", ReadOnlyProbeConfig{Timeout: 100 * time.Millisecond, MaxOutputBytes: 8 << 10})
	if err != nil {
		t.Fatalf("RunReadOnlyProbe() error = %v", err)
	}
	if !result.TimedOut {
		t.Fatalf("result = %#v, want timeout", result)
	}
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Fatalf("probe cancellation took %s", elapsed)
	}
}

func TestReadOnlyProbeDoesNotPassArbitraryParentEnvironment(t *testing.T) {
	t.Setenv("CLIHARBOR_TEST_SECRET", "should-not-reach-child")
	result, err := runProbeHelper(t, "environment", ReadOnlyProbeConfig{Timeout: 2 * time.Second, MaxOutputBytes: 8 << 10})
	if err != nil {
		t.Fatalf("RunReadOnlyProbe() error = %v", err)
	}
	if bytes.Contains(result.Stdout, []byte("should-not-reach-child")) ||
		!bytes.Contains(result.Stdout, []byte("secret-absent")) ||
		!bytes.Contains(result.Stdout, []byte("home-present")) {
		t.Fatalf("probe environment was not isolated with a usable neutral home: %q", result.Stdout)
	}
}

func TestReadOnlyProbePreservesInvalidUTF8ForCallerSanitization(t *testing.T) {
	result, err := runProbeHelper(t, "invalid-utf8", ReadOnlyProbeConfig{Timeout: 2 * time.Second, MaxOutputBytes: 8 << 10})
	if err != nil {
		t.Fatalf("RunReadOnlyProbe() error = %v", err)
	}
	if len(result.Stdout) < 2 || result.Stdout[0] != 0xff {
		t.Fatalf("stdout = %v, want invalid UTF-8 evidence preserved", result.Stdout)
	}
}

func runProbeHelper(t *testing.T, mode string, config ReadOnlyProbeConfig) (ReadOnlyProbeResult, error) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return RunReadOnlyProbe(context.Background(), executable, []string{
		"-test.run=^TestReadOnlyProbeHelperProcess$", "--", probeHelperMarker, mode,
	}, config)
}

func TestReadOnlyProbeHelperProcess(t *testing.T) {
	index := -1
	for i, arg := range os.Args {
		if arg == probeHelperMarker {
			index = i
			break
		}
	}
	if index < 0 {
		return
	}
	if index+1 >= len(os.Args) {
		os.Exit(91)
	}
	switch os.Args[index+1] {
	case "success":
		fmt.Fprint(os.Stdout, "probe-stdout\n")
		fmt.Fprint(os.Stderr, "probe-stderr\n")
	case "nonzero":
		fmt.Fprint(os.Stdout, "before-exit\n")
		os.Exit(7)
	case "large":
		fmt.Fprint(os.Stdout, strings.Repeat("x", 4096))
	case "timeout":
		time.Sleep(2 * time.Second)
	case "environment":
		if value := os.Getenv("CLIHARBOR_TEST_SECRET"); value != "" {
			fmt.Fprintln(os.Stdout, value)
		} else {
			fmt.Fprintln(os.Stdout, "secret-absent")
		}
		if home, homeErr := os.UserHomeDir(); homeErr != nil || home == "" {
			fmt.Fprint(os.Stdout, "home-missing")
		} else {
			fmt.Fprint(os.Stdout, "home-present")
		}
	case "invalid-utf8":
		_, _ = os.Stdout.Write([]byte{0xff, 'x'})
	default:
		os.Exit(92)
	}
}
