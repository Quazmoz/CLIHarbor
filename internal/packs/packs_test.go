package packs

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

const minimalPack = `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: demo
  name: Demo
  version: 1.0.0
runtime:
  platforms: [windows]
  tools:
    fixture:
      executableNames: [fixture-cli]
commands:
  status:
    name: Status
    tool: fixture
    risk: read
    argv:
      - literal: status
    output:
      mode: raw
`

const richerPack = `apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: richer
  name: Richer Demo
  version: 1.2.3
runtime:
  platforms: [windows, linux]
  tools:
    fixture:
      executableNames: [fixture-cli, fixture-cli.exe]
commands:
  inspect:
    name: Inspect
    tool: fixture
    risk: read
    inputs:
      - id: limit
        type: integer
        label: Limit
        validation:
          min: 1
          max: 100
      - id: verbose
        type: boolean
        label: Verbose
      - id: mode
        type: enum
        label: Mode
        required: true
        validation:
          enum: [safe, detailed]
          disallowLeadingDash: true
    argv:
      - literal: inspect
      - flag:
          name: --limit
          valueFrom: limit
          omitWhenEmpty: true
      - switch:
          name: --verbose
          enabledFrom: verbose
      - map:
          valueFrom: mode
          values:
            safe: --safe-mode
            detailed: --detailed-mode
    output:
      mode: json
      renderer: table
`

func TestParseKnownGoodPacks(t *testing.T) {
	for _, test := range []struct {
		name string
		data string
		id   string
	}{
		{name: "minimal", data: minimalPack, id: "demo"},
		{name: "richer", data: richerPack, id: "richer"},
	} {
		t.Run(test.name, func(t *testing.T) {
			pack, err := Parse([]byte(test.data))
			if err != nil {
				t.Fatalf("Parse() error = %v", err)
			}
			if pack.Metadata.ID != test.id {
				t.Fatalf("pack id = %q, want %q", pack.Metadata.ID, test.id)
			}
		})
	}
}

