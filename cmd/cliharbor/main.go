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

func isHelpFlag(value string) bool {
	return value == "-h" || value == "--help"
}

func helpRequest(args []string) ([]string, bool) {
	if len(args) == 0 {
		return nil, false
	}
	if args[0] == "help" {
		return append([]string(nil), args[1:]...), true
	}

	helpIndex := -1
	for index, arg := range args {
		if isHelpFlag(arg) {
			helpIndex = index
			break
		}
	}
	if helpIndex == -1 {
		return nil, false
	}
	if helpIndex == 0 || strings.HasPrefix(args[0], "-") {
		return nil, true
	}

	path := []string{args[0]}
	switch args[0] {
	case "pack", "evidence", "diagnostics", "evaluation":
		if len(args) > 1 && !isHelpFlag(args[1]) && !strings.HasPrefix(args[1], "-") {
			path = append(path, args[1])
		}
	}
	return path, true
}

var helpText = map[string]string{
	"": `CLIHarbor — secure local browser workflows over reviewed command-line tools.

Usage:
  cliharbor [serve] [options]
  cliharbor doctor [options]
  cliharbor inventory [options]
  cliharbor self-test
  cliharbor version
  cliharbor pack <command> [options]
  cliharbor evidence <command> [options]
  cliharbor diagnostics export [options] <output>
  cliharbor evaluation preflight [options]
  cliharbor help [command [subcommand]]

Commands:
  serve         Start the loopback-only browser workspace (default).
  doctor        Inspect configured pack and CLI readiness without browser startup.
  inventory     Collect bounded discovery-only Phase 0 evidence.
  self-test     Run vendor-free local runtime checks.
  version       Print build/version identity.
  pack          Create, capture, summarize, validate, lint, test, or generate reviewed pack artifacts.
  evidence      Check or inspect exported Phase 0 evidence.
  diagnostics   Export privacy-preserving support metadata.
  evaluation    Verify an extracted Windows evaluation bundle.
  help          Show this help or help for one command/subcommand.

Examples:
  cliharbor
  cliharbor doctor
  cliharbor help serve
  cliharbor pack --help
  cliharbor pack init --help

CLIHarbor executes reviewed executable + argv contracts directly and does not provide an arbitrary shell.
`,
	"serve": `Usage:
  cliharbor [serve] [options]

Start the authenticated loopback-only browser workspace.

Options:
  --pack-file <file>        Add an explicit trusted pack file (repeatable).
  --pack-dir <dir>          Add an explicit trusted pack directory.
  --tool-path <ref=path>    Pin pack/tool to an approved absolute executable path (repeatable).
  --no-default-packs        Omit embedded first-party packs.
  --no-auto-setup           Disable current-user setup of missing first-party dependencies.
  --web-dev-url <url>       Development only: use a Vite origin on 127.0.0.1.
  -h, --help                Show this help.

Running cliharbor with no command is equivalent to cliharbor serve.
`,
	"doctor": `Usage:
  cliharbor doctor [options]

Inspect configured packs and CLI discovery/version readiness. Doctor is local operator output and may include exact paths.

Options:
  --pack-file <file>        Add an explicit trusted pack file (repeatable).
  --pack-dir <dir>          Add an explicit trusted pack directory.
  --tool-path <ref=path>    Pin pack/tool to an approved absolute executable path (repeatable).
  --no-default-packs        Omit embedded first-party packs.
  -h, --help                Show this help.
`,
	"inventory": `Usage:
  cliharbor inventory [options]

Collect bounded discovery-only Phase 0 inventory. Inventory does not create browser task authority.

Options:
  --pack-file <file>        Explicit trusted inventory pack (repeatable).
  --pack-dir <dir>          Explicit trusted inventory pack directory.
  --tool-path <ref=path>    Pin pack/tool to an approved absolute executable path (repeatable).
  --probe <ref>             Run one pack-declared fixed evidence probe (repeatable).
  --export <file>           Write sanitized Phase 0 evidence to a new file.
  -h, --help                Show this help.
`,
	"self-test": `Usage:
  cliharbor self-test

Run vendor-free local runtime checks. Pack and tool override flags are intentionally unavailable.
`,
	"version": `Usage:
  cliharbor version

Print CLIHarbor version, commit, and build identity.
`,
	"pack": `Usage:
  cliharbor pack <init|draft|capture-help|compatibility|validate|lint|test|generate-tests> ...

Pack commands author and verify declarative reviewed CLI contracts. They do not grant arbitrary shell authority.

Run 'cliharbor help pack <command>' for command-specific usage.
`,
	"pack init": `Usage:
  cliharbor pack init --id <id> --name <name> --tool <tool-id> --executable <basename> [--platform <os>] <output.yaml>

Create a discovery-only pack scaffold. No vendor commands or probes are guessed.
`,
	"pack draft": `Usage:
  cliharbor pack draft --id <id> --name <name> --tool <tool-id> --executable <basename> --help-file <captured-help.txt> [--platform <os>] <output.yaml>

Draft reviewable command names and bounded safe summaries from explicitly captured vendor help. Generated content remains comments only and still requires human review.
`,
	"pack capture-help": `Usage:
  cliharbor pack capture-help --pack-file <pack.yaml> [--pack-file <pack.yaml> ...] [--pack-dir <dir>] --tool <pack/tool> --probe <probe-id> [--tool-path <pack/tool=/absolute/path>] <output.txt>

Execute exactly one fixed help probe already declared by an explicitly trusted pack and write sanitized output to a new file.
The command never accepts arbitrary argv, never auto-provisions a tool, and the capture grants no runtime pack or command authority.
`,
	"pack compatibility": `Usage:
  cliharbor pack compatibility <pack.yaml-or-directory> [...]

Print deterministic declared platform/version/install metadata from validated packs.
This is static authoring metadata only: no host discovery, executable, probe, task, network, or vendor-session state is accessed, and no installation is performed.
`,
	"pack validate": `Usage:
  cliharbor pack validate <pack.yaml-or-directory> [...]

Validate pack schema, semantics, and security constraints without executing the declared CLI.
`,
	"pack lint": `Usage:
  cliharbor pack lint [--cases <cases.json>] <pack.yaml-or-directory> [...]

Run deterministic pack authoring/security lint. Optional cases add contract-coverage diagnostics.
`,
	"pack test": `Usage:
  cliharbor pack test --cases <cases.json> <pack.yaml-or-directory>

Run bounded planner contract cases without launching the declared vendor CLI.
`,
	"pack generate-tests": `Usage:
  cliharbor pack generate-tests --output <cases.json> <pack.yaml-or-directory>

Generate a deterministic starter planner-contract fixture. Review generated argv against authoritative vendor evidence.
`,
	"evidence": `Usage:
  cliharbor evidence <inspect|checksum> ...

Inspect or hash CLIHarbor Phase 0 evidence. Run 'cliharbor help evidence <command>' for details.
`,
	"evidence inspect": `Usage:
  cliharbor evidence inspect [--sha256 <64-hex-digest>] <file>

Strictly validate and render one Phase 0 evidence file. With --sha256, byte integrity is checked before rendering.
`,
	"evidence checksum": `Usage:
  cliharbor evidence checksum <file>

Print the SHA-256 of the exact evidence bytes. A checksum is not a signature or host attestation.
`,
	"diagnostics": `Usage:
  cliharbor diagnostics export [options] <output>

Export allowlisted, privacy-preserving support metadata. Run 'cliharbor help diagnostics export' for options.
`,
	"diagnostics export": `Usage:
  cliharbor diagnostics export [--pack-file <file>] [--pack-dir <dir>] [--tool-path <ref=path>] <output>

Write a new diagnostics bundle containing allowlisted metadata only. Command output, argv, environment values, executable paths, browser secrets, and credentials are excluded.
`,
	"evaluation": `Usage:
  cliharbor evaluation preflight [--bundle <directory>]

Verify an extracted qualified Windows evaluation bundle. Run 'cliharbor help evaluation preflight' for details.
`,
	"evaluation preflight": `Usage:
  cliharbor evaluation preflight [--bundle <directory>]

Run vendor-free evaluation-bundle integrity and local-runtime preflight checks.
`,
}

