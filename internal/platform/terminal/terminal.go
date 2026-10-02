package terminal

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

var ErrUnsupported = errors.New("external vendor terminal is unsupported on this platform")

// Supported reports whether CLIHarbor can launch an exact executable into a
// separate interactive terminal without going through a shell.
func Supported() bool {
	return platformSupported()
}

// Launch starts the exact executable with the supplied argv in a separate
// vendor-owned terminal. It never invokes a command shell.
func Launch(executable string, args []string) error {
	if err := validateLaunch(executable, args); err != nil {
		return err
	}
	if !platformSupported() {
		return ErrUnsupported
	}
	return launchPlatform(executable, args)
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
