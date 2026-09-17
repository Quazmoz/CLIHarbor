//go:build !windows && !linux && !darwin

package browser

import "fmt"

func openSystemBrowser(_ string) error {
	return fmt.Errorf("default-browser launch is not implemented on this platform")
}
