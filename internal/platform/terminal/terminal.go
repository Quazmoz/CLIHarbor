package terminal

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

var ErrUnsupported = errors.New("external vendor terminal is unsupported on this platform")

// Supported reports whether CLIHarbor can launch an exact executable into a
// vendor-owned Windows process without going through a shell.
func Supported() bool {
	return platformSupported()
}

// Launch hosts the identity-checked Conjur login in a separate console with
// explicit terminal handles and a dismissible result. It never invokes a shell.
func Launch(executable string, args []string, identity discovery.ExecutableIdentity) error {
	if err := validateLaunch(executable, args); err != nil {
		return err
	}
	if !platformSupported() {
		return ErrUnsupported
	}
	if !identity.Matches(executable) {
		return fmt.Errorf("vendor executable identity changed")
	}
	return launchPlatform(executable, args, identity)
}

// RunConjurLoginConsole is the private console-host entry point. The host never
// accepts arbitrary commands: only the identity-checked Conjur login flow.
func RunConjurLoginConsole(args []string) error {
	if len(args) != 2 || validateLaunch(args[0], []string{"login"}) != nil ||
		!strings.EqualFold(filepath.Base(args[0]), "conjur.exe") {
		return fmt.Errorf("invalid Conjur console handoff")
	}
	identity, err := discovery.CaptureExecutableIdentity(args[0])
	if err != nil || args[1] != fmt.Sprintf("%x", identity.ContentSHA256()) {
		return fmt.Errorf("Conjur console executable identity changed")
	}
	return runConjurLoginConsolePlatform(args[0], identity)
}

// LaunchHidden starts the exact executable with the supplied argv without a
// visible console window. The detached vendor process still owns its own
// browser handoff/session storage; CLIHarbor does not capture stdin/stdout.
func LaunchHidden(executable string, args []string) error {
	if err := validateLaunch(executable, args); err != nil {
		return err
	}
	if !platformSupported() {
		return ErrUnsupported
	}
	return launchHiddenPlatform(executable, args)
}

func validateLaunch(executable string, args []string) error {
	if executable == "" || !filepath.IsAbs(executable) || strings.IndexByte(executable, 0) >= 0 {
		return fmt.Errorf("vendor executable path must be absolute and non-empty")
	}
	if len(args) == 0 || len(args) > 16 {
		return fmt.Errorf("vendor terminal argv is outside the supported bounds")
	}
	total := len(executable)
	for _, arg := range args {
		if arg == "" || strings.IndexByte(arg, 0) >= 0 {
			return fmt.Errorf("vendor terminal argv contains an invalid argument")
		}
		total += len(arg) + 1
	}
	// CreateProcess is limited to a 32,767 UTF-16-code-unit command line.
	// Keep a conservative byte bound here; the current reviewed argv is tiny.
	if total > 16*1024 {
		return fmt.Errorf("vendor terminal command line is too long")
	}
	return nil
}
