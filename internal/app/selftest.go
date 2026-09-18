package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/Quazmoz/CLIHarbor/internal/executor"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
	"github.com/Quazmoz/CLIHarbor/internal/structured"
	"github.com/Quazmoz/CLIHarbor/internal/webui"
)

// SelfTest verifies CLIHarbor's local runtime without loading or executing a
// vendor pack. It intentionally performs no external network requests.
func SelfTest(ctx context.Context, options Options) error {
	if options.Out == nil {
		return fmt.Errorf("self-test output writer is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	checks := []struct {
		name string
		run  func(context.Context) error
	}{
		{name: "temporary-directory access", run: selfTestTemporaryDirectory},
		{name: "pack schema and registry", run: selfTestPackRegistry},
		{name: "structured parser", run: selfTestStructuredParser},
		{name: "embedded frontend and loopback session", run: func(ctx context.Context) error {
			return selfTestLoopback(ctx, normalizeBuildInfo(options).Version)
		}},
		{name: "direct local process execution", run: selfTestProcessExecution},
	}

	if _, err := fmt.Fprintf(options.Out, "CLIHarbor %s self-test\n", normalizeBuildInfo(options).Version); err != nil {
		return err
	}
	for _, check := range checks {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := check.run(ctx); err != nil {
			_, _ = fmt.Fprintf(options.Out, "[FAIL] %s: %v\n", check.name, err)
			return fmt.Errorf("self-test %s: %w", check.name, err)
		}
		if _, err := fmt.Fprintf(options.Out, "[OK] %s\n", check.name); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintln(options.Out, "Self-test passed. No vendor CLI, credential store, or external network endpoint was accessed by CLIHarbor.")
	return err
}

func selfTestTemporaryDirectory(context.Context) error {
	dir, err := os.MkdirTemp("", "cliharbor-selftest-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "probe.txt")
	const content = "cliharbor"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return err
	}
	got, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if string(got) != content {
		return fmt.Errorf("temporary-file round trip mismatch")
	}
	return nil
}

func selfTestPackRegistry(context.Context) error {
	source := fmt.Sprintf(`apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: selftest
  name: CLIHarbor Self-Test
  version: 0.0.0
runtime:
  platforms: [%s]
  tools:
    fixture:
      executableNames: [cliharbor-selftest]
commands: {}
`, runtime.GOOS)
	pack, err := packs.Parse([]byte(source))
	if err != nil {
		return err
	}
	registry, err := packs.NewRegistry([]packs.LoadedPack{{
		Source: packs.Source{Kind: packs.SourceBuiltin, Name: "self-test"},
		Pack:   pack,
	}})
	if err != nil {
		return err
	}
	if _, ok := registry.FindTool("selftest", "fixture"); !ok {
		return fmt.Errorf("validated tool missing from registry")
	}
	return nil
}

func selfTestStructuredParser(ctx context.Context) error {
	result := structured.Parse(ctx, []byte(`{"status":"ok"}`), packs.StructuredOutput{
		Fields: []packs.StructuredField{{
			Key: "status", Label: "Status", Type: packs.StructuredString, Required: true,
		}},
	}, "cards")
	if result.Status != structured.StatusAvailable || len(result.Fields) != 1 || result.Fields[0].Value != "ok" {
		return fmt.Errorf("structured parser result was not available")
	}
	return nil
}

func selfTestLoopback(ctx context.Context, version string) error {
	frontend, err := webui.ProductionHandler()
	if err != nil {
		return err
	}
	s, err := server.New(server.Config{Version: version, Frontend: frontend})
	if err != nil {
		return err
	}
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- s.Run(runCtx) }()

	jar, err := cookiejar.New(nil)
	if err != nil {
		cancel()
		<-done
		return err
	}
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	response, err := client.Get(s.BootstrapURL())
	if err != nil {
		cancel()
		<-done
		return fmt.Errorf("bootstrap loopback session: %w", err)
	}
	_, readErr := io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	closeErr := response.Body.Close()
	if readErr != nil {
		cancel()
		<-done
		return fmt.Errorf("read embedded frontend response: %w", readErr)
	}
	if closeErr != nil {
		cancel()
		<-done
		return fmt.Errorf("close embedded frontend response: %w", closeErr)
	}
	if response.StatusCode != http.StatusOK {
		cancel()
		<-done
		return fmt.Errorf("embedded frontend returned HTTP %d", response.StatusCode)
	}

	statusResponse, err := client.Get(s.BaseURL() + "/api/v1/status")
	if err != nil {
		cancel()
		<-done
		return fmt.Errorf("read authenticated status: %w", err)
	}
	defer statusResponse.Body.Close()
	if statusResponse.StatusCode != http.StatusOK {
		cancel()
		<-done
		return fmt.Errorf("authenticated status returned HTTP %d", statusResponse.StatusCode)
	}
	var payload struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Session string `json:"session"`
	}
	if err := json.NewDecoder(io.LimitReader(statusResponse.Body, 64<<10)).Decode(&payload); err != nil {
		cancel()
		<-done
		return fmt.Errorf("decode authenticated status: %w", err)
	}
	if payload.Name != "CLIHarbor" || payload.Version != version || payload.Session != "active" {
		cancel()
		<-done
		return fmt.Errorf("authenticated status payload mismatch")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			return err
		}
	case <-time.After(6 * time.Second):
		_ = s.Close()
		return fmt.Errorf("loopback server did not stop cleanly")
	}
	return nil
}

func selfTestProcessExecution(ctx context.Context) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return err
	}
	result, err := executor.RunReadOnlyProbe(ctx, executable, []string{"version"}, executor.ReadOnlyProbeConfig{
		Timeout:        5 * time.Second,
		MaxOutputBytes: 8 << 10,
	})
	if err != nil {
		return err
	}
	if result.TimedOut || result.Cancelled || result.Truncated || result.ExitCode != 0 {
		return fmt.Errorf("self process probe failed: exit=%d timeout=%t cancelled=%t truncated=%t", result.ExitCode, result.TimedOut, result.Cancelled, result.Truncated)
	}
	output := string(result.Stdout)
	if !strings.Contains(output, "CLIHarbor ") || !strings.Contains(output, "platform: ") {
		return fmt.Errorf("self process version output was incomplete")
	}
	return nil
}
