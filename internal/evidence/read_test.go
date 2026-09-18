package evidence

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseStrictEvidenceRoundTrip(t *testing.T) {
	payload, err := json.Marshal(testBundle())
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := Parse(payload)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if len(bundle.Tools) != 1 || bundle.Tools[0].Probes[0].Identity != "demo/tool/help" {
		t.Fatalf("parsed bundle = %#v", bundle)
	}
}

func TestParseRejectsUnknownDuplicateMalformedAndOversizedEvidence(t *testing.T) {
	base, err := json.Marshal(testBundle())
	if err != nil {
		t.Fatal(err)
	}
	unknown := strings.Replace(string(base), `"schemaVersion":"cliharbor.phase0/v1"`, `"schemaVersion":"cliharbor.phase0/v1","surprise":true`, 1)
	duplicate := strings.Replace(string(base), `"schemaVersion":"cliharbor.phase0/v1"`, `"schemaVersion":"cliharbor.phase0/v1","schemaVersion":"cliharbor.phase0/v1"`, 1)
	invalid := append([]byte("{\"schemaVersion\":\"cliharbor.phase0/v1\",\"x\":\""), 0xff)

	for name, payload := range map[string][]byte{
		"unknown":      unknownBytes(unknown),
		"duplicate":    unknownBytes(duplicate),
		"invalid-utf8": invalid,
		"oversized":    []byte(strings.Repeat(" ", maxSerializedBundle+1)),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(payload); err == nil {
				t.Fatalf("Parse(%s) unexpectedly succeeded", name)
			}
		})
	}
}

func unknownBytes(value string) []byte { return []byte(value) }

func TestValidateRejectsDuplicateIdentitiesAndImpossibleStates(t *testing.T) {
	tests := map[string]func(*Bundle){
		"duplicate tool":                        func(b *Bundle) { b.Tools = append(b.Tools, b.Tools[0]) },
		"duplicate probe":                       func(b *Bundle) { b.Tools[0].Probes = append(b.Tools[0].Probes, b.Tools[0].Probes[0]) },
		"ambiguous candidate mismatch":          func(b *Bundle) { b.Tools[0].Status = "ambiguous" },
		"missing version from configured probe": func(b *Bundle) { b.Tools[0].VersionProbeConfigured = true },
		"timeout flag mismatch":                 func(b *Bundle) { b.Tools[0].Probes[0].Status = "timed-out" },
		"nonexecuted carries timestamps": func(b *Bundle) {
			b.Tools[0].Probes[0].Status = "unavailable"
			b.Tools[0].Probes[0].Diagnostic = "safe"
		},
		"misleading timestamp": func(b *Bundle) {
			late := b.GeneratedAt.Add(maxEvidenceCaptureSpan + time.Second)
			b.Tools[0].Probes[0].EndedAt = &late
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			bundle := testBundle()
			mutate(&bundle)
			if err := Validate(bundle); err == nil {
				t.Fatalf("Validate(%s) unexpectedly succeeded", name)
			}
		})
	}
}

func TestValidateRejectsMalformedVersionsProvenanceControlsSecretsAndPaths(t *testing.T) {
	tests := map[string]func(*Bundle){
		"pack version": func(b *Bundle) { b.Tools[0].PackVersion = "v1" },
		"tool version": func(b *Bundle) {
			b.Tools[0].VersionProbeConfigured = true
			b.Tools[0].Version = "one.two"
		},
		"constraint": func(b *Bundle) {
			b.Tools[0].VersionProbeConfigured = true
			b.Tools[0].Version = "1.0.0"
			b.Tools[0].VersionConstraint = "definitely not a constraint"
		},
		"identity":        func(b *Bundle) { b.Tools[0].Probes[0].Identity = "other/tool/help" },
		"undeclared help": func(b *Bundle) { b.Tools[0].AvailableHelpProbes = nil },
		"control":         func(b *Bundle) { b.Tools[0].Probes[0].Stdout = "safe\x00unsafe" },
		"secret":          func(b *Bundle) { b.Tools[0].Probes[0].Stdout = "Authorization: Bearer raw-token" },
		"path":            func(b *Bundle) { b.Tools[0].Probes[0].Stdout = "C:\\Users\\operator\\vendor.exe" },
		"environment":     func(b *Bundle) { b.Tools[0].Probes[0].Stdout = "PATH=C:\\Windows\\System32" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			bundle := testBundle()
			mutate(&bundle)
			if err := Validate(bundle); err == nil {
				t.Fatalf("Validate(%s) unexpectedly succeeded", name)
			}
		})
	}
}

func TestReadBundleRejectsSymlinkAndAcceptsRegularFile(t *testing.T) {
	dir := t.TempDir()
	regular := filepath.Join(dir, "phase0.json")
	if err := WriteBundle(nil, regular, testBundle()); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadBundle(regular); err != nil {
		t.Fatalf("ReadBundle(regular) error = %v", err)
	}
	link := filepath.Join(dir, "phase0-link.json")
	if err := os.Symlink(regular, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := ReadBundle(link); err == nil {
		t.Fatal("ReadBundle(symlink) unexpectedly succeeded")
	}
}
