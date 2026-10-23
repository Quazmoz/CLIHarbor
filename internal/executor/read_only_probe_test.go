package executor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/testsupport/helperproc"
)

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
	executable, argv := helperproc.Command(t, "TestReadOnlyProbeHelperProcess", mode)
	return RunReadOnlyProbe(context.Background(), executable, argv, config)
}

// TestReadOnlyProbeHelperProcess is the fake CLI. Every mode exits explicitly
// through helperproc, so exact stdout assertions never see a "PASS" trailer.
func TestReadOnlyProbeHelperProcess(t *testing.T) {
	helperproc.Dispatch(t, map[string]helperproc.Mode{
		"success": func([]string) int {
			fmt.Fprint(os.Stdout, "probe-stdout\n")
			fmt.Fprint(os.Stderr, "probe-stderr\n")
			return 0
		},
		"nonzero": func([]string) int {
			fmt.Fprint(os.Stdout, "before-exit\n")
			return 7
		},
		"large": func([]string) int {
			fmt.Fprint(os.Stdout, strings.Repeat("x", 4096))
			return 0
		},
		"timeout": func([]string) int {
			time.Sleep(2 * time.Second)
			return 0
		},
		"environment": func([]string) int {
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
			return 0
		},
		"stdin": func([]string) int {
			input, err := io.ReadAll(io.LimitReader(os.Stdin, 1024))
			if err != nil {
				return 93
			}
			fmt.Fprintf(os.Stdout, "stdin-bytes=%d", len(input))
			return 0
		},
		"extra-env": func([]string) int {
			fmt.Fprintf(os.Stdout, "checkpoint=%s", os.Getenv("CHECKPOINT_DISABLE"))
			return 0
		},
		"invalid-utf8": func([]string) int {
			_, _ = os.Stdout.Write([]byte{0xff, 'x'})
			return 0
		},
	})
}

func TestReadOnlyProbeSupportsBoundedExplicitInput(t *testing.T) {
	result, err := runProbeHelper(t, "stdin", ReadOnlyProbeConfig{
		Timeout: 2 * time.Second, MaxOutputBytes: 128, Input: []byte("abcde"),
	})
	if err != nil || result.ExitCode != 0 || string(result.Stdout) != "stdin-bytes=5" {
		t.Fatalf("stdin probe result=%#v, err=%v", result, err)
	}
	if _, err := runProbeHelper(t, "stdin", ReadOnlyProbeConfig{Input: bytes.Repeat([]byte("x"), maxReadOnlyProbeInputBytes+1)}); err == nil {
		t.Fatal("oversized stdin accepted")
	}
}

func TestReadOnlyProbeExtraEnvIsValidatedAndDelivered(t *testing.T) {
	result, err := runProbeHelper(t, "extra-env", ReadOnlyProbeConfig{Timeout: 2 * time.Second, ExtraEnv: []string{"CHECKPOINT_DISABLE=1"}})
	if err != nil || string(result.Stdout) != "checkpoint=1" {
		t.Fatalf("result=%q err=%v", result.Stdout, err)
	}
	for _, entry := range []string{"", "NOVALUE", "=x", "lower=1", "1ST=x", "A-B=1", "A=\x00", "A=" + strings.Repeat("x", 300)} {
		if _, err := runProbeHelper(t, "extra-env", ReadOnlyProbeConfig{ExtraEnv: []string{entry}}); err == nil {
			t.Fatalf("invalid env entry %q accepted", entry)
		}
	}
}
