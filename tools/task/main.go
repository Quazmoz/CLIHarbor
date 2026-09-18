package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
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
	case "windows-eval":
		err = windowsEvalBuild(root)
	case "verify-windows-eval":
		err = verifyWindowsEvaluation(root)
	case "verify-windows-eval-repro":
		err = verifyWindowsEvaluationReproducible(root)
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
	fmt.Fprintln(os.Stderr, "usage: go run ./tools/task <web-dev|web-build|sync-web|check|go-build|windows-eval|verify-windows-eval|verify-windows-eval-repro|build>")
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
	if err := run(root, "go", "mod", "verify"); err != nil {
		return err
	}
	for _, args := range [][]string{{"vet", "./..."}, {"test", "-timeout", "2m", "./..."}} {
		if err := run(root, "go", args...); err != nil {
			return err
		}
	}
	return nil
}

func goBuild(root string) error {
	name := "cliharbor"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	artifact := filepath.Join(root, "bin", name)
	checksum := filepath.Join(root, "bin", "SHA256SUMS")
	if err := removeGeneratedChecksum(filepath.Join(root, evaluationManifestName)); err != nil {
		return err
	}
	if err := removeGeneratedChecksum(checksum); err != nil {
		return err
	}
	if err := buildExecutable(root, artifact, "", "", "local-unsigned", "dev"); err != nil {
		return err
	}
	return writeSHA256Sums(artifact, checksum)
}

func windowsEvalBuild(root string) error {
	if err := validateEvaluationToolchain(root); err != nil {
		return err
	}
	manifest := filepath.Join(root, evaluationManifestName)
	compatibilityManifest := filepath.Join(root, "bin", "SHA256SUMS")
	if err := removeGeneratedChecksum(manifest); err != nil {
		return err
	}
	if err := removeGeneratedChecksum(compatibilityManifest); err != nil {
		return err
	}

	buildCache, err := os.MkdirTemp("", "cliharbor-eval-gocache-")
	if err != nil {
		return fmt.Errorf("create isolated evaluation build cache: %w", err)
	}
	defer os.RemoveAll(buildCache)

	artifact := filepath.Join(root, evaluationExecutablePath)
	if err := buildExecutableWithEnv(
		root,
		artifact,
		"windows",
		"amd64",
		"evaluation-unsigned",
		"0.0.0-eval",
		evaluationBuildEnvironment(buildCache),
	); err != nil {
		return err
	}
	if err := writeSHA256Manifest(root, manifest, []string{
		artifact,
		filepath.Join(root, filepath.FromSlash(evaluationPackPath)),
	}); err != nil {
		return err
	}
	return verifyWindowsEvaluation(root)
}

func buildExecutable(root, artifact, goos, goarch, mode, defaultVersion string) error {
	return buildExecutableWithEnv(root, artifact, goos, goarch, mode, defaultVersion, nil)
}

func buildExecutableWithEnv(
	root, artifact, goos, goarch, mode, defaultVersion string,
	buildEnv map[string]string,
) error {
	binDir := filepath.Dir(artifact)
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("create bin directory: %w", err)
	}
	version := os.Getenv("CLIHARBOR_VERSION")
	if version == "" {
		version = defaultVersion
	}
	if err := validateBuildVersion(version); err != nil {
		return err
	}
	commit := os.Getenv("CLIHARBOR_COMMIT")
	if commit == "" {
		commit = repositoryCommit(root)
	}
	if err := validateBuildMetadataToken("CLIHARBOR_COMMIT", commit); err != nil {
		return err
	}
	if err := validateBuildMetadataToken("build mode", mode); err != nil {
		return err
	}

	ldflags := strings.Join([]string{
		"-X", "main.version=" + version,
		"-X", "main.commit=" + commit,
		"-X", "main.buildMode=" + mode,
	}, " ")
	args := []string{"build", "-trimpath", "-buildvcs=false", "-ldflags", ldflags, "-o", artifact, "./cmd/cliharbor"}
	env := make(map[string]string, len(buildEnv)+3)
	for key, value := range buildEnv {
		env[key] = value
	}
	if goos != "" {
		env["GOOS"] = goos
	}
	if goarch != "" {
		env["GOARCH"] = goarch
	}
	if goos != "" || goarch != "" {
		env["CGO_ENABLED"] = "0"
	}
	if err := runWithEnv(root, env, "go", args...); err != nil {
		return err
	}
	return nil
}

func repositoryCommit(root string) string {
	cmd := exec.Command("git", "rev-parse", "--verify", "HEAD")
	cmd.Dir = root
	output, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	value := strings.TrimSpace(string(output))
	if len(value) != 40 {
		return "unknown"
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') && (char < 'A' || char > 'F') {
			return "unknown"
		}
	}
	return strings.ToLower(value)
}

func validateBuildMetadataToken(name, value string) error {
	if len(value) == 0 || len(value) > 128 {
		return fmt.Errorf("%s must be 1-128 ASCII token characters", name)
	}
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z':
		case char >= 'A' && char <= 'Z':
		case char >= '0' && char <= '9':
		case char == '.', char == '-', char == '_', char == '+':
		default:
			return fmt.Errorf("%s contains unsupported character %q", name, char)
		}
	}
	return nil
}

