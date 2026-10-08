package app

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/audittrail"
	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/platform/browser"
	"github.com/Quazmoz/CLIHarbor/internal/platforms"
	"github.com/Quazmoz/CLIHarbor/internal/platforms/conjur"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/Quazmoz/CLIHarbor/internal/toolbootstrap"
	"github.com/Quazmoz/CLIHarbor/internal/webui"
)

// Options contains process-level dependencies, explicit trusted pack sources,
// backend-only tool overrides, and development-only frontend configuration.
type Options struct {
	Out                io.Writer
	Version            string
	Commit             string
	BuildMode          string
	Browser            browser.Launcher
	WebDevURL          string
	PackFiles          []string
	PackDirectory      string
	ToolOverrides      map[discovery.ToolRef]string
	LoadDefaultPacks   bool
	AutoProvisionTools bool
	AuditPath string // Tests or explicitly reviewed deployments may override local audit storage.
	ToolProvisioner    toolbootstrap.Provisioner
}

// Run starts the local runtime, resolves configured pack/tool state, opens the
// one-time browser bootstrap handoff, and blocks until ctx is cancelled or the server exits.
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

	runtimeState, err := prepareRuntime(ctx, options)
	if err != nil {
		return err
	}
	auditPath := options.AuditPath
	if auditPath == "" {
		var pathErr error
		auditPath, pathErr = audittrail.DefaultPath()
		if pathErr!=nil { return fmt.Errorf("locate mutation audit trail: %w",pathErr) }
	}
	audit, err := audittrail.Open(auditPath)
	if err!=nil { return fmt.Errorf("open mutation audit trail: %w",err) }
	defer audit.Close()
	// Dedicated platforms layer vendor-specific behavior over the generic core.
	conjurPlatform := conjur.New(ctx, runtimeState.Discovery)
	dedicated := platforms.NewSet(runtimeState.Discovery, conjurPlatform)
	runManager, err := runs.NewManager(ctx, runtimeState.Registry, runtimeState.Discovery, runs.Config{
		ResolveExecutionContext: dedicated.ResolveExecutionContext,
		Audit: audit,
	})
	if err != nil {
		return fmt.Errorf("configure run manager: %w", err)
	}
	shutdownRuns := func() error {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return runManager.Shutdown(shutdownCtx)
	}

	frontend, err := frontendHandler(options.WebDevURL)
	if err != nil {
		_ = shutdownRuns()
		return err
	}
	credentialLogin := conjurPlatform.Login
	installLocations, _ := newManagedInstallLocationStore()
	toolInstaller := newManagedToolInstaller(runtimeState.Registry, runtimeState.Discovery, toolbootstrap.NewPortableProvisioner(), installLocations)
	catalog := newTaskCatalog(runtimeState.Registry, runtimeState.Discovery)
	catalog.setCredentialLoginCapabilityProvider(credentialLogin.Capability)
	catalog.setTaskAvailabilityProvider(dedicated.TaskAvailable)
	toolInstaller.activate = func(snapshot discovery.Snapshot, state discovery.ToolState) error {
		if err := runManager.ActivateTool(state); err != nil {
			return err
		}
		dedicated.ActivateTool(state)
		catalog.refresh(runtimeState.Registry, snapshot)
		return nil
	}
	s, err := server.New(server.Config{
		Version:                    options.Version,
		Frontend:                   frontend,
		Runs:                       runManager,
		Audit:                      audit,
		Tasks:                      catalog,
		Tools:                      catalog,
		CredentialLogin:            credentialLogin,
		CredentialInteractiveLogin: credentialLogin,
		CredentialConfiguration:    credentialLogin,
		ToolInstaller:              toolInstaller,
		SecretAudit:                conjurPlatform.Audit,
		Platforms:                  dedicated,
	})
	if err != nil {
		_ = shutdownRuns()
		return err
	}

	bootstrapURL := s.BootstrapURL()
	launchErr := options.Browser.OpenBootstrap(bootstrapURL)
	if err := writeStartupStatus(options.Out, options.Version, s.BaseURL(), bootstrapURL, launchErr, runtimeState); err != nil {
		closeErr := s.Close()
		runShutdownErr := shutdownRuns()
		switch {
		case closeErr != nil && runShutdownErr != nil:
			return fmt.Errorf("write startup status: %w (close listener: %v; shutdown runs: %v)", err, closeErr, runShutdownErr)
		case closeErr != nil:
			return fmt.Errorf("write startup status: %w (close listener: %v)", err, closeErr)
		case runShutdownErr != nil:
			return fmt.Errorf("write startup status: %w (shutdown runs: %v)", err, runShutdownErr)
		default:
			return fmt.Errorf("write startup status: %w", err)
		}
	}

	serverErr := s.Run(ctx)
	runShutdownErr := shutdownRuns()
	if serverErr != nil && runShutdownErr != nil {
		return fmt.Errorf("%v (shutdown runs: %w)", serverErr, runShutdownErr)
	}
	if serverErr != nil {
		return serverErr
	}
	if runShutdownErr != nil {
		return fmt.Errorf("shutdown runs: %w", runShutdownErr)
	}
	return nil
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

func writeStartupStatus(out io.Writer, version, baseURL, bootstrapURL string, launchErr error, state RuntimeState) error {
	packsCount, ready, unavailable := state.counts()
	if launchErr == nil {
		if _, err := fmt.Fprintf(out, "CLIHarbor %s\nLocal runtime: %s\nConfigured packs: %d\nTools: %d ready, %d unavailable\n", version, baseURL, packsCount, ready, unavailable); err != nil {
			return err
		}
		if err := writeSetupMessages(out, state.SetupMessages); err != nil {
			return err
		}
		_, err := fmt.Fprintln(out, "Default browser launch requested.")
		return err
	}

	// The launcher error is deliberately not printed: platform errors can echo
	// command arguments. The bootstrap URL is shown only in this explicit
	// interactive fallback path because the user otherwise cannot establish a session.
	if _, err := fmt.Fprintf(out, "CLIHarbor %s\nConfigured packs: %d\nTools: %d ready, %d unavailable\n", version, packsCount, ready, unavailable); err != nil {
		return err
	}
	if err := writeSetupMessages(out, state.SetupMessages); err != nil {
		return err
	}
	_, err := fmt.Fprintf(out, "Default browser launch failed. Open this local URL in your browser:\n%s\n", bootstrapURL)
	return err
}

func writeSetupMessages(out io.Writer, messages []string) error {
	for _, message := range messages {
		if _, err := fmt.Fprintf(out, "Setup: %s\n", message); err != nil {
			return err
		}
	}
	return nil
}
