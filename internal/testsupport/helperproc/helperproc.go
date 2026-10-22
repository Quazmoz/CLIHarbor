// Package helperproc standardizes the "re-exec the test binary as a fake CLI"
// pattern used by executor, discovery, runs and app tests.
//
// The hand-rolled versions had two recurring defects:
//
//  1. A helper branch that returned instead of calling os.Exit let the Go test
//     framework append "PASS\n" to the child's stdout, so exact-output
//     assertions failed (or, worse, Contains-style assertions hid it).
//  2. Each file invented its own marker/argv convention, so a typo in the
//     -test.run pattern silently ran zero tests in the child and exited 0.
//
// Dispatch always terminates the child with an explicit exit code, and an
// unknown mode exits with ExitUnknownMode rather than succeeding.
//
// Usage:
//
//	func TestFakeCLIHelperProcess(t *testing.T) {
//		helperproc.Dispatch(t, map[string]helperproc.Mode{
//			"echo": func(args []string) int { fmt.Print(strings.Join(args, " ")); return 0 },
//		})
//	}
//
//	exe, argv := helperproc.Command(t, "TestFakeCLIHelperProcess", "echo", "a", "b")
package helperproc

import (
	"os"
	"regexp"
	"testing"
)

// Marker separates the go test flags from helper arguments. It is distinctive
// so a real CLI invocation can never be mistaken for a helper invocation.
const Marker = "--cliharbor-helper-process"

const (
	// ExitMissingMode means the child was started with the marker but no mode.
	ExitMissingMode = 90
	// ExitUnknownMode means the mode is not registered in the Dispatch table.
	ExitUnknownMode = 89
)

// Mode is one fake-CLI behaviour. It receives the arguments after the mode
// name and returns the process exit code.
type Mode func(args []string) int

var testNamePattern = regexp.MustCompile(`^Test[A-Za-z0-9_]*$`)

// Command returns the executable and argv that re-run this test binary as a
// helper in the given mode. testName must be the exact helper test function.
func Command(t testing.TB, testName, mode string, args ...string) (string, []string) {
	t.Helper()
	if !testNamePattern.MatchString(testName) {
		t.Fatalf("helperproc: invalid helper test name %q", testName)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("helperproc: resolve test executable: %v", err)
	}
	argv := append([]string{"-test.run=^" + testName + "$", "-test.count=1", "--", Marker, mode}, args...)
	return executable, argv
}

// Active reports whether the current process is a helper child.
func Active() bool {
	_, _, ok := modeArgs(os.Args)
	return ok
}

// Dispatch runs the registered mode and exits. In the normal (parent) test
// process it returns immediately so the helper test is a no-op.
func Dispatch(t testing.TB, modes map[string]Mode) {
	t.Helper()
	mode, args, ok := modeArgs(os.Args)
	if !ok {
		return
	}
	if mode == "" {
		os.Exit(ExitMissingMode)
	}
	run, found := modes[mode]
	if !found {
		os.Exit(ExitUnknownMode)
	}
	os.Exit(run(args))
}

func modeArgs(argv []string) (mode string, args []string, ok bool) {
	for i, arg := range argv {
		if arg != Marker {
			continue
		}
		if i+1 >= len(argv) {
			return "", nil, true
		}
		return argv[i+1], argv[i+2:], true
	}
	return "", nil, false
}
