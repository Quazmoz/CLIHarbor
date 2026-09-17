package browser

import (
	"fmt"
	"net/url"
	"strconv"
)

// Launcher opens the secure one-time browser bootstrap URL.
type Launcher interface {
	OpenBootstrap(string) error
}

// LauncherFunc adapts a function for tests and application wiring.
type LauncherFunc func(string) error

func (f LauncherFunc) OpenBootstrap(rawURL string) error {
	return f(rawURL)
}

type systemLauncher struct{}

// SystemLauncher returns the platform default-browser implementation.
func SystemLauncher() Launcher {
	return systemLauncher{}
}

func (systemLauncher) OpenBootstrap(rawURL string) error {
	if err := validateBootstrapURL(rawURL); err != nil {
		return err
	}
	return openSystemBrowser(rawURL)
}

func validateBootstrapURL(rawURL string) error {
	target, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid bootstrap URL")
	}
	if target.Scheme != "http" || target.Hostname() != "127.0.0.1" || target.User != nil || target.Fragment != "" || target.Path != "/bootstrap" {
		return fmt.Errorf("bootstrap URL is not an IPv4 loopback handoff")
	}
	port, err := strconv.Atoi(target.Port())
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("bootstrap URL has an invalid port")
	}
	values := target.Query()
	tokens, ok := values["token"]
	if !ok || len(values) != 1 || len(tokens) != 1 || tokens[0] == "" {
		return fmt.Errorf("bootstrap URL has an invalid token handoff")
	}
	return nil
}
