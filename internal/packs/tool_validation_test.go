package packs

import (
	"strings"
	"testing"
)

func TestVersionConstraintRequiresProbe(t *testing.T) {
	pack := strings.Replace(minimalPack, "      executableNames: [fixture-cli]\n", "      executableNames: [fixture-cli]\n      versionConstraint: '>=1.0.0'\n", 1)
	_, err := Parse([]byte(pack))
	if err == nil {
		t.Fatal("Parse() unexpectedly accepted versionConstraint without versionProbe")
	}
}

func TestVersionConstraintRejectsInvalidSyntax(t *testing.T) {
	pack := strings.Replace(minimalPack, "      executableNames: [fixture-cli]\n", "      executableNames: [fixture-cli]\n      versionProbe:\n        args: [--version]\n        parser: semver-text\n      versionConstraint: 'definitely-not-semver'\n", 1)
	_, err := Parse([]byte(pack))
	if err == nil {
		t.Fatal("Parse() unexpectedly accepted invalid versionConstraint")
	}
}

func TestVersionProbeAccepted(t *testing.T) {
	pack := strings.Replace(minimalPack, "      executableNames: [fixture-cli]\n", "      executableNames: [fixture-cli]\n      versionProbe:\n        args: [--version]\n        parser: semver-text\n        timeoutMillis: 1500\n      versionConstraint: '>=1.0.0 <2.0.0'\n", 1)
	parsed, err := Parse([]byte(pack))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	probe := parsed.Runtime.Tools["fixture"].VersionProbe
	if probe == nil || len(probe.Args) != 1 || probe.Args[0] != "--version" || probe.TimeoutMillis != 1500 {
		t.Fatalf("probe = %#v", probe)
	}
}

func TestVersionProbeRejectsUnknownParser(t *testing.T) {
	pack := strings.Replace(minimalPack, "      executableNames: [fixture-cli]\n", "      executableNames: [fixture-cli]\n      versionProbe:\n        parser: arbitrary\n", 1)
	_, err := Parse([]byte(pack))
	assertCode(t, err, ErrSchema)
}
