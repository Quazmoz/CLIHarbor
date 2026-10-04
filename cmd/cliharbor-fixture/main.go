// cliharbor-fixture is a credential-free local CLI for the example pack.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"time"
)

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 1 && args[0] == "--version" {
		fmt.Fprintln(stdout, "cliharbor-fixture 1.0.0")
		return 0
	}
	if len(args) == 0 || (len(args) == 1 && (args[0] == "--help" || args[0] == "help")) {
		fmt.Fprintln(stdout, "Usage: cliharbor-fixture --version | inspect [--limit 1..1000] [--verbose] (--safe-mode | --detailed-mode) | wait [--seconds 1..60] | fail")
		return 0
	}
	flags := flag.NewFlagSet("cliharbor-fixture "+args[0], flag.ContinueOnError)
	flags.SetOutput(stderr)
	switch args[0] {
	case "inspect":
		limit := flags.Int("limit", 3, "synthetic result count (1..1000)")
		verbose := flags.Bool("verbose", false, "write a separate stderr message")
		safe := flags.Bool("safe-mode", false, "safe output mode")
		detailed := flags.Bool("detailed-mode", false, "detailed output mode")
		if flags.Parse(args[1:]) != nil {
			return 2
		}
		if flags.NArg() != 0 || *limit < 1 || *limit > 1000 || *safe == *detailed {
			fmt.Fprintln(stderr, "inspect requires one mode and a limit between 1 and 1000")
			return 2
		}
		mode := "safe"
		if *detailed {
			mode = "detailed"
		}
		if *verbose {
			fmt.Fprintln(stderr, "Synthetic inspection complete; no files or credentials were read.")
		}
		if err := json.NewEncoder(stdout).Encode(struct {
			Platform string `json:"platform"`
			Mode     string `json:"mode"`
			Count    int    `json:"count"`
			OK       bool   `json:"ok"`
		}{runtime.GOOS, mode, *limit, true}); err != nil {
			return 1
		}
		return 0
	case "wait":
		seconds := flags.Int("seconds", 10, "stream duration (1..60 seconds)")
		if flags.Parse(args[1:]) != nil {
			return 2
		}
		if flags.NArg() != 0 || *seconds < 1 || *seconds > 60 {
			fmt.Fprintln(stderr, "wait requires a duration between 1 and 60 seconds")
			return 2
		}
		fmt.Fprintln(stdout, "ready: cancel this run to test process cleanup")
		for i := 1; i <= *seconds; i++ {
			time.Sleep(time.Second)
			if _, err := fmt.Fprintf(stdout, "tick %d\n", i); err != nil {
				return 1
			}
		}
		return 0
	case "fail":
		if len(args) != 1 {
			return 2
		}
		fmt.Fprintln(stderr, "Deliberate test failure (exit 42).")
		return 42
	default:
		fmt.Fprintln(stderr, "unknown command; use --help")
		return 2
	}
}
