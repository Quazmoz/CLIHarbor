package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const webSourceFingerprintFile = "web-source.sha256"

// webSourceFingerprint records every build input under web/, but excludes
// install/build/test outputs. Sorting and length-prefixing make the digest
// independent of filesystem traversal order and unambiguous across paths.
func webSourceFingerprint(root string) (string, error) {
	webRoot := filepath.Join(root, "web")
	paths := make([]string, 0, 64)
	err := filepath.WalkDir(webRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(webRoot, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if entry.IsDir() {
			switch filepath.ToSlash(rel) {
			case "dist", "node_modules", "coverage", ".git":
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("frontend source contains unsupported file: %s", rel)
		}
		paths = append(paths, path)
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("enumerate frontend source: %w", err)
	}
	if len(paths) == 0 {
		return "", fmt.Errorf("frontend source is empty")
	}
	sort.Strings(paths)
	hash := sha256.New()
	for _, path := range paths {
		rel, err := filepath.Rel(webRoot, path)
		if err != nil {
			return "", err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read frontend source %s: %w", rel, err)
		}
		name := filepath.ToSlash(rel)
		_, _ = fmt.Fprintf(hash, "%d:%s:%d:", len(name), name, len(data))
		_, _ = hash.Write(data)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func writeWebSourceFingerprint(root, destination string) error {
	digest, err := webSourceFingerprint(root)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(destination, webSourceFingerprintFile), []byte(digest+"\n"), 0o644)
}

func verifyWebSourceFingerprint(root string) error {
	digest, err := webSourceFingerprint(root)
	if err != nil {
		return err
	}
	recorded, err := os.ReadFile(filepath.Join(root, "internal", "webui", "static", webSourceFingerprintFile))
	if err != nil {
		return fmt.Errorf("embedded frontend source fingerprint unavailable; rebuild and commit internal/webui/static: %w", err)
	}
	if strings.TrimSpace(string(recorded)) != digest || string(recorded) != digest+"\n" {
		return fmt.Errorf("embedded frontend source fingerprint differs from web/; run go run ./tools/task web-build and commit internal/webui/static")
	}
	return nil
}
