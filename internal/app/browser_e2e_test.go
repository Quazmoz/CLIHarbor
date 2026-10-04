package app

import (
	"context"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/platform/browser"
)

const browserE2EEnv = "CLIHARBOR_BROWSER_E2E"

func configureBrowserConjurFixture(t *testing.T, fixture *executionFixtureConfig) {
	t.Helper()

	tempDir := t.TempDir()
	conjurrcPath := filepath.Join(tempDir, ".conjurrc")
	netrcPath := filepath.Join(tempDir, ".netrc")
	certPath := filepath.Join(tempDir, "conjur-ca.pem")
	conjurPath := filepath.Join(tempDir, "conjur")

	const identity = "alice"
	const secret = "e2e-password"
	loginServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/authn/engineering/login" {
			http.NotFound(w, r)
			return
		}
		gotIdentity, gotSecret, ok := r.BasicAuth()
		if !ok || gotIdentity != identity || gotSecret != secret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("e2e-api-key"))
	}))
	t.Cleanup(loginServer.Close)

	certFile, err := os.OpenFile(certPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := pem.Encode(certFile, &pem.Block{Type: "CERTIFICATE", Bytes: loginServer.Certificate().Raw}); err != nil {
		_ = certFile.Close()
		t.Fatal(err)
	}
	if err := certFile.Close(); err != nil {
		t.Fatal(err)
	}

	script := `#!/bin/sh
set -eu

case "${1:-}" in
  --version)
    printf '9.3.1\n'
    ;;
  init)
    shift
    [ "${1:-}" = "self-hosted" ] || exit 2
    shift
    url=""
    account=""
    authn_type="authn"
    service_id=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --url)
          [ "$#" -ge 2 ] || exit 2
          url="$2"
          shift 2
          ;;
        --account)
          [ "$#" -ge 2 ] || exit 2
          account="$2"
          shift 2
          ;;
        --authn-type)
          [ "$#" -ge 2 ] || exit 2
          authn_type="$2"
          shift 2
          ;;
        --service-id)
          [ "$#" -ge 2 ] || exit 2
          service_id="$2"
          shift 2
          ;;
        *)
          exit 2
          ;;
      esac
    done
    [ -n "$url" ] || exit 2
    [ -n "$account" ] || exit 2
    {
      printf 'account: "%s"\n' "$account"
      printf 'appliance_url: "%s"\n' "$url"
      printf 'authn_type: "%s"\n' "$authn_type"
      if [ -n "$service_id" ]; then
        printf 'service_id: "%s"\n' "$service_id"
      fi
      printf 'credential_storage: "file"\n'
      printf 'environment: "self-hosted"\n'
      printf 'cert_file: "%s"\n' "$CLIHARBOR_E2E_CONJUR_CERT"
      printf 'netrc_path: "%s"\n' "$CLIHARBOR_E2E_CONJUR_NETRC"
    } > "$CONJURRC"
    ;;
  whoami)
    if [ -s "$CLIHARBOR_E2E_CONJUR_NETRC" ] &&
       grep -q 'alice' "$CLIHARBOR_E2E_CONJUR_NETRC" &&
       grep -q 'e2e-api-key' "$CLIHARBOR_E2E_CONJUR_NETRC"; then
      printf '{"account":"engineering","username":"alice"}\n'
      exit 0
    fi
    printf 'Error: Please login again\n' >&2
    exit 1
    ;;
  *)
    exit 2
    ;;
esac
`
	if err := os.WriteFile(conjurPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	pack := `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: cyberark-conjur-v9
  name: Browser E2E Conjur
  version: 0.2.0
runtime:
  platforms: [linux, darwin]
  tools:
    conjur:
      executableNames: [conjur]
      versionProbe:
        args: [--version]
        parser: semver-text
        timeoutMillis: 3000
      versionConstraint: ">=9.3.1-0 <10.0.0-0"
      sessionCheck:
        commandId: whoami
        unauthenticatedStderrContains: "please login again"
commands:
  whoami:
    name: Who am I
    tool: conjur
    risk: read
    argv:
      - literal: whoami
      - literal: --output
      - literal: json
    output:
      mode: json
      renderer: raw
    requirements:
      requiresAuth: true
      authMode: vendor-session
`
	packPath := filepath.Join(tempDir, "conjur-browser-e2e.yaml")
	if err := os.WriteFile(packPath, []byte(pack), 0o600); err != nil {
		t.Fatal(err)
	}

	ref := discovery.ToolRef{PackID: conjurCredentialPackID, ToolID: conjurCredentialToolID}
	fixture.options.PackFiles = append(fixture.options.PackFiles, packPath)
	fixture.options.ToolOverrides[ref] = conjurPath

	t.Setenv("CONJURRC", conjurrcPath)
	t.Setenv("CLIHARBOR_E2E_CONJUR_URL", loginServer.URL)
	t.Setenv("CLIHARBOR_E2E_CONJUR_IDENTITY", identity)
	t.Setenv("CLIHARBOR_E2E_CONJUR_SECRET", secret)
	t.Setenv("CLIHARBOR_E2E_CONJUR_CERT", certPath)
	t.Setenv("CLIHARBOR_E2E_CONJUR_NETRC", netrcPath)
}

func TestProductionEmbeddedBrowserE2E(t *testing.T) {
	if os.Getenv(browserE2EEnv) != "1" {
		t.Skip("set CLIHARBOR_BROWSER_E2E=1 to run the real-browser production-runtime test")
	}
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("the real-browser Conjur fixture requires macOS or Linux")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("node is required for the real-browser E2E harness")
	}

	fixture := executionFixtureConfigForTest(t)
	configureBrowserConjurFixture(t, &fixture)
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
	text := strings.TrimSpace(string(output))
	if len(text) > 8000 {
		text = text[len(text)-8000:]
	}
	if ctx.Err() != nil {
		t.Fatalf("browser E2E exceeded its deadline: %v\n%s", ctx.Err(), text)
	}
	if err != nil {
		t.Fatalf("browser E2E failed: %v\n%s", err, text)
	}
	if !strings.Contains(string(output), "CLIHarbor production browser E2E passed") {
		t.Fatalf("browser E2E did not emit its success marker")
	}
}
