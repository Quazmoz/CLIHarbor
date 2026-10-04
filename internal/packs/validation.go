package packs

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	semver "github.com/Masterminds/semver/v3"
	"github.com/Quazmoz/CLIHarbor/schemas"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"gopkg.in/yaml.v3"
)

const (
	MaxPackBytes            = 256 << 10
	maxYAMLDepth            = 64
	maxYAMLNodes            = 10000
	maxInstallArtifactBytes = 512 << 20
)

type ErrorCode string

const (
	ErrInvalidEncoding       ErrorCode = "invalid_encoding"
	ErrInputTooLarge         ErrorCode = "input_too_large"
	ErrYAML                  ErrorCode = "yaml_invalid"
	ErrYAMLFeature           ErrorCode = "yaml_feature_forbidden"
	ErrDuplicateKey          ErrorCode = "duplicate_key"
	ErrUnsupportedVersion    ErrorCode = "unsupported_schema_version"
	ErrSchema                ErrorCode = "schema_invalid"
	ErrSemantic              ErrorCode = "semantic_invalid"
	ErrDuplicatePack         ErrorCode = "duplicate_pack_id"
	ErrUnsafeExecutable      ErrorCode = "unsafe_executable"
	ErrUnsupportedLocalEntry ErrorCode = "unsupported_local_entry"
)

type ValidationError struct {
	Code    ErrorCode
	Path    string
	Message string
}

func (e *ValidationError) Error() string {
	if e.Path == "" {
		return fmt.Sprintf("%s: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("%s at %s: %s", e.Code, e.Path, e.Message)
}

func validationError(code ErrorCode, path, message string) error {
	return &ValidationError{Code: code, Path: path, Message: message}
}

var (
	packSchemaOnce sync.Once
	packSchema     *jsonschema.Schema
	packSchemaErr  error
)

func compiledPackSchema() (*jsonschema.Schema, error) {
	packSchemaOnce.Do(func() {
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemas.PackV1()))
		if err != nil {
			packSchemaErr = fmt.Errorf("decode embedded pack schema: %w", err)
			return
		}
		compiler := jsonschema.NewCompiler()
		const schemaURL = "https://cliharbor.dev/schemas/pack.v1.schema.json"
		if err := compiler.AddResource(schemaURL, doc); err != nil {
			packSchemaErr = fmt.Errorf("register embedded pack schema: %w", err)
			return
		}
		packSchema, packSchemaErr = compiler.Compile(schemaURL)
		if packSchemaErr != nil {
			packSchemaErr = fmt.Errorf("compile embedded pack schema: %w", packSchemaErr)
		}
	})
	return packSchema, packSchemaErr
}

func Parse(data []byte) (Pack, error) {
	var zero Pack
	if len(data) == 0 {
		return zero, validationError(ErrYAML, "", "pack is empty")
	}
	if len(data) > MaxPackBytes {
		return zero, validationError(ErrInputTooLarge, "", fmt.Sprintf("pack exceeds %d-byte limit", MaxPackBytes))
	}
	if !utf8.Valid(data) {
		return zero, validationError(ErrInvalidEncoding, "", "pack must be valid UTF-8")
	}

	root, err := decodeSingleYAMLDocument(data)
	if err != nil {
		return zero, err
	}
	if err := validateYAMLTree(root); err != nil {
		return zero, err
	}

	var decoded any
	if err := root.Decode(&decoded); err != nil {
		return zero, validationError(ErrYAML, "", "pack could not be decoded")
	}
	normalized, err := normalizeYAML(decoded)
	if err != nil {
		return zero, err
	}
	jsonBytes, err := json.Marshal(normalized)
	if err != nil {
		return zero, validationError(ErrYAML, "", "pack could not be normalized")
	}

	var header struct {
		APIVersion string `json:"apiVersion"`
	}
	if err := json.Unmarshal(jsonBytes, &header); err != nil {
		return zero, validationError(ErrSchema, "", "pack root must be an object")
	}
	if header.APIVersion != SupportedAPIVersion {
		return zero, validationError(ErrUnsupportedVersion, "apiVersion", "unsupported pack schema version")
	}

	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(jsonBytes))
	if err != nil {
		return zero, validationError(ErrSchema, "", "pack is not valid JSON-compatible data")
	}
	schema, err := compiledPackSchema()
	if err != nil {
		return zero, fmt.Errorf("initialize pack schema: %w", err)
	}
	if err := schema.Validate(instance); err != nil {
		path := schemaErrorPath(err)
		return zero, validationError(ErrSchema, path, "pack does not match the v1 schema")
	}

	decoder := json.NewDecoder(bytes.NewReader(jsonBytes))
	decoder.DisallowUnknownFields()
	var pack Pack
	if err := decoder.Decode(&pack); err != nil {
		return zero, validationError(ErrSchema, "", "pack could not be decoded into the v1 model")
	}
	if err := validateSemantics(pack); err != nil {
		return zero, err
	}
	return pack, nil
}

