//go:build !windows

package evidence

import "os"

// activateEvidenceBundle publishes a completed same-directory staging file
// without replacing an existing destination.
func activateEvidenceBundle(stagingPath, destinationPath string) error {
	return os.Link(stagingPath, destinationPath)
}
