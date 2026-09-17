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

var version = "dev"

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
	command := "serve"
	if len(args) > 0 && args[0] == "doctor" {
		command = "doctor"
		args = args[1:]
	}

	flags := flag.NewFlagSet("cliharbor", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	webDevURL := flags.String("web-dev-url", "", "development-only Vite origin (must be http://127.0.0.1:<port>)")
	packDirectory := flags.String("pack-dir", "", "explicit trusted directory containing pack YAML files")
	var packFiles stringList
	var toolPaths stringList
	flags.Var(&packFiles, "pack-file", "explicit trusted pack YAML file (repeatable)")
	flags.Var(&toolPaths, "tool-path", "tool override as pack/tool=/absolute/path (repeatable)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments")
	}
	if command == "doctor" && *webDevURL != "" {
		return fmt.Errorf("--web-dev-url is not valid with doctor")
	}
	overrides, err := parseToolOverrides(toolPaths)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	options := app.Options{
		Out:           os.Stdout,
		Version:       version,
		Browser:       browser.SystemLauncher(),
		WebDevURL:     *webDevURL,
		PackFiles:     append([]string(nil), packFiles...),
		PackDirectory: *packDirectory,
		ToolOverrides: overrides,
	}
	if command == "doctor" {
		return app.Doctor(ctx, options)
	}
	return app.Run(ctx, options)
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
