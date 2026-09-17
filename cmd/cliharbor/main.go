package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/Quazmoz/CLIHarbor/internal/app"
	"github.com/Quazmoz/CLIHarbor/internal/platform/browser"
)

var version = "dev"

func main() {
	webDevURL := flag.String("web-dev-url", "", "development-only Vite origin (must be http://127.0.0.1:<port>)")
	flag.Parse()
	if flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "cliharbor: unexpected positional arguments")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := app.Run(ctx, app.Options{
		Out:       os.Stdout,
		Version:   version,
		Browser:   browser.SystemLauncher(),
		WebDevURL: *webDevURL,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "cliharbor: %v\n", err)
		os.Exit(1)
	}
}