func printHelp(out io.Writer, path []string) error {
	key := strings.Join(path, " ")
	content, ok := helpText[key]
	if !ok {
		if key == "" {
			key = "top-level"
		}
		return fmt.Errorf("unknown help topic %q; run 'cliharbor help' for available commands", key)
	}
	_, err := fmt.Fprint(out, content)
	return err
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "cliharbor: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if path, ok := helpRequest(args); ok {
		return printHelp(os.Stdout, path)
	}
	if len(args) > 0 && args[0] == "evidence" {
		return runEvidenceCommand(args[1:])
	}
	if len(args) > 0 && args[0] == "diagnostics" {
		return runDiagnosticsCommand(args[1:])
	}
	if len(args) > 0 && args[0] == "evaluation" {
		return runEvaluationCommand(args[1:])
	}
	if len(args) > 0 && args[0] == "pack" {
		return runPackCommand(args[1:])
	}

	command := "serve"
	if len(args) > 0 {
		switch args[0] {
		case "serve", "doctor", "inventory", "self-test", "version":
			command = args[0]
			args = args[1:]
		default:
			if !strings.HasPrefix(args[0], "-") {
				return fmt.Errorf("unknown command %q; run 'cliharbor help' for available commands", args[0])
			}
		}
	}

	flags := flag.NewFlagSet("cliharbor", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	webDevURL := flags.String("web-dev-url", "", "development-only Vite origin (must be http://127.0.0.1:<port>)")
	packDirectory := flags.String("pack-dir", "", "explicit trusted directory containing pack YAML files")
	exportPath := flags.String("export", "", "inventory-only sanitized Phase 0 evidence JSON destination")
	noAutoSetup := flags.Bool("no-auto-setup", false, "serve-only: disable automatic current-user setup of missing first-party CLI dependencies")
	noDefaultPacks := flags.Bool("no-default-packs", false, "serve/doctor-only: do not load embedded first-party packs; use only explicitly supplied packs")
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
	if command != "serve" && *noAutoSetup {
		return fmt.Errorf("--no-auto-setup is valid only with serve")
	}
	if command != "serve" && command != "doctor" && *noDefaultPacks {
		return fmt.Errorf("--no-default-packs is valid only with serve or doctor")
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
		Out:                os.Stdout,
		Version:            version,
		Commit:             commit,
		BuildMode:          buildMode,
		Browser:            browser.SystemLauncher(),
		WebDevURL:          *webDevURL,
		PackFiles:          append([]string(nil), packFiles...),
		PackDirectory:      *packDirectory,
		ToolOverrides:      overrides,
		LoadDefaultPacks:   (command == "serve" || command == "doctor") && !*noDefaultPacks,
		AutoProvisionTools: command == "serve" && !*noAutoSetup,
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

func runPackCommand(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: cliharbor pack <init|draft|capture-help|compatibility|validate|lint|test|generate-tests> ...")
	}
	switch args[0] {
	case "init":
		flags := flag.NewFlagSet("cliharbor pack init", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		id := flags.String("id", "", "pack id")
		name := flags.String("name", "", "human-readable pack name")
		toolID := flags.String("tool", "", "tool id")
		executable := flags.String("executable", "", "approved executable basename")
		var platforms stringList
		flags.Var(&platforms, "platform", "supported platform: windows, linux, or darwin (repeatable; defaults to windows)")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 1 || flags.Arg(0) == "" {
			return fmt.Errorf("usage: cliharbor pack init --id <id> --name <name> --tool <tool-id> --executable <basename> [--platform <os>] <output.yaml>")
		}
		return app.InitPack(app.Options{Out: os.Stdout}, app.PackInitConfig{
			ID:             *id,
			Name:           *name,
			ToolID:         *toolID,
			ExecutableName: *executable,
			Platforms:      append([]string(nil), platforms...),
			OutputPath:     flags.Arg(0),
		})
	case "draft":
		flags := flag.NewFlagSet("cliharbor pack draft", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		id := flags.String("id", "", "pack id")
		name := flags.String("name", "", "human-readable pack name")
		toolID := flags.String("tool", "", "tool id")
		executable := flags.String("executable", "", "approved executable basename")
		helpFile := flags.String("help-file", "", "captured vendor --help output to draft reviewable commands from")
		var platforms stringList
		flags.Var(&platforms, "platform", "supported platform: windows, linux, or darwin (repeatable; defaults to windows)")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *helpFile == "" || flags.NArg() != 1 || flags.Arg(0) == "" {
			return fmt.Errorf("usage: cliharbor pack draft --id <id> --name <name> --tool <tool-id> --executable <basename> --help-file <captured-help.txt> [--platform <os>] <output.yaml>")
		}
		return app.DraftPack(app.Options{Out: os.Stdout}, app.PackDraftConfig{
			ID:             *id,
			Name:           *name,
			ToolID:         *toolID,
			ExecutableName: *executable,
			Platforms:      append([]string(nil), platforms...),
			HelpPath:       *helpFile,
			OutputPath:     flags.Arg(0),
		})
	case "capture-help":
		flags := flag.NewFlagSet("cliharbor pack capture-help", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		packDirectory := flags.String("pack-dir", "", "explicit trusted directory containing pack YAML files")
		toolSelector := flags.String("tool", "", "trusted tool selector as pack/tool")
		probeID := flags.String("probe", "", "pack-declared help probe id")
		var packFiles stringList
		var toolPaths stringList
		flags.Var(&packFiles, "pack-file", "explicit trusted pack YAML file (repeatable)")
		flags.Var(&toolPaths, "tool-path", "tool override as pack/tool=/absolute/path (repeatable)")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 1 || flags.Arg(0) == "" || *toolSelector == "" || *probeID == "" {
			return fmt.Errorf("usage: cliharbor pack capture-help --pack-file <pack.yaml> [--pack-file <pack.yaml> ...] [--pack-dir <dir>] --tool <pack/tool> --probe <probe-id> [--tool-path <pack/tool=/absolute/path>] <output.txt>")
		}
		if len(packFiles) == 0 && *packDirectory == "" {
			return fmt.Errorf("pack capture-help requires at least one explicit --pack-file or --pack-dir trust source")
		}
		overrides, err := parseToolOverrides(toolPaths)
		if err != nil {
			return err
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return app.CapturePackHelp(ctx, app.Options{
			Out:           os.Stdout,
			PackFiles:     append([]string(nil), packFiles...),
			PackDirectory: *packDirectory,
			ToolOverrides: overrides,
		}, app.PackHelpCaptureConfig{
			ToolSelector: *toolSelector,
			ProbeID:      *probeID,
			OutputPath:   flags.Arg(0),
		})
	case "compatibility":
		flags := flag.NewFlagSet("cliharbor pack compatibility", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() == 0 {
			return fmt.Errorf("usage: cliharbor pack compatibility <pack.yaml-or-directory> [...]")
		}
		return app.ReportPackCompatibility(app.Options{Out: os.Stdout}, flags.Args())
	case "validate":
		flags := flag.NewFlagSet("cliharbor pack validate", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() == 0 {
			return fmt.Errorf("usage: cliharbor pack validate <pack.yaml-or-directory> [...]")
		}
		return app.ValidatePackPaths(app.Options{Out: os.Stdout}, flags.Args())
	case "lint":
		flags := flag.NewFlagSet("cliharbor pack lint", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		casesPath := flags.String("cases", "", "optional bounded JSON pack contract cases for coverage linting")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() == 0 {
			return fmt.Errorf("usage: cliharbor pack lint [--cases <cases.json>] <pack.yaml-or-directory> [...]")
		}
		return app.LintPackPaths(app.Options{Out: os.Stdout}, flags.Args(), *casesPath)
	case "test":
		flags := flag.NewFlagSet("cliharbor pack test", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		casesPath := flags.String("cases", "", "bounded JSON pack contract cases")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *casesPath == "" || flags.NArg() != 1 || flags.Arg(0) == "" {
			return fmt.Errorf("usage: cliharbor pack test --cases <cases.json> <pack.yaml-or-directory>")
		}
		return app.RunPackTests(app.Options{Out: os.Stdout}, flags.Arg(0), *casesPath)
	case "generate-tests":
		flags := flag.NewFlagSet("cliharbor pack generate-tests", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		outputPath := flags.String("output", "", "new JSON pack contract fixture path")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if *outputPath == "" || flags.NArg() != 1 || flags.Arg(0) == "" {
			return fmt.Errorf("usage: cliharbor pack generate-tests --output <cases.json> <pack.yaml-or-directory>")
		}
		return app.GeneratePackTests(app.Options{Out: os.Stdout}, flags.Arg(0), *outputPath)
	default:
		return fmt.Errorf("unknown pack command %q; run 'cliharbor help pack' for available commands", args[0])
	}
}

func runEvaluationCommand(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: cliharbor evaluation preflight [--bundle <directory>]")
	}
	if args[0] != "preflight" {
		return fmt.Errorf("unknown evaluation command %q; run 'cliharbor help evaluation' for available commands", args[0])
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
	if len(args) == 0 {
		return fmt.Errorf("usage: cliharbor diagnostics export [--pack-file <file>] [--pack-dir <dir>] [--tool-path <pack/tool=/absolute/path>] <output>")
	}
	if args[0] != "export" {
		return fmt.Errorf("unknown diagnostics command %q; run 'cliharbor help diagnostics' for available commands", args[0])
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
		return fmt.Errorf("unknown evidence command %q; run 'cliharbor help evidence' for available commands", args[0])
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