func TestParseRejectsInvalidPacks(t *testing.T) {
	tests := []struct {
		name string
		data string
		code ErrorCode
	}{
		{
			name: "unsupported schema version",
			data: strings.Replace(minimalPack, "cliharbor.dev/v1", "cliharbor.dev/v2", 1),
			code: ErrUnsupportedVersion,
		},
		{
			name: "duplicate tool id",
			data: strings.Replace(minimalPack, "      executableNames: [fixture-cli]\n", "      executableNames: [fixture-cli]\n    fixture:\n      executableNames: [other]\n", 1),
			code: ErrDuplicateKey,
		},
		{
			name: "duplicate task id",
			data: minimalPack + "  status:\n    name: Duplicate\n    tool: fixture\n    risk: read\n    argv: [{literal: status}]\n    output: {mode: raw}\n",
			code: ErrDuplicateKey,
		},
		{
			name: "missing tool reference",
			data: strings.Replace(minimalPack, "tool: fixture", "tool: missing", 1),
			code: ErrSemantic,
		},
		{
			name: "invalid input type",
			data: strings.Replace(richerPack, "type: integer", "type: executable", 1),
			code: ErrSchema,
		},
		{
			name: "unknown risk",
			data: strings.Replace(minimalPack, "risk: read", "risk: root", 1),
			code: ErrSchema,
		},
		{
			name: "invalid id",
			data: strings.Replace(minimalPack, "id: demo", "id: Bad_ID", 1),
			code: ErrSchema,
		},
		{
			name: "undeclared input mapping",
			data: strings.Replace(minimalPack, "      - literal: status", "      - flag:\n          name: --limit\n          valueFrom: missing\n          omitWhenEmpty: true", 1),
			code: ErrSemantic,
		},
		{
			name: "browser-selected executable shape",
			data: strings.Replace(minimalPack, "    tool: fixture\n", "    tool: fixture\n    executableFrom: browserValue\n", 1),
			code: ErrSchema,
		},
		{
			name: "arbitrary flag structure",
			data: strings.Replace(richerPack, "name: --limit", "name: '--limit {{value}}'", 1),
			code: ErrSchema,
		},
		{
			name: "string flag injection policy missing",
			data: strings.Replace(richerPack, "type: integer\n        label: Limit\n        validation:\n          min: 1\n          max: 100", "type: string\n        label: Limit\n        validation:\n          minLength: 1\n          maxLength: 100", 1),
			code: ErrSemantic,
		},
		{
			name: "optional flag cannot dangle",
			data: strings.Replace(richerPack, "          omitWhenEmpty: true\n", "", 1),
			code: ErrSemantic,
		},
		{
			name: "optional mapped enum cannot create missing positional",
			data: strings.Replace(richerPack, "        required: true\n        validation:\n          enum: [safe, detailed]", "        required: false\n        validation:\n          enum: [safe, detailed]", 1),
			code: ErrSemantic,
		},
		{
			name: "unknown field",
			data: strings.Replace(minimalPack, "  name: Demo\n", "  name: Demo\n  surprise: true\n", 1),
			code: ErrSchema,
		},
		{
			name: "shell executable",
			data: strings.Replace(minimalPack, "[fixture-cli]", "[powershell.exe]", 1),
			code: ErrUnsafeExecutable,
		},
		{
			name: "launcher executable",
			data: strings.Replace(minimalPack, "[fixture-cli]", "[env]", 1),
			code: ErrUnsafeExecutable,
		},
		{
			name: "script executable",
			data: strings.Replace(minimalPack, "[fixture-cli]", "[operator.cmd]", 1),
			code: ErrUnsafeExecutable,
		},
		{
			name: "executable path",
			data: strings.Replace(minimalPack, "[fixture-cli]", "['C:\\\\tools\\\\fixture.exe']", 1),
			code: ErrSchema,
		},
		{
			name: "yaml alias",
			data: strings.Replace(minimalPack, "name: Demo", "name: &shared Demo", 1) + "# *shared\n",
			code: ErrYAMLFeature,
		},
		{
			name: "custom yaml tag",
			data: strings.Replace(minimalPack, "name: Demo", "name: !cliharbor/unsafe Demo", 1),
			code: ErrYAMLFeature,
		},
		{
			name: "multiple documents",
			data: minimalPack + "---\n{}\n",
			code: ErrYAMLFeature,
		},
		{
			name: "secret output persistence",
			data: strings.Replace(minimalPack, "      mode: raw", "      mode: raw\n      sensitivity:\n        containsSecrets: true\n        persistRawOutput: true", 1),
			code: ErrSemantic,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse([]byte(test.data))
			assertCode(t, err, test.code)
		})
	}
}

func TestParseSchemaErrorNamesDeepestFailure(t *testing.T) {
	// A flag written as a scalar fails every argv oneOf branch; the author
	// needs the branch that got furthest, not just the command name.
	data := strings.Replace(minimalPack, "      - literal: status\n", "      - flag: --status\n", 1)
	_, err := Parse([]byte(data))
	var validation *ValidationError
	if !errors.As(err, &validation) || validation.Code != ErrSchema {
		t.Fatalf("Parse() error = %v, want schema error", err)
	}
	if validation.Path != "commands.status.argv.0.flag" || !strings.Contains(validation.Message, "got string, want object") {
		t.Fatalf("schema error = %q at %q, want flag type detail", validation.Message, validation.Path)
	}
}

func TestParseModelErrorNamesCause(t *testing.T) {
	data := strings.Replace(minimalPack, "executableNames: [fixture-cli]\n", "executableNames: [fixture-cli]\n      versionConstraint: \">=1.0.0\"\n", 1)
	_, err := Parse([]byte(data))
	if err == nil || !strings.Contains(err.Error(), "versionConstraint requires versionProbe") {
		t.Fatalf("Parse() error = %v, want the model invariant named", err)
	}
}

