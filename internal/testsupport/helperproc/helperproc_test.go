package helperproc

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestHelperprocChildProcess(t *testing.T) {
	Dispatch(t, map[string]Mode{
		"echo": func(args []string) int {
			fmt.Fprint(os.Stdout, strings.Join(args, "|"))
			return 0
		},
		"fail": func([]string) int { return 7 },
	})
}

func run(t *testing.T, mode string, args ...string) (string, int) {
	t.Helper()
	exe, argv := Command(t, "TestHelperprocChildProcess", mode, args...)
	var stdout bytes.Buffer
	cmd := exec.Command(exe, argv...)
	cmd.Stdout = &stdout
	err := cmd.Run()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return stdout.String(), exitErr.ExitCode()
	}
	if err != nil {
		t.Fatalf("run helper: %v", err)
	}
	return stdout.String(), 0
}

func TestDispatchOutputIsExactWithoutFrameworkTrailer(t *testing.T) {
	out, code := run(t, "echo", "a b", "--flag", "")
	if code != 0 || out != "a b|--flag|" {
		t.Fatalf("got %q exit %d, want exact child stdout with no PASS trailer", out, code)
	}
}

func TestDispatchPropagatesExitCode(t *testing.T) {
	if _, code := run(t, "fail"); code != 7 {
		t.Fatalf("exit = %d, want 7", code)
	}
}

func TestDispatchRejectsUnknownAndMissingMode(t *testing.T) {
	if _, code := run(t, "nope"); code != ExitUnknownMode {
		t.Fatalf("unknown mode exit = %d, want %d", code, ExitUnknownMode)
	}
	if _, code := run(t, ""); code != ExitUnknownMode && code != ExitMissingMode {
		t.Fatalf("empty mode exit = %d", code)
	}
}

func TestModeArgs(t *testing.T) {
	if _, _, ok := modeArgs([]string{"x", "-test.v"}); ok {
		t.Fatal("parent process detected as helper")
	}
	if mode, args, ok := modeArgs([]string{"x", "--", Marker, "m", "1"}); !ok || mode != "m" || len(args) != 1 || args[0] != "1" {
		t.Fatalf("modeArgs = %q %q %t", mode, args, ok)
	}
	if mode, _, ok := modeArgs([]string{"x", Marker}); !ok || mode != "" {
		t.Fatalf("trailing marker = %q %t", mode, ok)
	}
}

func TestCommandRejectsUnsafeTestName(t *testing.T) {
	ft := &fatalRecorder{TB: t}
	func() {
		defer func() { _ = recover() }()
		Command(ft, "Test.*", "m")
	}()
	if !ft.failed {
		t.Fatal("regexp metacharacters in helper name were accepted")
	}
}

type fatalRecorder struct {
	testing.TB
	failed bool
}

func (f *fatalRecorder) Helper() {}
func (f *fatalRecorder) Fatalf(string, ...any) {
	f.failed = true
	panic("fatal")
}
