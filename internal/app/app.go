package app

import (
	"context"
	"fmt"
	"io"
	"net/http"

	"github.com/Quazmoz/CLIHarbor/internal/platform/browser"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/Quazmoz/CLIHarbor/internal/webui"
)

// Options contains process-level dependencies and development-only frontend configuration.
type Options struct {
	Out       io.Writer
	Version   string
	Browser   browser.Launcher
	WebDevURL string
}

// Run starts the local runtime, opens the one-time browser bootstrap handoff,
// and blocks until ctx is cancelled or the server exits.
func Run(ctx context.Context, options Options) error {
	if options.Out == nil {
		return fmt.Errorf("startup output writer is required")
	}
	if options.Version == "" {
		options.Version = "dev"
	}
	if options.Browser == nil {
		options.Browser = browser.SystemLauncher()
	}

	frontend, err := frontendHandler(options.WebDevURL)
	if err != nil {
		return err
	}
	s, err := server.New(server.Config{Version: options.Version, Frontend: frontend})
	if err != nil {
		return err
	}

	bootstrapURL := s.BootstrapURL()
	launchErr := options.Browser.OpenBootstrap(bootstrapURL)
	if err := writeStartupStatus(options.Out, options.Version, s.BaseURL(), bootstrapURL, launchErr); err != nil {
		closeErr := s.Close()
		if closeErr != nil {
			return fmt.Errorf("write startup status: %w (close listener: %v)", err, closeErr)
		}
		return fmt.Errorf("write startup status: %w", err)
	}

	return s.Run(ctx)
}

func frontendHandler(webDevURL string) (http.Handler, error) {
	if webDevURL != "" {
		handler, err := webui.NewDevProxy(webDevURL)
		if err != nil {
			return nil, fmt.Errorf("configure frontend development proxy: %w", err)
		}
		return handler, nil
	}
	handler, err := webui.ProductionHandler()
	if err != nil {
		return nil, err
	}
	return handler, nil
}

func writeStartupStatus(out io.Writer, version, baseURL, bootstrapURL string, launchErr error) error {
	if launchErr == nil {
		_, err := fmt.Fprintf(out, "CLIHarbor %s\nLocal runtime: %s\nDefault browser launch requested.\n", version, baseURL)
		return err
	}

	// The launcher error is deliberately not printed: platform errors can echo
	// command arguments. The bootstrap URL is shown only in this explicit
	// interactive fallback path because the user otherwise cannot establish a session.
	_, err := fmt.Fprintf(out, "CLIHarbor %s\nDefault browser launch failed. Open this local URL in your browser:\n%s\n", version, bootstrapURL)
	return err
}
