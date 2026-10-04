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

func TestVersionProbePrefixRejectsMultiline(t *testing.T) {
	pack := strings.Replace(minimalPack, "      executableNames: [fixture-cli]\n", "      executableNames: [fixture-cli]\n      versionProbe:\n        parser: semver-text\n        prefix: \"Client\\nVersion:\"\n", 1)
	if _, err := Parse([]byte(pack)); err == nil {
		t.Fatal("Parse() unexpectedly accepted a multi-line versionProbe prefix")
	}
}


func validPortableInstallPack() string {
	return strings.Replace(minimalPack, "      executableNames: [fixture-cli]\n", `      executableNames: [fixture-cli]
      versionProbe:
        args: [--version]
        parser: semver-text
      versionConstraint: '>=1.0.0 <2.0.0'
      install:
        version: 1.2.3
        artifacts:
          windows-amd64:
            url: https://downloads.example.com/fixture-cli.exe
            sha256: 0000000000000000000000000000000000000000000000000000000000000000
            sizeBytes: 1234
            format: executable
            executableName: fixture-cli.exe
            redirectHosts: [cdn.example.com]
`, 1)
}

func TestPortableInstallValidationIsAppliedDuringParse(t *testing.T) {
	pack, err := Parse([]byte(validPortableInstallPack()))
	if err != nil {
		t.Fatalf("Parse() valid portable install error = %v", err)
	}
	install := pack.Runtime.Tools["fixture"].Install
	if install == nil || install.Version != "1.2.3" || len(install.Artifacts) != 1 {
		t.Fatalf("portable install = %#v", install)
	}
}

func TestPortableInstallValidationRejectsUnsafeOrIncompatibleMetadata(t *testing.T) {
	valid := validPortableInstallPack()
	tests := []struct {
		name string
		data string
	}{
		{
			name: "artifact platform outside runtime platforms",
			data: strings.Replace(valid, "          windows-amd64:\n", "          linux-amd64:\n", 1),
		},
		{
			name: "artifact URL custom port",
			data: strings.Replace(valid, "https://downloads.example.com/fixture-cli.exe", "https://downloads.example.com:8443/fixture-cli.exe", 1),
		},
		{
			name: "artifact executable mismatch",
			data: strings.Replace(valid, "            executableName: fixture-cli.exe\n", "            executableName: other.exe\n", 1),
		},
		{
			name: "managed version outside declared constraint",
			data: strings.Replace(valid, "        version: 1.2.3\n", "        version: 2.0.0\n", 1),
		},
		{
			name: "archive-only field on direct executable",
			data: strings.Replace(valid, "            executableName: fixture-cli.exe\n", "            executableName: fixture-cli.exe\n            archivePath: bin/fixture-cli.exe\n", 1),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse([]byte(test.data))
			assertCode(t, err, ErrSemantic)
		})
	}
}
