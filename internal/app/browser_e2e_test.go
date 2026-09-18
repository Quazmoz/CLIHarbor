package app

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/platform/browser"
)

const browserE2EEnv = "CLIHARBOR_BROWSER_E2E"

func TestProductionEmbeddedBrowserE2E(t *testing.T) {
	if os.Getenv(browserE2EEnv) != "1" {
		t.Skip("set CLIHARBOR_BROWSER_E2E=1 to run the real-browser production-runtime test")
	}
	if runtime.GOOS != "linux" {
		t.Skip("the CI real-browser qualification currently runs on Linux")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("node is required for the real-browser E2E harness")
	}

	fixture := executionFixtureConfigForTest(t)
	launched := make(chan string, 1)
	fixture.options.Out = io.Discard
	fixture.options.Version = "browser-e2e"
	fixture.options.Browser = browser.LauncherFunc(func(rawURL string) error {
		select {
		case launched <- rawURL:
			return nil
		default:
			return context.Canceled
		}
	})

	appCtx, cancelApp := context.WithCancel(context.Background())
	appDone := make(chan error, 1)
	go func() {
		appDone <- Run(appCtx, fixture.options)
	}()
	defer func() {
		cancelApp()
		select {
		case runErr := <-appDone:
			if runErr != nil {
				t.Errorf("application shutdown: %v", runErr)
			}
		case <-time.After(8 * time.Second):
			t.Error("application did not shut down within the test bound")
		}
	}()

	var bootstrapURL string
	select {
	case bootstrapURL = <-launched:
	case runErr := <-appDone:
		t.Fatalf("application exited before browser bootstrap: %v", runErr)
	case <-time.After(5 * time.Second):
		t.Fatal("application did not publish a bootstrap URL")
	}

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve browser E2E source path")
	}
	script := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", "test", "browser_e2e.mjs"))
	if _, err := os.Stat(script); err != nil {
		t.Fatalf("browser E2E script unavailable: %v", err)
	}

	ctx, cancel := context.WithTimeout(t.Context(), 75*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, script)
	cmd.Env = append(os.Environ(), "CLIHARBOR_E2E_BOOTSTRAP_URL="+bootstrapURL)
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("browser E2E exceeded its deadline: %v", ctx.Err())
	}
	if err != nil {
		text := strings.TrimSpace(string(output))
		if len(text) > 8000 {
			text = text[len(text)-8000:]
		}
		t.Fatalf("browser E2E failed: %v\n%s", err, text)
	}
	if !strings.Contains(string(output), "CLIHarbor production browser E2E passed") {
		t.Fatalf("browser E2E did not emit its success marker")
	}
}
