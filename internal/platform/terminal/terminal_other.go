//go:build !windows

package terminal

import "github.com/Quazmoz/CLIHarbor/internal/discovery"

func platformSupported() bool {
	return false
}

func launchPlatform(string, []string, discovery.ExecutableIdentity) error {
	return ErrUnsupported
}

func runConjurLoginConsolePlatform(string, discovery.ExecutableIdentity) error {
	return ErrUnsupported
}

func launchHiddenPlatform(string, []string) error {
	return ErrUnsupported
}
