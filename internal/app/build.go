package app

import (
	"fmt"
	"runtime"

	"github.com/Quazmoz/CLIHarbor/internal/evidence"
)

func normalizeBuildInfo(options Options) evidence.BuildInfo {
	version := options.Version
	if version == "" {
		version = "dev"
	}
	commit := options.Commit
	if commit == "" {
		commit = "unknown"
	}
	mode := options.BuildMode
	if mode == "" {
		mode = "development"
	}
	return evidence.BuildInfo{Version: version, Commit: commit, BuildMode: mode}
}

// PrintVersion reports the exact build identity carried by the executable.
func PrintVersion(options Options) error {
	if options.Out == nil {
		return fmt.Errorf("version output writer is required")
	}
	build := normalizeBuildInfo(options)
	_, err := fmt.Fprintf(
		options.Out,
		"CLIHarbor %s\ncommit: %s\nbuild: %s\ngo: %s\nplatform: %s/%s\n",
		build.Version, build.Commit, build.BuildMode, runtime.Version(), runtime.GOOS, runtime.GOARCH,
	)
	return err
}
