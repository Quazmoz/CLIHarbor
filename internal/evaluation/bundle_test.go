package evaluation

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validPhase0Pack = `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: idira-cyberark-phase0
  name: Idira/CyberArk Phase 0 Inventory
  version: 0.1.0
runtime:
  platforms: [windows]
  tools:
    idsec:
      executableNames: [idsec]
    conjur:
      executableNames: [conjur]
commands: {}
`

func TestVerifyBundleAcceptsQualifiedBundle(t *testing.T) {
	root := makeBundle(t, validPhase0Pack)
	if err := VerifyExtractedLayout(root); err != nil {
		t.Fatalf("VerifyExtractedLayout() error = %v", err)
	}
	if err := VerifyBundle(root); err != nil {
		t.Fatalf("VerifyBundle() error = %v", err)
	}
}

func TestVerifyIntegrityRejectsDigestMismatches(t *testing.T) {
	for _, name := range []string{ExecutablePath, PackPath} {
		t.Run(name, func(t *testing.T) {
			root := makeBundle(t, validPhase0Pack)
			filename := filepath.Join(root, filepath.FromSlash(name))
			if err := os.WriteFile(filename, []byte("changed"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := VerifyIntegrity(root); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
				t.Fatalf("VerifyIntegrity() error = %v, want checksum mismatch", err)
			}
		})
	}
}

func TestVerifyIntegrityRejectsMissingMalformedUnexpectedAndDuplicateManifest(t *testing.T) {
	const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	tests := map[string]func(t *testing.T, root string){
		"missing": func(t *testing.T, root string) {
			if err := os.Remove(filepath.Join(root, ManifestName)); err != nil {
				t.Fatal(err)
			}
		},
		"malformed": func(t *testing.T, root string) {
			if err := os.WriteFile(filepath.Join(root, ManifestName), []byte("not-a-manifest\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"unexpected entry": func(t *testing.T, root string) {
			content, err := os.ReadFile(filepath.Join(root, ManifestName))
			if err != nil {
				t.Fatal(err)
			}
			content = append(content, []byte(digest+"  z-extra.txt\n")...)
			if err := os.WriteFile(filepath.Join(root, ManifestName), content, 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"case duplicate": func(t *testing.T, root string) {
			if err := os.WriteFile(filepath.Join(root, ManifestName), []byte(digest+"  bin/cliharbor-windows-x64-evaluation.exe\n"+digest+"  BIN/CLIHARBOR-WINDOWS-X64-EVALUATION.EXE\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			root := makeBundle(t, validPhase0Pack)
			mutate(t, root)
			if err := VerifyIntegrity(root); err == nil {
				t.Fatal("VerifyIntegrity() unexpectedly succeeded")
			}
		})
	}
}

func TestVerifyBundleRejectsMissingPack(t *testing.T) {
	root := makeBundle(t, validPhase0Pack)
	if err := os.Remove(filepath.Join(root, filepath.FromSlash(PackPath))); err != nil {
		t.Fatal(err)
	}
	if err := VerifyBundle(root); err == nil {
		t.Fatal("VerifyBundle() unexpectedly succeeded")
	}
}

func TestVerifyBundleRejectsPackAuthorityExpansionEvenWithRegeneratedManifest(t *testing.T) {
	tests := map[string]string{
		"command": strings.Replace(validPhase0Pack, "commands: {}", `commands:
  inspect:
    name: Inspect
    tool: idsec
    risk: read
    argv: [{literal: inspect}]
    output: {mode: raw}`, 1),
		"version probe": strings.Replace(validPhase0Pack, "      executableNames: [idsec]", "      executableNames: [idsec]\n      versionProbe:\n        args: [--version]\n        parser: semver-text", 1),
		"help probe":    strings.Replace(validPhase0Pack, "      executableNames: [idsec]", "      executableNames: [idsec]\n      helpProbes:\n        root:\n          args: [--help]", 1),
		"wrong id":      strings.Replace(validPhase0Pack, "id: idira-cyberark-phase0", "id: other-phase0", 1),
		"wrong version": strings.Replace(validPhase0Pack, "version: 0.1.0", "version: 0.2.0", 1),
	}
	for name, pack := range tests {
		t.Run(name, func(t *testing.T) {
			root := makeBundle(t, pack)
			if err := VerifyIntegrity(root); err != nil {
				t.Fatalf("VerifyIntegrity() error = %v", err)
			}
			if err := VerifyBundle(root); err == nil {
				t.Fatal("VerifyBundle() unexpectedly accepted expanded pack authority")
			}
		})
	}
}

func TestVerifyExtractedLayoutRejectsUnexpectedEntry(t *testing.T) {
	root := makeBundle(t, validPhase0Pack)
	if err := os.WriteFile(filepath.Join(root, "extra.txt"), []byte("extra"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyExtractedLayout(root); err == nil || !strings.Contains(err.Error(), "unexpected evaluation bundle entry") {
		t.Fatalf("VerifyExtractedLayout() error = %v", err)
	}
}

func TestVerifyBundleRejectsSymlinkedPrivilegedFile(t *testing.T) {
	root := makeBundle(t, validPhase0Pack)
	pack := filepath.Join(root, filepath.FromSlash(PackPath))
	target := filepath.Join(root, "real-pack.yaml")
	if err := os.WriteFile(target, []byte(validPhase0Pack), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(pack); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, pack); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := VerifyBundle(root); err == nil {
		t.Fatal("VerifyBundle() unexpectedly accepted symlink")
	}
}

func makeBundle(t *testing.T, pack string) string {
	t.Helper()
	root := t.TempDir()
	executable := filepath.Join(root, filepath.FromSlash(ExecutablePath))
	packPath := filepath.Join(root, filepath.FromSlash(PackPath))
	if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(packPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("evaluation executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(packPath, []byte(pack), 0o644); err != nil {
		t.Fatal(err)
	}
	writeTestManifest(t, root)
	return root
}

func writeTestManifest(t *testing.T, root string) {
	t.Helper()
	lines := make([]string, 0, len(requiredPaths))
	for _, name := range requiredPaths {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		lines = append(lines, hex.EncodeToString(digest[:])+"  "+name)
	}
	if err := os.WriteFile(filepath.Join(root, ManifestName), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}
