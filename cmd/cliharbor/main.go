package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/Quazmoz/CLIHarbor/internal/app"
	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/platform/browser"
)

var (
	version   = "dev"
	commit    = "unknown"
	buildMode = "development"
)

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(value string) error {
	if value == "" {
		return fmt.Errorf("value cannot be empty")
	}
	*s = append(*s, value)
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "cliharbor: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) > 0 && args[0] == "evidence" {
		return runEvidenceCommand(args[1:])
	}
	if len(args) > 0 && args[0] == "diagnostics" {
		return runDiagnosticsCommand(args[1:])
	}
	if len(args) > 0 && args[0] == "evaluation" {
		return runEvaluationCommand(args[1:])
	}

	command := "serve"
	if len(args) > 0 {
		switch args[0] {
		case "serve", "doctor", "inventory", "self-test", "version":
			command = args[0]
			args = args[1:]
		}
	}

	flags := flag.NewFlagSet("cliharbor", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	webDevURL := flags.String("web-dev-url", "", "development-only Vite origin (must be http://127.0.0.1:<port>)")
	packDirectory := flags.String("pack-dir", "", "explicit trusted directory containing pack YAML files")
	exportPath := flags.String("export", "", "inventory-only sanitized Phase 0 evidence JSON destination")
	var packFiles stringList
	var toolPaths stringList
	var probes stringList
	flags.Var(&packFiles, "pack-file", "explicit trusted pack YAML file (repeatable)")
	flags.Var(&toolPaths, "tool-path", "tool override as pack/tool=/absolute/path (repeatable)")
	flags.Var(&probes, "probe", "inventory-only fixed evidence probe as pack/tool/probe (repeatable)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments")
	}
	if command != "serve" && *webDevURL != "" {
		return fmt.Errorf("--web-dev-url is valid only with serve")
	}
	if command != "inventory" && (*exportPath != "" || len(probes) != 0) {
		return fmt.Errorf("--export and --probe are valid only with inventory")
	}
	if (command == "version" || command == "self-test") &&
		(*packDirectory != "" || len(packFiles) != 0 || len(toolPaths) != 0) {
		return fmt.Errorf("pack and tool flags are not valid with %s", command)
	}

	overrides, err := parseToolOverrides(toolPaths)
	if err != nil {
		return err
	}
	options := app.Options{
		Out:           os.Stdout,
		Version:       version,
		Commit:        commit,
		BuildMode:     buildMode,
		Browser:       browser.SystemLauncher(),
		WebDevURL:     *webDevURL,
		PackFiles:     append([]string(nil), packFiles...),
		PackDirectory: *packDirectory,
		ToolOverrides: overrides,
	}
	if command == "version" {
		return app.PrintVersion(options)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	switch command {
	case "doctor":
		return app.Doctor(ctx, options)
	case "inventory":
		return app.Inventory(ctx, options, app.InventoryConfig{
			ProbeSelectors: append([]string(nil), probes...),
			ExportPath:     *exportPath,
		})
	case "self-test":
		return app.SelfTest(ctx, options)
	default:
		return app.Run(ctx, options)
	}
}

func runEvaluationCommand(args []string) error {
	if len(args) == 0 || args[0] != "preflight" {
		return fmt.Errorf("usage: cliharbor evaluation preflight [--bundle <directory>]")
	}
	flags := flag.NewFlagSet("cliharbor evaluation preflight", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	bundleRoot := flags.String("bundle", "", "extracted Windows evaluation bundle directory")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("usage: cliharbor evaluation preflight [--bundle <directory>]")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return app.EvaluationPreflight(ctx, app.Options{
		Out:       os.Stdout,
		Version:   version,
		Commit:    commit,
		BuildMode: buildMode,
	}, app.EvaluationPreflightConfig{BundleRoot: *bundleRoot})
}

func runDiagnosticsCommand(args []string) error {
	if len(args) == 0 || args[0] != "export" {
		return fmt.Errorf("usage: cliharbor diagnostics export [--pack-file <file>] [--pack-dir <dir>] [--tool-path <pack/tool=/absolute/path>] <output>")
	}
	flags := flag.NewFlagSet("cliharbor diagnostics export", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	packDirectory := flags.String("pack-dir", "", "explicit trusted directory containing pack YAML files")
	var packFiles stringList
	var toolPaths stringList
	flags.Var(&packFiles, "pack-file", "explicit trusted pack YAML file (repeatable)")
	flags.Var(&toolPaths, "tool-path", "tool override as pack/tool=/absolute/path (repeatable)")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 1 || flags.Arg(0) == "" {
		return fmt.Errorf("usage: cliharbor diagnostics export [--pack-file <file>] [--pack-dir <dir>] [--tool-path <pack/tool=/absolute/path>] <output>")
	}
	overrides, err := parseToolOverrides(toolPaths)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return app.ExportDiagnostics(ctx, app.Options{
		Out:           os.Stdout,
		Version:       version,
		Commit:        commit,
		BuildMode:     buildMode,
		PackFiles:     append([]string(nil), packFiles...),
		PackDirectory: *packDirectory,
		ToolOverrides: overrides,
	}, flags.Arg(0))
}

func runEvidenceCommand(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: cliharbor evidence <inspect|checksum> ...")
	}
	switch args[0] {
	case "inspect":
		flags := flag.NewFlagSet("cliharbor evidence inspect", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		expectedSHA256 := flags.String("sha256", "", "independently retained expected SHA-256")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 1 || flags.Arg(0) == "" {
			return fmt.Errorf("usage: cliharbor evidence inspect [--sha256 <64-hex-digest>] <file>")
		}
		return app.InspectEvidenceWithConfig(app.Options{Out: os.Stdout}, flags.Arg(0), app.EvidenceInspectConfig{
			ExpectedSHA256: *expectedSHA256,
		})
	case "checksum":
		if len(args) != 2 || args[1] == "" {
			return fmt.Errorf("usage: cliharbor evidence checksum <file>")
		}
		return app.PrintEvidenceChecksum(app.Options{Out: os.Stdout}, args[1])
	default:
		return fmt.Errorf("usage: cliharbor evidence <inspect|checksum> ...")
	}
}

func parseToolOverrides(values []string) (map[discovery.ToolRef]string, error) {
	overrides := make(map[discovery.ToolRef]string, len(values))
	for _, value := range values {
		parts := strings.SplitN(value, "=", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return nil, fmt.Errorf("invalid --tool-path %q; expected pack/tool=/absolute/path", value)
		}
		ids := strings.Split(parts[0], "/")
		if len(ids) != 2 || ids[0] == "" || ids[1] == "" {
			return nil, fmt.Errorf("invalid --tool-path tool reference %q; expected pack/tool", parts[0])
		}
		ref := discovery.ToolRef{PackID: ids[0], ToolID: ids[1]}
		if _, exists := overrides[ref]; exists {
			return nil, fmt.Errorf("duplicate --tool-path override for %s", ref.String())
		}
		overrides[ref] = parts[1]
	}
	return overrides, nil
}