func decodeSingleYAMLDocument(data []byte) (*yaml.Node, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	var root yaml.Node
	if err := decoder.Decode(&root); err != nil {
		return nil, validationError(ErrYAML, "", "pack is not valid YAML")
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err == nil {
		return nil, validationError(ErrYAMLFeature, "", "multiple YAML documents are not allowed")
	} else if !errors.Is(err, io.EOF) {
		return nil, validationError(ErrYAML, "", "pack contains invalid trailing YAML")
	}
	return &root, nil
}

func validateYAMLTree(root *yaml.Node) error {
	count := 0
	var walk func(*yaml.Node, int, string) error
	walk = func(node *yaml.Node, depth int, path string) error {
		count++
		if count > maxYAMLNodes {
			return validationError(ErrYAMLFeature, path, "YAML node limit exceeded")
		}
		if depth > maxYAMLDepth {
			return validationError(ErrYAMLFeature, path, "YAML nesting limit exceeded")
		}
		if node.Kind == yaml.AliasNode {
			return validationError(ErrYAMLFeature, path, "YAML aliases are not allowed")
		}
		if node.Anchor != "" {
			return validationError(ErrYAMLFeature, path, "YAML anchors are not allowed")
		}
		if !allowedYAMLTag(node.ShortTag()) {
			return validationError(ErrYAMLFeature, path, "custom or unsupported YAML tags are not allowed")
		}
		if node.Kind == yaml.MappingNode {
			seen := make(map[string]struct{}, len(node.Content)/2)
			for i := 0; i < len(node.Content); i += 2 {
				key := node.Content[i]
				if key.Kind != yaml.ScalarNode || key.ShortTag() != "!!str" {
					return validationError(ErrYAMLFeature, path, "mapping keys must be strings")
				}
				if key.Value == "<<" {
					return validationError(ErrYAMLFeature, path, "YAML merge keys are not allowed")
				}
				if _, exists := seen[key.Value]; exists {
					return validationError(ErrDuplicateKey, childPath(path, key.Value), "duplicate mapping key")
				}
				seen[key.Value] = struct{}{}
				if err := walk(node.Content[i+1], depth+1, childPath(path, key.Value)); err != nil {
					return err
				}
			}
			return nil
		}
		for i, child := range node.Content {
			childName := path
			if node.Kind == yaml.SequenceNode {
				childName = fmt.Sprintf("%s[%d]", path, i)
			}
			if err := walk(child, depth+1, childName); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(root, 0, "")
}

func allowedYAMLTag(tag string) bool {
	switch tag {
	case "", "!!map", "!!seq", "!!str", "!!int", "!!float", "!!bool", "!!null":
		return true
	default:
		return false
	}
}

func normalizeYAML(value any) (any, error) {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			normalized, err := normalizeYAML(item)
			if err != nil {
				return nil, err
			}
			out[key] = normalized
		}
		return out, nil
	case map[any]any:
		out := make(map[string]any, len(typed))
		for rawKey, item := range typed {
			key, ok := rawKey.(string)
			if !ok {
				return nil, validationError(ErrYAMLFeature, "", "mapping keys must be strings")
			}
			normalized, err := normalizeYAML(item)
			if err != nil {
				return nil, err
			}
			out[key] = normalized
		}
		return out, nil
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			normalized, err := normalizeYAML(item)
			if err != nil {
				return nil, err
			}
			out[i] = normalized
		}
		return out, nil
	case string, bool, nil:
		return typed, nil
	case int:
		return int64(typed), nil
	case int8:
		return int64(typed), nil
	case int16:
		return int64(typed), nil
	case int32:
		return int64(typed), nil
	case int64:
		return typed, nil
	case uint:
		return uint64(typed), nil
	case uint8:
		return uint64(typed), nil
	case uint16:
		return uint64(typed), nil
	case uint32:
		return uint64(typed), nil
	case uint64:
		return typed, nil
	case float32:
		return float64(typed), nil
	case float64:
		return typed, nil
	default:
		return nil, validationError(ErrYAMLFeature, "", "unsupported YAML scalar type")
	}
}

