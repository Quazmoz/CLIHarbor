package discovery

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

const versionProbeHelperMarker = "--cliharbor-version-probe-helper"

func TestExecProbeRunnerUsesNeutralCWDAndMinimalEnvironment(t *testing.T) {
	t.Setenv("CLIHARBOR_VERSION_PROBE_SECRET", "must-not-reach-child")
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	output, err := (ExecProbeRunner{}).Run(context.Background(), executable, packs.VersionProbe{
		Args: []string{
			"-test.run=^TestVersionProbeHelperProcess$",
			"--",
			versionProbeHelperMarker,
			"environment",
		},
		Parser:        packs.VersionParserSemverText,
		TimeoutMillis: 2000,
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if strings.Contains(output, "must-not-reach-child") {
		t.Fatalf("version probe inherited parent secret: %q", output)
	}
	if strings.Contains(output, cwd) {
		t.Fatalf("version probe inherited caller working directory: %q", output)
	}
	if !strings.Contains(output, "secret-absent") || !strings.Contains(output, "home-present") || !strings.Contains(output, "1.2.3") {
		t.Fatalf("version probe output = %q", output)
	}
}

func TestExecProbeRunnerFailsClosedOnOversizedOutput(t *testing.T) {
	_, err := runVersionProbeHelper(t, "oversized")
	if err == nil || !strings.Contains(err.Error(), "exceeded limit") {
		t.Fatalf("Run() error = %v, want output limit failure", err)
	}
}

func TestExecProbeRunnerFailsClosedOnInvalidUTF8(t *testing.T) {
	_, err := runVersionProbeHelper(t, "invalid-utf8")
	if err == nil || !strings.Contains(err.Error(), "valid UTF-8") {
		t.Fatalf("Run() error = %v, want invalid UTF-8 failure", err)
	}
}

func TestExecProbeRunnerTimeoutDoesNotExposeOutput(t *testing.T) {
	start := time.Now()
	output, err := runVersionProbeHelperWithTimeout(t, "timeout", 100)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("Run() error = %v, want timeout", err)
	}
	if output != "" {
		t.Fatalf("timeout exposed probe output: %q", output)
	}
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Fatalf("timeout took %s", elapsed)
	}
}

func runVersionProbeHelper(t *testing.T, mode string) (string, error) {
	t.Helper()
	return runVersionProbeHelperWithTimeout(t, mode, 2000)
}

func runVersionProbeHelperWithTimeout(t *testing.T, mode string, timeoutMillis int) (string, error) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return (ExecProbeRunner{}).Run(context.Background(), executable, packs.VersionProbe{
		Args: []string{
			"-test.run=^TestVersionProbeHelperProcess$",
			"--",
			versionProbeHelperMarker,
			mode,
		},
		Parser:        packs.VersionParserSemverText,
		TimeoutMillis: timeoutMillis,
	})
}

func TestVersionProbeHelperProcess(t *testing.T) {
	index := -1
	for i, arg := range os.Args {
		if arg == versionProbeHelperMarker {
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
	case "environment":
		cwd, _ := os.Getwd()
		fmt.Fprintf(os.Stdout, "cwd=%s\n", cwd)
		if value := os.Getenv("CLIHARBOR_VERSION_PROBE_SECRET"); value != "" {
			fmt.Fprintln(os.Stdout, value)
		} else {
			fmt.Fprintln(os.Stdout, "secret-absent")
		}
		if home, homeErr := os.UserHomeDir(); homeErr != nil || home == "" {
			fmt.Fprintln(os.Stdout, "home-missing")
		} else {
			fmt.Fprintln(os.Stdout, "home-present")
		}
		fmt.Fprintln(os.Stdout, "1.2.3")
	case "oversized":
		fmt.Fprint(os.Stdout, strings.Repeat("x", maxProbeStreamBytes+1024))
		fmt.Fprintln(os.Stdout, " 1.2.3")
	case "invalid-utf8":
		_, _ = os.Stdout.Write([]byte{0xff, ' ', '1', '.', '2', '.', '3'})
	case "timeout":
		fmt.Fprintln(os.Stdout, "password=should-not-escape")
		time.Sleep(2 * time.Second)
	default:
		os.Exit(92)
	}
}
