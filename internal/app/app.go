package app

import (
	"context"
	"fmt"
	"io"

	"github.com/Quazmoz/CLIHarbor/internal/server"
)

// Run starts the local runtime and blocks until ctx is cancelled.
func Run(ctx context.Context, out io.Writer, version string) error {
	s, err := server.New(server.Config{Version: version})
	if err != nil {
		return err
	}

	// Browser auto-open is intentionally a later foundation step. Until then,
	// emit the short-lived bootstrap URL only to the interactive CLI output.
	if _, err := fmt.Fprintf(out, "CLIHarbor %s\nOpen this local URL in your browser:\n%s\n", version, s.BootstrapURL()); err != nil {
		closeErr := s.Close()
		if closeErr != nil {
			return fmt.Errorf("write startup instructions: %w (close listener: %v)", err, closeErr)
		}
		return fmt.Errorf("write startup instructions: %w", err)
	}

	return s.Run(ctx)
}