func TestParseStructuredOutputContract(t *testing.T) {
	good := strings.Replace(minimalPack, "      mode: raw", `      mode: json
      renderer: cards
      structured:
        fields:
          - key: name
            label: Name
            type: string
            required: true
          - key: count
            label: Count
            type: integer
`, 1)
	pack, err := Parse([]byte(good))
	if err != nil {
		t.Fatalf("Parse() structured error = %v", err)
	}
	structured := pack.Commands["status"].Output.Structured
	if structured == nil || len(structured.Fields) != 2 || structured.Fields[0].Key != "name" {
		t.Fatalf("structured output = %#v", structured)
	}

	tests := []struct {
		name string
		data string
		code ErrorCode
	}{
		{name: "requires json mode", data: strings.Replace(good, "mode: json", "mode: raw", 1), code: ErrSemantic},
		{name: "cards only", data: strings.Replace(good, "renderer: cards", "renderer: table", 1), code: ErrSemantic},
		{name: "duplicate field key", data: strings.Replace(good, "          - key: count", "          - key: name", 1), code: ErrSemantic},
		{name: "sensitive field refused", data: strings.Replace(good, "            required: true", "            required: true\n            sensitive: true", 1), code: ErrSemantic},
		{name: "secret-bearing structured refused", data: strings.Replace(good, "      structured:", "      sensitivity:\n        containsSecrets: true\n      structured:", 1), code: ErrSemantic},
		{name: "unknown structured property", data: strings.Replace(good, "            type: string", "            type: string\n            transform: template", 1), code: ErrSchema},
		{name: "nested type unsupported", data: strings.Replace(good, "type: string", "type: object", 1), code: ErrSchema},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse([]byte(test.data))
			assertCode(t, err, test.code)
		})
	}
}

func TestTerraformBuiltinPackLoadsWithVersionProbeAndSafeDisplay(t *testing.T) {
	data, err := os.ReadFile("../../packs/terraform/terraform.yaml")
	if err != nil {
		t.Fatal(err)
	}
	pack, err := Parse(data)
	if err != nil {
		t.Fatalf("built-in Terraform pack must pass exact embedded schema: %v", err)
	}
	tool := pack.Runtime.Tools["terraform"]
	if tool.VersionProbe == nil || strings.Join(tool.VersionProbe.Args, " ") != "version -json" {
		t.Fatal("Terraform discovery must continue using vendor version -json")
	}
	version := pack.Commands["version"]
	if version.Output.Mode != OutputRaw || len(version.Argv) != 1 || version.Argv[0].Literal != "version" {
		t.Fatal("Terraform user-facing version task must avoid strict parsing of the vendor JSON extensions")
	}
	if len(pack.Commands) != 5 {
		t.Fatalf("Terraform includes %d commands; only 5 offline commands should be enabled", len(pack.Commands))
	}
}

func TestStructuredOutputKeysAcceptVendorJSONWithoutRelaxingCommandIDs(t *testing.T) {
	good := strings.Replace(minimalPack, "      mode: raw", `      mode: json
      renderer: cards
      structured:
        fields:
          - key: terraform_version
            label: Terraform version
            type: string
            required: true
`, 1)
	pack, err := Parse([]byte(good))
	if err != nil {
		t.Fatalf("valid upstream Terraform JSON field failed schema: %v", err)
	}
	if got := pack.Commands["status"].Output.Structured.Fields[0].Key; got != "terraform_version" {
		t.Fatalf("unexpected version JSON field: %q", got)
	}
	for _, tc := range []struct {
		name string
		key  string
	}{
		{"dot traversal", "terraform.version"},
		{"key with space", "terraform version"},
		{"key with bracket", "terraform[version]"},
		{"key with dash flag", "--terraform_version"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := strings.Replace(good, "terraform_version", tc.key, 1)
			_, err := Parse([]byte(bad))
			assertCode(t, err, ErrSchema)
		})
	}
	badID := strings.Replace(minimalPack, "  status:\n", "  bad_id:\n", 1)
	_, err = Parse([]byte(badID))
	assertCode(t, err, ErrSchema)
}

