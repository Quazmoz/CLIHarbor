package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const moduleLine = "module github.com/Quazmoz/CLIHarbor"

func main() {
	if len(os.Args) != 2 {
		usage()
		os.Exit(2)
	}
	root, err := findRepoRoot()
	if err != nil {
		fatal(err)
	}

	switch os.Args[1] {
	case "web-dev":
		err = run(root, npmCommand(), "run", "dev", "--prefix", filepath.Join(root, "web"))
	case "web-build":
		err = webBuild(root)
	case "sync-web":
		err = syncWeb(root)
	case "check":
		err = check(root)
	case "go-build":
		err = goBuild(root)
	case "build":
		if err = webBuild(root); err == nil {
			err = goBuild(root)
		}
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fatal(err)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: go run ./tools/task <web-dev|web-build|sync-web|check|go-build|build>")
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "task: %v\n", err)
	os.Exit(1)
}

func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("get working directory: %w", err)
	}
	for {
		content, readErr := os.ReadFile(filepath.Join(dir, "go.mod"))
		if readErr == nil && hasExpectedModuleLine(content) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("CLIHarbor repository root not found")
		}
		dir = parent
	}
}

func hasExpectedModuleLine(content []byte) bool {
	firstLine := string(content)
	if end := strings.IndexAny(firstLine, "\r\n"); end >= 0 {
		firstLine = firstLine[:end]
	}
	return strings.TrimSpace(firstLine) == moduleLine
}

func npmCommand() string {
	if runtime.GOOS == "windows" {
		return "npm.cmd"
	}
	return "npm"
}

func webBuild(root string) error {
	web := filepath.Join(root, "web")
	for _, args := range [][]string{
		{"ci", "--prefix", web},
		{"run", "typecheck", "--prefix", web},
		{"run", "lint", "--prefix", web},
		{"test", "--prefix", web},
		{"run", "build", "--prefix", web},
	} {
		if err := run(root, npmCommand(), args...); err != nil {
			return err
		}
	}
	return syncWeb(root)
}

func check(root string) error {
	if err := webBuild(root); err != nil {
		return err
	}
	for _, args := range [][]string{{"vet", "./..."}, {"test", "./..."}} {
		if err := run(root, "go", args...); err != nil {
			return err
		}
	}
	return nil
}

func goBuild(root string) error {
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("create bin directory: %w", err)
	}
	name := "cliharbor"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	version := os.Getenv("CLIHARBOR_VERSION")
	if version == "" {
		version = "dev"
	}
	return run(root, "go", "build", "-trimpath", "-ldflags", "-X main.version="+version, "-o", filepath.Join(binDir, name), "./cmd/cliharbor")
}

func syncWeb(root string) error {
	source := filepath.Join(root, "web", "dist")
	destination := filepath.Join(root, "internal", "webui", "static")
	parent := filepath.Dir(destination)
	staging := filepath.Join(parent, fmt.Sprintf(".static.tmp-%d", os.Getpid()))
	backup := filepath.Join(parent, fmt.Sprintf(".static.old-%d", os.Getpid()))

	if err := os.RemoveAll(staging); err != nil {
		return fmt.Errorf("clean staging directory: %w", err)
	}
	if err := os.RemoveAll(backup); err != nil {
		return fmt.Errorf("clean backup directory: %w", err)
	}
	if err := copyTree(source, staging); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}

	hadDestination := true
	if _, err := os.Stat(destination); errors.Is(err, os.ErrNotExist) {
		hadDestination = false
	} else if err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("inspect embedded frontend destination: %w", err)
	}
	if hadDestination {
		if err := os.Rename(destination, backup); err != nil {
			_ = os.RemoveAll(staging)
			return fmt.Errorf("stage existing embedded frontend: %w", err)
		}
	}
	if err := os.Rename(staging, destination); err != nil {
		if hadDestination {
			_ = os.Rename(backup, destination)
		}
		return fmt.Errorf("activate embedded frontend: %w", err)
	}
	if hadDestination {
		if err := os.RemoveAll(backup); err != nil {
			return fmt.Errorf("remove embedded frontend backup: %w", err)
		}
	}
	return nil
}

func copyTree(source, destination string) error {
	info, err := os.Stat(source)
	if err != nil {
		return fmt.Errorf("frontend build output is unavailable: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("frontend build output is not a directory")
	}
	if err := os.MkdirAll(destination, 0o755); err != nil {
		return fmt.Errorf("create frontend staging directory: %w", err)
	}
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("frontend build contains unsupported symlink: %s", path)
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("frontend build contains unsupported file type: %s", path)
		}
		return copyFile(path, target)
	})
}

func copyFile(source, destination string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func run(root, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = root
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", name, err)
	}
	return nil
}
