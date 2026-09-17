package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/Quazmoz/CLIHarbor/internal/app"
)

var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := app.Run(ctx, os.Stdout, version); err != nil {
		fmt.Fprintf(os.Stderr, "cliharbor: %v\n", err)
		os.Exit(1)
	}
}
