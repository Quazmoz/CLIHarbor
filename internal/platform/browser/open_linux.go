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
	go func() { _ = cmd.Wait() }() // reap the launcher; Release alone leaves a zombie
	return nil
}
