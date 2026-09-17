package app

import (
	"bytes"
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/platform/browser"
)

func TestRunLaunchesExactBootstrapURLWithoutPrintingTokenOnSuccess(t *testing.T) {
	t.Parallel()

	var opened string
	launcher := browser.LauncherFunc(func(rawURL string) error {
		opened = rawURL
		return nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out bytes.Buffer

	if err := Run(ctx, Options{Out: &out, Version: "test-version", Browser: launcher}); err != nil {
		t.Fatalf("run: %v", err)
	}
	if opened == "" {
		t.Fatal("browser launcher did not receive bootstrap URL")
	}
	parsed, err := url.Parse(opened)
	if err != nil {
		t.Fatalf("parse launched URL: %v", err)
	}
	if parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.Path != "/bootstrap" || parsed.Query().Get("token") == "" {
		t.Fatalf("launcher received unexpected bootstrap URL shape")
	}
	if strings.Contains(out.String(), opened) || strings.Contains(out.String(), parsed.Query().Get("token")) {
		t.Fatal("successful startup output leaked bootstrap URL or token")
	}
	if !strings.Contains(out.String(), "Local runtime: http://127.0.0.1:") {
		t.Fatalf("startup output missing safe local runtime origin: %q", out.String())
	}
}

func TestRunBrowserLaunchFailurePrintsUsableFallbackAndKeepsServerLifecycle(t *testing.T) {
	t.Parallel()

	var opened string
	launcher := browser.LauncherFunc(func(rawURL string) error {
		opened = rawURL
		return errors.New("sensitive platform details must not be printed")
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out bytes.Buffer

	if err := Run(ctx, Options{Out: &out, Version: "test-version", Browser: launcher}); err != nil {
		t.Fatalf("run: %v", err)
	}
	if opened == "" || !strings.Contains(out.String(), opened) {
		t.Fatalf("fallback output does not contain exact bootstrap URL: %q", out.String())
	}
	if strings.Contains(out.String(), "sensitive platform details") {
		t.Fatal("fallback output leaked browser launcher error details")
	}
}

func TestFrontendDevelopmentURLRejectsNonLoopbackOrigins(t *testing.T) {
	t.Parallel()

	for _, raw := range []string{"http://localhost:5173", "http://0.0.0.0:5173", "https://127.0.0.1:5173"} {
		if _, err := frontendHandler(raw); err == nil {
			t.Fatalf("frontend development URL %q unexpectedly accepted", raw)
		}
	}
}