func TestRegistryDeepCopiesStructuredOutput(t *testing.T) {
	data := strings.Replace(minimalPack, "      mode: raw", `      mode: json
      renderer: cards
      structured:
        fields:
          - key: name
            label: Name
            type: string
`, 1)
	registry, err := NewLoader().LoadBuiltins(map[string][]byte{"demo.yaml": []byte(data)})
	if err != nil {
		t.Fatal(err)
	}
	first, ok := registry.FindCommand("demo", "status")
	if !ok || first.Output.Structured == nil {
		t.Fatal("structured command missing")
	}
	first.Output.Structured.Fields[0].Key = "tampered"
	second, _ := registry.FindCommand("demo", "status")
	if second.Output.Structured.Fields[0].Key != "name" {
		t.Fatal("registry structured output mutated through returned command")
	}
}

func TestParseRejectsInvalidUTF8AndOversize(t *testing.T) {
	_, err := Parse([]byte{0xff, 0xfe})
	assertCode(t, err, ErrInvalidEncoding)

	_, err = Parse([]byte(strings.Repeat("a", MaxPackBytes+1)))
	assertCode(t, err, ErrInputTooLarge)
}

func TestParseRejectsAdversarialYAMLDepth(t *testing.T) {
	var builder strings.Builder
	for depth := 0; depth < maxYAMLDepth+2; depth++ {
		builder.WriteString(strings.Repeat("  ", depth))
		builder.WriteString("nested:\n")
	}
	builder.WriteString(strings.Repeat("  ", maxYAMLDepth+2))
	builder.WriteString("{}\n")
	_, err := Parse([]byte(builder.String()))
	assertCode(t, err, ErrYAMLFeature)
}

func TestParseRejectsLeadingDashEnumFlagValues(t *testing.T) {
	pack := strings.Replace(richerPack, `      - map:
          valueFrom: mode
          values:
            safe: --safe-mode
            detailed: --detailed-mode`, `      - flag:
          name: --mode
          valueFrom: mode`, 1)
	pack = strings.Replace(pack, "enum: [safe, detailed]", "enum: [--unsafe, detailed]", 1)
	_, err := Parse([]byte(pack))
	assertCode(t, err, ErrSemantic)
}

func TestLoadErrorDoesNotExposeExplicitLocalDirectory(t *testing.T) {
	err := (&LoadError{
		Source: Source{Kind: SourceExplicitLocal, Name: filepath.Join("private", "tenant-a", "pack.yaml")},
		Err:    validationError(ErrSchema, "metadata.id", "invalid"),
	}).Error()
	if strings.Contains(err, "tenant-a") || strings.Contains(err, "private") {
		t.Fatalf("LoadError() exposed local directory: %q", err)
	}
	if !strings.Contains(err, "pack.yaml") {
		t.Fatalf("LoadError() = %q, want basename", err)
	}
}

func TestLoadErrorsRedactMissingLocalPaths(t *testing.T) {
	parent := t.TempDir()
	missing := filepath.Join(parent, "tenant-secret", "missing.yaml")
	_, err := NewLoader().LoadFiles([]string{missing})
	if err == nil {
		t.Fatal("LoadFiles() error = nil, want missing-file error")
	}
	if strings.Contains(err.Error(), parent) || strings.Contains(err.Error(), "tenant-secret") {
		t.Fatalf("LoadFiles() exposed directory path: %q", err)
	}
	if !strings.Contains(err.Error(), "missing.yaml") {
		t.Fatalf("LoadFiles() error = %q, want file basename", err)
	}

	missingDirectory := filepath.Join(parent, "tenant-secret")
	_, err = NewLoader().LoadDirectory(missingDirectory)
	if err == nil {
		t.Fatal("LoadDirectory() error = nil, want missing-directory error")
	}
	if strings.Contains(err.Error(), parent) {
		t.Fatalf("LoadDirectory() exposed parent path: %q", err)
	}
	if !strings.Contains(err.Error(), "tenant-secret") {
		t.Fatalf("LoadDirectory() error = %q, want directory basename", err)
	}
}