func validateBuildVersion(version string) error {
	if len(version) == 0 || len(version) > 128 {
		return fmt.Errorf("CLIHARBOR_VERSION must be 1-128 ASCII version-token characters")
	}
	for _, char := range version {
		switch {
		case char >= 'a' && char <= 'z':
		case char >= 'A' && char <= 'Z':
		case char >= '0' && char <= '9':
		case char == '.', char == '-', char == '_', char == '+':
		default:
			return fmt.Errorf("CLIHARBOR_VERSION contains unsupported character %q", char)
		}
	}
	return nil
}

func writeSHA256Sums(artifact, destination string) error {
	return writeSHA256Manifest(filepath.Dir(artifact), destination, []string{artifact})
}

func writeSHA256Manifest(root, destination string, artifacts []string) error {
	if len(artifacts) == 0 {
		return fmt.Errorf("checksum manifest requires at least one artifact")
	}
	rootPath, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("resolve checksum manifest root: %w", err)
	}

	entries := make([]string, 0, len(artifacts))
	seen := make(map[string]struct{}, len(artifacts))
	for _, artifact := range artifacts {
		artifactPath, err := filepath.Abs(artifact)
		if err != nil {
			return fmt.Errorf("resolve checksum artifact: %w", err)
		}
		relative, err := filepath.Rel(rootPath, artifactPath)
		if err != nil {
			return fmt.Errorf("resolve checksum artifact relative path: %w", err)
		}
		if relative == "." || relative == ".." || filepath.IsAbs(relative) ||
			strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("checksum artifact must remain inside manifest root")
		}
		info, err := os.Lstat(artifactPath)
		if err != nil {
			return fmt.Errorf("inspect checksum artifact %s: %w", filepath.ToSlash(relative), err)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("checksum artifact %s must be a regular non-symlink file", filepath.ToSlash(relative))
		}
		name := filepath.ToSlash(relative)
		if strings.ContainsAny(name, "\r\n") {
			return fmt.Errorf("checksum artifact path contains unsupported newline")
		}
		if _, exists := seen[name]; exists {
			return fmt.Errorf("duplicate checksum artifact %s", name)
		}
		seen[name] = struct{}{}

		digest, err := sha256File(artifactPath, info)
		if err != nil {
			return err
		}
		entries = append(entries, hex.EncodeToString(digest)+"  "+name)
	}
	sort.Strings(entries)
	return writeChecksumFile(destination, strings.Join(entries, "\n")+"\n")
}

func sha256File(path string, expected os.FileInfo) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open build artifact for checksum: %w", err)
	}
	opened, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("inspect opened build artifact: %w", err)
	}
	if !opened.Mode().IsRegular() || !os.SameFile(expected, opened) ||
		expected.Size() != opened.Size() || !expected.ModTime().Equal(opened.ModTime()) {
		_ = file.Close()
		return nil, fmt.Errorf("build artifact changed before checksum")
	}

	firstHasher := sha256.New()
	if _, err := io.Copy(firstHasher, file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("hash build artifact: %w", err)
	}
	middle, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("reinspect opened build artifact after checksum: %w", err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("rewind build artifact for checksum verification: %w", err)
	}
	secondHasher := sha256.New()
	if _, err := io.Copy(secondHasher, file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("rehash build artifact: %w", err)
	}
	finished, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("reinspect opened build artifact: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, fmt.Errorf("close build artifact after checksum: %w", err)
	}
	current, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("reinspect checksum artifact: %w", err)
	}
	firstDigest := firstHasher.Sum(nil)
	secondDigest := secondHasher.Sum(nil)
	if !bytes.Equal(firstDigest, secondDigest) ||
		current.Mode()&os.ModeSymlink != 0 || !current.Mode().IsRegular() ||
		!os.SameFile(opened, current) ||
		opened.Size() != middle.Size() || !opened.ModTime().Equal(middle.ModTime()) ||
		middle.Size() != finished.Size() || !middle.ModTime().Equal(finished.ModTime()) ||
		finished.Size() != current.Size() || !finished.ModTime().Equal(current.ModTime()) {
		return nil, fmt.Errorf("build artifact changed while checksum was calculated")
	}
	return firstDigest, nil
}

func writeChecksumFile(destination, content string) error {
	dir := filepath.Dir(destination)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create checksum directory: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".SHA256SUMS-")
	if err != nil {
		return fmt.Errorf("create checksum staging file: %w", err)
	}
	tempName := temp.Name()
	cleanup := func() { _ = os.Remove(tempName) }
	if _, err := io.WriteString(temp, content); err != nil {
		_ = temp.Close()
		cleanup()
		return fmt.Errorf("write checksum staging file: %w", err)
	}
	if err := temp.Chmod(0o644); err != nil {
		_ = temp.Close()
		cleanup()
		return fmt.Errorf("set checksum file permissions: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		cleanup()
		return fmt.Errorf("sync checksum staging file: %w", err)
	}
	if err := temp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close checksum staging file: %w", err)
	}
	if err := activateChecksumFile(tempName, destination); err != nil {
		cleanup()
		return fmt.Errorf("activate checksum file without replacement: %w", err)
	}
	return nil
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
	return runWithEnv(root, nil, name, args...)
}

func runWithEnv(root string, extraEnv map[string]string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = root
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = mergeEnvironment(os.Environ(), extraEnv)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", name, err)
	}
	return nil
}
