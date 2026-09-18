//go:build !windows

package main

import (
	"fmt"
	"os"
)

// activateChecksumFile publishes a completed same-directory staging file
// without replacing an existing destination.
func activateChecksumFile(stagingPath, destinationPath string) error {
	if err := os.Link(stagingPath, destinationPath); err != nil {
		return err
	}
	if err := os.Remove(stagingPath); err != nil {
		return fmt.Errorf("remove activated checksum staging link: %w", err)
	}
	return nil
}
