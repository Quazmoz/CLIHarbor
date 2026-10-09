package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWebSourceFingerprintDetectsSourceChangesNotBuildOutput(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	web := filepath.Join(root, "web")
	static := filepath.Join(root, "internal", "webui", "static")
	for _, dir := range []string{filepath.Join(web, "src"), filepath.Join(web, "dist"), filepath.Join(web, "node_modules"), static} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	source := filepath.Join(web, "src", "App.tsx")
	for path, data := range map[string]string{
		filepath.Join(web, "package.json"): "{}",
		source: "export const app = true",
	} {
		if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := writeWebSourceFingerprint(root, static); err != nil {
		t.Fatal(err)
	}
	original, err := webSourceFingerprint(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(web, "dist", "index.js"), filepath.Join(web, "node_modules", "cache.js")} {
		if err := os.WriteFile(path, []byte("generated"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	after, err := webSourceFingerprint(root)
	if err != nil || original != after {
		t.Fatalf("build output affected source fingerprint: %q vs %q, %v", original, after, err)
	}
	if err := verifyWebSourceFingerprint(root); err != nil {
		t.Fatalf("matching source fingerprint rejected: %v", err)
	}
	if err := os.WriteFile(source, []byte("export const app = false"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyWebSourceFingerprint(root); err == nil {
		t.Fatal("stale generated assets accepted after source change")
	}
	if err := writeWebSourceFingerprint(root, static); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(web, "package-lock.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyWebSourceFingerprint(root); err == nil {
		t.Fatal("stale generated assets accepted after lockfile change")
	}
}

func TestWebSourceFingerprintRejectsSymlinkAndMissingRecord(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	web := filepath.Join(root, "web")
	static := filepath.Join(root, "internal", "webui", "static")
	if err := os.MkdirAll(web, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(static, 0o755); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(web, "package.json")
	if err := os.WriteFile(source, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyWebSourceFingerprint(root); err == nil {
		t.Fatal("missing fingerprint was accepted")
	}
	link := filepath.Join(web, "linked")
	if err := os.Symlink(source, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := webSourceFingerprint(root); err == nil {
		t.Fatal("symlinked source was accepted")
	}
}

func TestVerifyWebSyncRejectsCleanCommittedSourceDrift(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git unavailable: %v", err)
	}
	root := t.TempDir()
	web := filepath.Join(root, "web")
	static := filepath.Join(root, "internal", "webui", "static")
	for _, dir := range []string{web, static} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	src := filepath.Join(web, "index.html")
	if err := os.WriteFile(src, []byte("<main>old</main>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(static, "index.html"), []byte("<main>old</main>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeWebSourceFingerprint(root, static); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	git("init", "--quiet")
	git("add", ".")
	git("-c", "user.name=CLIHarbor Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial")
	if err := verifyWebSync(root); err != nil {
		t.Fatalf("synchronized checkout rejected: %v", err)
	}
	if err := os.WriteFile(src, []byte("<main>new</main>"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("-c", "user.name=CLIHarbor Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source only")
	cmd := exec.Command("git", "status", "--porcelain=v1")
	cmd.Dir = root
	if result, err := cmd.CombinedOutput(); err != nil || strings.TrimSpace(string(result)) != "" {
		t.Fatalf("fixture is not clean: %s, %v", result, err)
	}
	if err := verifyWebSync(root); err == nil {
		t.Fatal("clean checkout with stale committed frontend was accepted")
	}
}
