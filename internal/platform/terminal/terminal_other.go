//go:build !windows

package terminal

func platformSupported() bool {
	return false
}

func launchPlatform(string, []string) error {
	return ErrUnsupported
}

func launchHiddenPlatform(string, []string) error {
	return ErrUnsupported
}