func TestLoadBuiltinsDeterministicAndFailClosed(t *testing.T) {
	loader := NewLoader()
	registry, err := loader.LoadBuiltins(map[string][]byte{
		"z.yaml": []byte(strings.Replace(minimalPack, "id: demo", "id: zebra", 1)),
		"a.yaml": []byte(strings.Replace(minimalPack, "id: demo", "id: alpha", 1)),
	})
	if err != nil {
		t.Fatalf("LoadBuiltins() error = %v", err)
	}
	packs := registry.Packs()
	got := []string{packs[0].Pack.Metadata.ID, packs[1].Pack.Metadata.ID}
	want := []string{"alpha", "zebra"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pack order = %v, want %v", got, want)
	}

	registry, err = loader.LoadBuiltins(map[string][]byte{
		"good.yaml": []byte(minimalPack),
		"bad.yaml":  []byte("not: a: valid: pack"),
	})
	if err == nil || registry != nil {
		t.Fatalf("mixed validity load = (%v, %v), want nil registry and error", registry, err)
	}
}

func TestLoadBuiltinsRejectsDuplicatePackIDs(t *testing.T) {
	registry, err := NewLoader().LoadBuiltins(map[string][]byte{
		"one.yaml": []byte(minimalPack),
		"two.yaml": []byte(minimalPack),
	})
	if registry != nil {
		t.Fatalf("registry = %#v, want nil", registry)
	}
	assertCode(t, err, ErrDuplicatePack)
}

func TestRegistryReturnsIsolatedCopies(t *testing.T) {
	registry, err := NewLoader().LoadBuiltins(map[string][]byte{"demo.yaml": []byte(richerPack)})
	if err != nil {
		t.Fatalf("LoadBuiltins() error = %v", err)
	}
	first, ok := registry.FindPack("richer")
	if !ok {
		t.Fatal("FindPack() = false")
	}
	first.Pack.Runtime.Platforms[0] = "tampered"
	first.Pack.Runtime.Tools["fixture"] = Tool{ExecutableNames: []string{"tampered"}}
	first.Pack.Commands["inspect"] = Command{Name: "tampered"}

	second, ok := registry.FindPack("richer")
	if !ok {
		t.Fatal("FindPack() after mutation = false")
	}
	if second.Pack.Runtime.Platforms[0] == "tampered" || second.Pack.Runtime.Tools["fixture"].ExecutableNames[0] == "tampered" || second.Pack.Commands["inspect"].Name == "tampered" {
		t.Fatal("registry state changed through returned value")
	}
}