func schemaErrorPath(err error) string {
	var validation *jsonschema.ValidationError
	if !errors.As(err, &validation) {
		return ""
	}
	return validationErrorPath(validation)
}

func validationErrorPath(validation *jsonschema.ValidationError) string {
	if validation == nil {
		return ""
	}
	if len(validation.InstanceLocation) > 0 {
		return strings.Join(validation.InstanceLocation, ".")
	}
	for _, cause := range validation.Causes {
		if path := validationErrorPath(cause); path != "" {
			return path
		}
	}
	return ""
}

func validateSemantics(pack Pack) error {
	for _, toolID := range sortedKeys(pack.Runtime.Tools) {
		tool := pack.Runtime.Tools[toolID]
		for i, executable := range tool.ExecutableNames {
			if isForbiddenExecutable(executable) {
				return validationError(ErrUnsafeExecutable, fmt.Sprintf("runtime.tools.%s.executableNames[%d]", toolID, i), "shells and general-purpose interpreters are not allowed as v1 tools")
			}
			if filepath.Base(executable) != executable || strings.ContainsAny(executable, `/\\`) {
				return validationError(ErrUnsafeExecutable, fmt.Sprintf("runtime.tools.%s.executableNames[%d]", toolID, i), "tool executable names must be basenames, not paths")
			}
		}
		if err := validateToolInstall(pack, toolID, tool); err != nil {
			return err
		}
	}

	commandIDs := sortedKeys(pack.Commands)
	for _, commandID := range commandIDs {
		command := pack.Commands[commandID]
		path := "commands." + commandID
		if _, ok := pack.Runtime.Tools[command.Tool]; !ok {
			return validationError(ErrSemantic, path+".tool", "command references an undeclared tool")
		}
		inputs := make(map[string]Input, len(command.Inputs))
		for index, input := range command.Inputs {
			inputPath := fmt.Sprintf("%s.inputs[%d]", path, index)
			if _, exists := inputs[input.ID]; exists {
				return validationError(ErrSemantic, inputPath+".id", "duplicate input id")
			}
			if err := validateInput(input, inputPath); err != nil {
				return err
			}
			inputs[input.ID] = input
		}
		for index, arg := range command.Argv {
			if err := validateArgument(arg, inputs, fmt.Sprintf("%s.argv[%d]", path, index)); err != nil {
				return err
			}
		}
		if command.Output.Sensitivity.ContainsSecrets {
			if command.Output.Sensitivity.PersistRawOutput {
				return validationError(ErrSemantic, path+".output.sensitivity.persistRawOutput", "secret-bearing output cannot be persisted")
			}
			if command.Output.Sensitivity.RevealByDefault {
				return validationError(ErrSemantic, path+".output.sensitivity.revealByDefault", "secret-bearing output cannot be revealed by default")
			}
			if command.Output.Structured != nil {
				return validationError(ErrSemantic, path+".output.structured", "secret-bearing output cannot enable structured rendering")
			}
		}
		if command.Output.Structured != nil {
			if command.Output.Mode != OutputJSON {
				return validationError(ErrSemantic, path+".output.structured", "structured rendering currently requires JSON output mode")
			}
			if command.Output.Renderer != "" && command.Output.Renderer != "cards" {
				return validationError(ErrSemantic, path+".output.renderer", "structured scalar output currently supports only the cards renderer")
			}
			seenFields := make(map[string]struct{}, len(command.Output.Structured.Fields))
			for index, field := range command.Output.Structured.Fields {
				fieldPath := fmt.Sprintf("%s.output.structured.fields[%d]", path, index)
				if _, exists := seenFields[field.Key]; exists {
					return validationError(ErrSemantic, fieldPath+".key", "duplicate structured field key")
				}
				seenFields[field.Key] = struct{}{}
				if field.Sensitive {
					return validationError(ErrSemantic, fieldPath+".sensitive", "sensitive structured fields are not supported in this phase")
				}
			}
		}
	}

	for _, toolID := range sortedKeys(pack.Runtime.Tools) {
		tool := pack.Runtime.Tools[toolID]
		if tool.SessionCheck == nil {
			continue
		}
		if err := validateSessionCheck(pack, toolID, *tool.SessionCheck); err != nil {
			return err
		}
	}
	return nil
}

