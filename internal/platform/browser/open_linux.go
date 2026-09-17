//go:build linux

package browser

import (
	"fmt"
	"os/exec"
)

func openSystemBrowser(rawURL string) error {
	cmd := exec.Command("xdg-open", rawURL)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start default browser: %w", err)
	}
	if err := cmd.Process.Release(); err != nil {
		return fmt.Errorf("release browser launcher process: %w", err)
	}
	return nil
}