func TestLoadDirectoryIsExplicitNonRecursiveAndDeterministic(t *testing.T) {
	directory := t.TempDir()
	writePack := func(name, id string) {
		t.Helper()
		data := strings.Replace(minimalPack, "id: demo", "id: "+id, 1)
		if err := os.WriteFile(filepath.Join(directory, name), []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writePack("z.yaml", "zebra")
	writePack("a.yml", "alpha")
	if err := os.WriteFile(filepath.Join(directory, "README.txt"), []byte("ignored"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(directory, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}

	registry, err := NewLoader().LoadDirectory(directory)
	if err != nil {
		t.Fatalf("LoadDirectory() error = %v", err)
	}
	packs := registry.Packs()
	got := []string{packs[0].Pack.Metadata.ID, packs[1].Pack.Metadata.ID}
	want := []string{"alpha", "zebra"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pack order = %v, want %v", got, want)
	}

	empty := t.TempDir()
	registry, err = NewLoader().LoadDirectory(empty)
	if err != nil {
		t.Fatalf("empty LoadDirectory() error = %v", err)
	}
	if len(registry.Packs()) != 0 {
		t.Fatalf("empty directory packs = %d, want 0", len(registry.Packs()))
	}
}

func TestLoadDirectoryBoundsPackFanout(t *testing.T) {
	directory := t.TempDir()
	for index := 0; index <= maxLocalPacksPerDirectory; index++ {
		name := filepath.Join(directory, fmt.Sprintf("%03d.yaml", index))
		if err := os.WriteFile(name, []byte("not parsed because directory fan-out fails first\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	registry, err := NewLoader().LoadDirectory(directory)
	if registry != nil {
		t.Fatalf("registry = %#v, want nil", registry)
	}
	assertCode(t, err, ErrInputTooLarge)
}

func TestLoadFilesRejectsSymlink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target.yaml")
	link := filepath.Join(directory, "link.yaml")
	if err := os.WriteFile(target, []byte(minimalPack), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	registry, err := NewLoader().LoadFiles([]string{link})
	if registry != nil {
		t.Fatalf("registry = %#v, want nil", registry)
	}
	assertCode(t, err, ErrUnsupportedLocalEntry)
}

func TestRegistryLookupOrdering(t *testing.T) {
	registry, err := NewLoader().LoadBuiltins(map[string][]byte{"richer.yaml": []byte(richerPack)})
	if err != nil {
		t.Fatal(err)
	}
	tools := registry.Tools("richer")
	if len(tools) != 1 || tools[0].ID != "fixture" {
		t.Fatalf("Tools() = %#v", tools)
	}
	commands := registry.Commands("richer")
	if len(commands) != 1 || commands[0].ID != "inspect" {
		t.Fatalf("Commands() = %#v", commands)
	}
	if _, ok := registry.FindCommand("richer", "missing"); ok {
		t.Fatal("FindCommand(missing) = true")
	}
}

func assertCode(t *testing.T, err error, want ErrorCode) {
	t.Helper()
	if err == nil {
		t.Fatalf("error = nil, want code %q", want)
	}
	var validation *ValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("error type = %T (%v), want ValidationError", err, err)
	}
	if validation.Code != want {
		t.Fatalf("error code = %q (%v), want %q", validation.Code, err, want)
	}
}

// executablePolicy is the browser/backend contract in testdata; web/src/packDraft.test.ts reads the same file.
type executablePolicy struct {
	Accept []string `json:"accept"`
	Reject []string `json:"reject"`
	Draft  struct {
		Fields struct {
			PackID, Name, ToolID, Executable string
		} `json:"fields"`
		YAML string `json:"yaml"`
	} `json:"draft"`
}

func TestExecutablePolicyContract(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "executable-policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	var policy executablePolicy
	if err := json.Unmarshal(data, &policy); err != nil {
		t.Fatal(err)
	}
	withExecutable := func(name string) []byte {
		return []byte(strings.Replace(minimalPack, "[fixture-cli]", "["+strconv.Quote(name)+"]", 1))
	}
	for _, name := range policy.Accept {
		if _, err := Parse(withExecutable(name)); err != nil {
			t.Errorf("accept %q: Parse() error = %v", name, err)
		}
	}
	for _, name := range policy.Reject {
		_, err := Parse(withExecutable(name))
		var validation *ValidationError
		if !errors.As(err, &validation) || (validation.Code != ErrUnsafeExecutable && validation.Code != ErrSchema) {
			t.Errorf("reject %q: Parse() error = %v, want unsafe executable or schema rejection", name, err)
		}
	}

	// The browser's exact output must pass the authoritative parser unchanged.
	pack, err := Parse([]byte(policy.Draft.YAML))
	if err != nil {
		t.Fatalf("browser draft rejected: %v", err)
	}
	fields := policy.Draft.Fields
	tool, ok := pack.Runtime.Tools[fields.ToolID]
	if pack.Metadata.ID != fields.PackID || pack.Metadata.Name != fields.Name || !ok ||
		len(tool.ExecutableNames) != 1 || tool.ExecutableNames[0] != fields.Executable || len(pack.Commands) != 0 {
		t.Fatalf("browser draft decoded as %+v", pack)
	}
}
