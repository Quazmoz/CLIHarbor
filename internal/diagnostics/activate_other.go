//go:build !windows

package diagnostics

import "os"

func validateExportParent(string) error { return nil }

func activateDiagnosticsBundle(stagingPath, destinationPath string) error {
	return os.Link(stagingPath, destinationPath)
}