func validateToolInstall(pack Pack, toolID string, tool Tool) error {
	if tool.Install == nil {
		return nil
	}

	path := "runtime.tools." + toolID + ".install"
	if tool.VersionConstraint != "" {
		constraint, err := semver.NewConstraint(tool.VersionConstraint)
		if err != nil {
			return validationError(ErrSemantic, "runtime.tools."+toolID+".versionConstraint", "tool version constraint is invalid")
		}
		version, err := semver.NewVersion(tool.Install.Version)
		if err != nil {
			return validationError(ErrSemantic, path+".version", "managed install version is not valid semantic version data")
		}
		if !constraint.Check(version) {
			return validationError(ErrSemantic, path+".version", "managed install version does not satisfy the tool versionConstraint")
		}
	}
	platforms := make(map[string]struct{}, len(pack.Runtime.Platforms))
	for _, platform := range pack.Runtime.Platforms {
		platforms[platform] = struct{}{}
	}

	for _, platformArch := range sortedKeys(tool.Install.Artifacts) {
		artifact := tool.Install.Artifacts[platformArch]
		artifactPath := path + ".artifacts." + platformArch
		parts := strings.Split(platformArch, "-")
		if len(parts) != 2 {
			return validationError(ErrSemantic, artifactPath, "install artifact key must be platform-architecture")
		}
		platform := parts[0]
		if _, ok := platforms[platform]; !ok {
			return validationError(ErrSemantic, artifactPath, "install artifact platform is not declared by runtime.platforms")
		}
		if artifact.SizeBytes <= 0 || artifact.SizeBytes > maxInstallArtifactBytes {
			return validationError(ErrSemantic, artifactPath+".sizeBytes", "install artifact size is outside the portable-install limit")
		}
		if !validInstallDigest(artifact.SHA256) {
			return validationError(ErrSemantic, artifactPath+".sha256", "install artifact SHA-256 must be exactly 64 hexadecimal characters")
		}

		source, err := url.Parse(artifact.URL)
		if err != nil || !strings.EqualFold(source.Scheme, "https") || source.Host == "" || source.User != nil || source.Fragment != "" || source.Port() != "" || !validInstallHost(source.Hostname()) {
			return validationError(ErrSemantic, artifactPath+".url", "install artifact URL must be an HTTPS public-host URL without credentials, fragments, or a custom port")
		}
		if !matchesInstallExecutable(artifact.ExecutableName, tool.ExecutableNames, platform) {
			return validationError(ErrSemantic, artifactPath+".executableName", "install artifact executable does not match a declared tool executable")
		}

		seenHosts := make(map[string]struct{}, len(artifact.RedirectHosts))
		for index, host := range artifact.RedirectHosts {
			hostPath := fmt.Sprintf("%s.redirectHosts[%d]", artifactPath, index)
			normalized := strings.ToLower(host)
			if host != normalized || !validInstallHost(host) {
				return validationError(ErrSemantic, hostPath, "redirect hosts must be lowercase public hostnames")
			}
			if _, exists := seenHosts[normalized]; exists {
				return validationError(ErrSemantic, hostPath, "duplicate redirect host")
			}
			seenHosts[normalized] = struct{}{}
		}

		switch artifact.Format {
		case InstallFormatExecutable:
			if artifact.ArchivePath != "" || artifact.ExecutableSHA256 != "" || artifact.ExecutableSizeBytes != 0 {
				return validationError(ErrSemantic, artifactPath, "direct executable installs cannot declare archive-only fields")
			}
		case InstallFormatZIP:
			if !validArchiveExecutablePath(artifact.ArchivePath) {
				return validationError(ErrSemantic, artifactPath+".archivePath", "ZIP executable path must be a clean relative slash-separated path")
			}
			if pathpkg.Base(artifact.ArchivePath) != artifact.ExecutableName {
				return validationError(ErrSemantic, artifactPath+".archivePath", "ZIP executable path basename must match executableName")
			}
			if !validInstallDigest(artifact.ExecutableSHA256) {
				return validationError(ErrSemantic, artifactPath+".executableSha256", "ZIP executable SHA-256 must be exactly 64 hexadecimal characters")
			}
			if artifact.ExecutableSizeBytes <= 0 || artifact.ExecutableSizeBytes > maxInstallArtifactBytes {
				return validationError(ErrSemantic, artifactPath+".executableSizeBytes", "ZIP executable size is outside the portable-install limit")
			}
		default:
			return validationError(ErrSemantic, artifactPath+".format", "unsupported portable install format")
		}
	}
	return nil
}

func validInstallDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') &&
			(character < 'A' || character > 'F') {
			return false
		}
	}
	return true
}

func validInstallHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".local") || net.ParseIP(host) != nil {
		return false
	}
	if strings.ContainsAny(host, "/\\:@") {
		return false
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return false
	}
	for _, label := range labels {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return false
			}
		}
	}
	return true
}

func matchesInstallExecutable(actual string, declared []string, platform string) bool {
	if filepath.Base(actual) != actual || strings.ContainsAny(actual, `/\`) {
		return false
	}
	for _, name := range declared {
		if strings.EqualFold(actual, name) {
			return true
		}
		if platform == "windows" && filepath.Ext(name) == "" && strings.EqualFold(actual, name+".exe") {
			return true
		}
	}
	return false
}

func validArchiveExecutablePath(value string) bool {
	if value == "" || strings.Contains(value, "\\") || strings.HasPrefix(value, "/") {
		return false
	}
	cleaned := pathpkg.Clean(value)
	return cleaned == value && cleaned != "." && cleaned != ".." && !strings.HasPrefix(cleaned, "../")
}

func validateSessionCheck(pack Pack, toolID string, check SessionCheck) error {
	path := "runtime.tools." + toolID + ".sessionCheck"
	command, ok := pack.Commands[check.CommandID]
	if !ok {
		return validationError(ErrSemantic, path+".commandId", "session check references an undeclared command")
	}
	if command.Tool != toolID {
		return validationError(ErrSemantic, path+".commandId", "session check command must use the declaring tool")
	}
	if command.Risk != RiskRead {
		return validationError(ErrSemantic, path+".commandId", "session check command must be read-only")
	}
	if len(command.Inputs) != 0 {
		return validationError(ErrSemantic, path+".commandId", "session check command must not require browser inputs")
	}
	if command.Output.Sensitivity.ContainsSecrets {
		return validationError(ErrSemantic, path+".commandId", "session check command must not return secret-bearing output")
	}
	if !command.Requirements.RequiresAuth || command.Requirements.AuthMode != AuthModeVendorSession {
		return validationError(ErrSemantic, path+".commandId", "session check command must require vendor-session authentication")
	}
	if marker := check.UnauthenticatedStderrContains; marker != "" {
		if strings.TrimSpace(marker) != marker {
			return validationError(ErrSemantic, path+".unauthenticatedStderrContains", "session check evidence must not have leading or trailing whitespace")
		}
		for _, character := range marker {
			if character <= 0x1f || character == 0x7f {
				return validationError(ErrSemantic, path+".unauthenticatedStderrContains", "session check evidence must not contain control characters")
			}
		}
	}
	return nil
}

func validateInput(input Input, path string) error {
	validation := input.Validation
	if validation.Min != nil && validation.Max != nil && *validation.Min > *validation.Max {
		return validationError(ErrSemantic, path+".validation", "min cannot exceed max")
	}
	if validation.MinLength != nil && validation.MaxLength != nil && *validation.MinLength > *validation.MaxLength {
		return validationError(ErrSemantic, path+".validation", "minLength cannot exceed maxLength")
	}
	if validation.Pattern != "" {
		if _, err := regexp.Compile(validation.Pattern); err != nil {
			return validationError(ErrSemantic, path+".validation.pattern", "pattern is not a valid RE2 expression")
		}
	}

	switch input.Type {
	case InputEnum, InputMultiselect:
		if len(validation.Enum) == 0 {
			return validationError(ErrSemantic, path+".validation.enum", "enum and multiselect inputs require predefined values")
		}
	case InputString:
		if len(validation.Enum) != 0 {
			return validationError(ErrSemantic, path+".validation.enum", "string inputs cannot define enum values")
		}
		if validation.Min != nil || validation.Max != nil {
			return validationError(ErrSemantic, path+".validation", "string inputs cannot define numeric bounds")
		}
	case InputInteger:
		if len(validation.Enum) != 0 || validation.MinLength != nil || validation.MaxLength != nil || validation.Pattern != "" {
			return validationError(ErrSemantic, path+".validation", "integer inputs cannot define string or enum validation")
		}
	case InputBoolean:
		if validation.Min != nil || validation.Max != nil || validation.MinLength != nil || validation.MaxLength != nil || validation.Pattern != "" || len(validation.Enum) != 0 || validation.DisallowLeadingDash {
			return validationError(ErrSemantic, path+".validation", "boolean inputs cannot define value constraints")
		}
	default:
		return validationError(ErrSemantic, path+".type", "unsupported input type")
	}
	return nil
}

func validateArgument(arg Argument, inputs map[string]Input, path string) error {
	if arg.Literal != "" {
		if strings.ContainsRune(arg.Literal, '\x00') {
			return validationError(ErrSemantic, path+".literal", "argument literals cannot contain NUL")
		}
		return nil
	}
	if arg.Flag != nil {
		input, ok := inputs[arg.Flag.ValueFrom]
		if !ok {
			return validationError(ErrSemantic, path+".flag.valueFrom", "flag references an undeclared input")
		}
		if input.Type == InputBoolean || input.Type == InputMultiselect {
			return validationError(ErrSemantic, path+".flag.valueFrom", "flag values must come from string, integer, or enum inputs")
		}
		if !input.Required && !arg.Flag.OmitWhenEmpty {
			return validationError(ErrSemantic, path+".flag.omitWhenEmpty", "optional flag values must be omitted when empty")
		}
		if (input.Type == InputString || input.Type == InputEnum) && !input.Validation.DisallowLeadingDash {
			return validationError(ErrSemantic, path+".flag.valueFrom", "string and enum flag values must reject leading dashes to prevent undeclared flag injection")
		}
		if input.Type == InputEnum {
			for _, value := range input.Validation.Enum {
				if strings.HasPrefix(value, "-") {
					return validationError(ErrSemantic, path+".flag.valueFrom", "enum values used as flag arguments cannot begin with a dash")
				}
			}
		}
		return nil
	}
	if arg.Positional != nil {
		input, ok := inputs[arg.Positional.ValueFrom]
		if !ok {
			return validationError(ErrSemantic, path+".positional.valueFrom", "positional argument references an undeclared input")
		}
		if input.Type == InputBoolean || input.Type == InputMultiselect {
			return validationError(ErrSemantic, path+".positional.valueFrom", "positional arguments must come from string, integer, or enum inputs")
		}
		if !input.Required && !arg.Positional.OmitWhenEmpty {
			return validationError(ErrSemantic, path+".positional.omitWhenEmpty", "optional positional arguments must be omitted when empty")
		}
		if (input.Type == InputString || input.Type == InputEnum) && !input.Validation.DisallowLeadingDash {
			return validationError(ErrSemantic, path+".positional.valueFrom", "string and enum positional values must reject leading dashes to prevent undeclared flag injection")
		}
		if input.Type == InputEnum {
			for _, value := range input.Validation.Enum {
				if strings.HasPrefix(value, "-") {
					return validationError(ErrSemantic, path+".positional.valueFrom", "enum values used as positional arguments cannot begin with a dash")
				}
			}
		}
		return nil
	}
	if arg.Switch != nil {
		input, ok := inputs[arg.Switch.EnabledFrom]
		if !ok {
			return validationError(ErrSemantic, path+".switch.enabledFrom", "switch references an undeclared input")
		}
		if input.Type != InputBoolean {
			return validationError(ErrSemantic, path+".switch.enabledFrom", "switches must reference boolean inputs")
		}
		return nil
	}
	if arg.Map != nil {
		input, ok := inputs[arg.Map.ValueFrom]
		if !ok {
			return validationError(ErrSemantic, path+".map.valueFrom", "map references an undeclared input")
		}
		if input.Type != InputEnum {
			return validationError(ErrSemantic, path+".map.valueFrom", "mapped literals must reference enum inputs")
		}
		if !input.Required {
			return validationError(ErrSemantic, path+".map.valueFrom", "mapped enum inputs must be required so argument layout remains deterministic")
		}
		allowed := make(map[string]struct{}, len(input.Validation.Enum))
		for _, value := range input.Validation.Enum {
			allowed[value] = struct{}{}
		}
		if len(arg.Map.Values) != len(allowed) {
			return validationError(ErrSemantic, path+".map.values", "enum mapping must define exactly one literal for every enum value")
		}
		for key, literal := range arg.Map.Values {
			if _, ok := allowed[key]; !ok {
				return validationError(ErrSemantic, path+".map.values", "enum mapping contains an undeclared value")
			}
			if literal == "" || strings.ContainsRune(literal, '\x00') {
				return validationError(ErrSemantic, path+".map.values", "mapped literals must be non-empty and cannot contain NUL")
			}
		}
		return nil
	}
	return validationError(ErrSemantic, path, "argument has no recognized execution mapping")
}

func isForbiddenExecutable(name string) bool {
	lower := strings.ToLower(name)
	switch filepath.Ext(lower) {
	case ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta":
		return true
	}
	base := strings.TrimSuffix(lower, ".exe")
	switch base {
	case "cmd", "powershell", "pwsh", "sh", "bash", "zsh", "fish", "wscript", "cscript", "python", "python3", "node", "ruby", "perl", "mshta", "rundll32", "regsvr32", "wsl":
		return true
	default:
		return false
	}
}

func sortedKeys[V any](items map[string]V) []string {
	keys := make([]string, 0, len(items))
	for key := range items {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func childPath(parent, child string) string {
	if parent == "" {
		return child
	}
	return parent + "." + child
}
