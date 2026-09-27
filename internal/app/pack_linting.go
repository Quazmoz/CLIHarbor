package app

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

const maxPackLintDiagnostics = 2048

type PackLintSeverity string

const (
	PackLintError   PackLintSeverity = "error"
	PackLintWarning PackLintSeverity = "warning"
)

type PackLintDiagnostic struct {
	Severity PackLintSeverity
	Code     string
	Source   string
	Path     string
	Message  string
}

type packLintCollector struct {
	diagnostics []PackLintDiagnostic
	overflow    bool
}

func (c *packLintCollector) add(severity PackLintSeverity, code, source, path, message string) {
	if c.overflow {
		return
	}
	if len(c.diagnostics) >= maxPackLintDiagnostics {
		c.overflow = true
		return
	}
	c.diagnostics = append(c.diagnostics, PackLintDiagnostic{
		Severity: severity,
		Code:     code,
		Source:   source,
		Path:     path,
		Message:  message,
	})
}

func LintPackPaths(options Options, paths []string, casesPath string) error {
	if options.Out == nil {
		return fmt.Errorf("pack lint output writer is required")
	}

	registry, err := loadPackAuthoringRegistry(paths)
	if err != nil {
		source := "-"
		if len(paths) == 1 && paths[0] != "" {
			source = diagnosticDisplaySource(paths[0])
		}
		if _, writeErr := fmt.Fprintf(
			options.Out,
			"error PACK_SOURCE_INVALID %s -: pack source is malformed, unsafe, or unreadable; run pack validate for structural details\n",
			source,
		); writeErr != nil {
			return writeErr
		}
		return fmt.Errorf("pack lint source validation failed")
	}

	var cases *packTestDocument
	if casesPath != "" {
		document, readErr := readPackTestDocument(casesPath)
		if readErr == nil {
			readErr = validatePackTestDocument(document)
		}
		if readErr != nil {
			if _, writeErr := fmt.Fprintf(
				options.Out,
				"error PACK_TEST_SOURCE_INVALID %s -: contract fixture is malformed, unsafe, or unreadable; run pack test for structural details\n",
				diagnosticDisplaySource(casesPath),
			); writeErr != nil {
				return writeErr
			}
			return fmt.Errorf("pack lint contract fixture validation failed")
		}
		cases = &document
	}

	diagnostics, err := lintPackRegistry(registry, cases, casesPath)
	if err != nil {
		return err
	}
	for _, diagnostic := range diagnostics {
		if _, err := fmt.Fprintf(
			options.Out,
			"%s %s %s %s: %s\n",
			diagnostic.Severity,
			diagnostic.Code,
			diagnosticDisplaySource(diagnostic.Source),
			diagnostic.Path,
			diagnostic.Message,
		); err != nil {
			return err
		}
	}

	errorsCount := 0
	warningsCount := 0
	for _, diagnostic := range diagnostics {
		switch diagnostic.Severity {
		case PackLintError:
			errorsCount++
		case PackLintWarning:
			warningsCount++
		}
	}
	if _, err := fmt.Fprintf(
		options.Out,
		"Linted %d pack(s): %d error(s), %d warning(s); no executable, discovery probe, version probe, help probe, task, or authentication/session state was accessed.\n",
		len(registry.Packs()),
		errorsCount,
		warningsCount,
	); err != nil {
		return err
	}
	if errorsCount != 0 {
		return fmt.Errorf("pack lint failed with %d error(s)", errorsCount)
	}
	return nil
}

func lintPackRegistry(registry *packs.Registry, cases *packTestDocument, casesSource string) ([]PackLintDiagnostic, error) {
	if registry == nil {
		return nil, fmt.Errorf("pack lint registry is required")
	}
	collector := &packLintCollector{}
	for _, loaded := range registry.Packs() {
		lintLoadedPack(registry, loaded, collector)
	}
	if cases != nil {
		lintPackTestCoverage(registry, *cases, casesSource, collector)
	}
	if collector.overflow {
		return nil, fmt.Errorf("pack lint diagnostics exceed %d-entry limit", maxPackLintDiagnostics)
	}

	diagnostics := append([]PackLintDiagnostic(nil), collector.diagnostics...)
	sort.Slice(diagnostics, func(i, j int) bool {
		left, right := diagnostics[i], diagnostics[j]
		leftSource := diagnosticDisplaySource(left.Source)
		rightSource := diagnosticDisplaySource(right.Source)
		if leftSource != rightSource {
			return leftSource < rightSource
		}
		if left.Path != right.Path {
			return left.Path < right.Path
		}
		if left.Code != right.Code {
			return left.Code < right.Code
		}
		if left.Severity != right.Severity {
			return left.Severity < right.Severity
		}
		return left.Message < right.Message
	})
	return diagnostics, nil
}

func lintLoadedPack(registry *packs.Registry, loaded packs.LoadedPack, collector *packLintCollector) {
	pack := loaded.Pack
	source := loaded.Source.Name
	lintTrustedText(collector, source, "metadata.name", pack.Metadata.Name)
	lintDescriptionText(collector, source, "metadata.description", pack.Metadata.Description)

	for _, namedTool := range registry.Tools(pack.Metadata.ID) {
		toolPath := "runtime.tools." + namedTool.ID
		tool := namedTool.Tool
		if tool.VersionProbe != nil {
			for index, arg := range tool.VersionProbe.Args {
				lintTrustedText(collector, source, fmt.Sprintf("%s.versionProbe.args[%d]", toolPath, index), arg)
			}
		}
		for _, probeID := range sortedMapKeys(tool.HelpProbes) {
			probe := tool.HelpProbes[probeID]
			for index, arg := range probe.Args {
				lintTrustedText(collector, source, fmt.Sprintf("%s.helpProbes.%s.args[%d]", toolPath, probeID, index), arg)
			}
		}
	}

	commands := registry.Commands(pack.Metadata.ID)
	nameCounts := make(map[string]int, len(commands))
	for _, named := range commands {
		nameCounts[named.Command.Name]++
	}
	for _, named := range commands {
		commandID := named.ID
		command := named.Command
		commandPath := "commands." + commandID

		lintTrustedText(collector, source, commandPath+".name", command.Name)
		lintDescriptionText(collector, source, commandPath+".description", command.Description)
		if strings.TrimSpace(command.Description) == "" {
			collector.add(PackLintWarning, "PACK_COMMAND_DESCRIPTION_MISSING", source, commandPath+".description", "browser-visible command has no author description")
		}
		if nameCounts[command.Name] > 1 {
			collector.add(PackLintWarning, "PACK_COMMAND_NAME_DUPLICATE", source, commandPath+".name", "browser-visible command name is shared by another command in this pack")
		}
		if command.Risk != packs.RiskRead {
			collector.add(PackLintWarning, "PACK_COMMAND_RISK_BLOCKED", source, commandPath+".risk", "current planner will reject this command risk class")
		}
		if command.Requirements.RequiresAuth && command.Requirements.AuthMode != packs.AuthModeVendorSession {
			collector.add(PackLintWarning, "PACK_COMMAND_AUTH_BLOCKED", source, commandPath+".requirements", "current planner will reject this authenticated command without vendor-session auth mode")
		}
		if command.Output.Sensitivity.ContainsSecrets {
			collector.add(PackLintWarning, "PACK_COMMAND_SECRET_OUTPUT_BLOCKED", source, commandPath+".output.sensitivity", "current planner will reject secret-bearing browser output")
		}

		usage := commandInputUsage(command)
		for index, input := range command.Inputs {
			inputPath := fmt.Sprintf("%s.inputs[%d]", commandPath, index)
			lintTrustedText(collector, source, inputPath+".label", input.Label)
			for enumIndex, enumValue := range input.Validation.Enum {
				lintTrustedText(collector, source, fmt.Sprintf("%s.validation.enum[%d]", inputPath, enumIndex), enumValue)
			}
			currentUsage := usage[input.ID]
			if currentUsage.count == 0 {
				collector.add(PackLintWarning, "PACK_INPUT_UNUSED", source, inputPath, "declared input is never consumed by argv")
			}
			if input.Type == packs.InputString && currentUsage.stringArg && input.Validation.MaxLength == nil {
				collector.add(PackLintWarning, "PACK_INPUT_STRING_MAX_MISSING", source, inputPath+".validation.maxLength", "string input used in argv has no explicit maximum length")
			}
		}

		for index, argument := range command.Argv {
			argumentPath := fmt.Sprintf("%s.argv[%d]", commandPath, index)
			if argument.Literal != "" {
				lintTrustedText(collector, source, argumentPath+".literal", argument.Literal)
			}
			if argument.Map != nil {
				for mapIndex, key := range sortedMapKeys(argument.Map.Values) {
					lintTrustedText(collector, source, fmt.Sprintf("%s.map.values[%d]", argumentPath, mapIndex), argument.Map.Values[key])
				}
			}
		}
		if command.Output.Structured != nil {
			for index, field := range command.Output.Structured.Fields {
				lintTrustedText(collector, source, fmt.Sprintf("%s.output.structured.fields[%d].label", commandPath, index), field.Label)
			}
		}
	}
}

type packInputUsage struct {
	count      int
	stringArg  bool
	mapped     bool
	positional bool
}

func commandInputUsage(command packs.Command) map[string]packInputUsage {
	usage := make(map[string]packInputUsage, len(command.Inputs))
	for _, argument := range command.Argv {
		var inputID string
		var stringArg bool
		var mapped bool
		var positional bool
		switch {
		case argument.Flag != nil:
			inputID = argument.Flag.ValueFrom
			stringArg = true
		case argument.Positional != nil:
			inputID = argument.Positional.ValueFrom
			stringArg = true
			positional = true
		case argument.Switch != nil:
			inputID = argument.Switch.EnabledFrom
		case argument.Map != nil:
			inputID = argument.Map.ValueFrom
			mapped = true
		default:
			continue
		}
		current := usage[inputID]
		current.count++
		current.stringArg = current.stringArg || stringArg
		current.mapped = current.mapped || mapped
		current.positional = current.positional || positional
		usage[inputID] = current
	}
	return usage
}

func lintTrustedText(collector *packLintCollector, source, path, value string) {
	if value == "" || !containsTerminalControl(value) {
		return
	}
	collector.add(PackLintError, "PACK_TEXT_CONTROL", source, path, "trusted pack text contains a terminal/control character")
}

func lintDescriptionText(collector *packLintCollector, source, path, value string) {
	for _, r := range value {
		if unicode.IsControl(r) && r != '\n' {
			collector.add(PackLintError, "PACK_TEXT_CONTROL", source, path, "trusted pack text contains a terminal/control character")
			return
		}
	}
}

func containsTerminalControl(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

type packCommandRef struct {
	packID    string
	commandID string
}

type packInputRef struct {
	packID    string
	commandID string
	inputID   string
}

func lintPackTestCoverage(registry *packs.Registry, document packTestDocument, casesSource string, collector *packLintCollector) {
	successCommands := make(map[packCommandRef]bool)
	successInputs := make(map[packInputRef]bool)
	integerMinCovered := make(map[packInputRef]bool)
	integerMaxCovered := make(map[packInputRef]bool)
	enumRejected := make(map[packInputRef]bool)
	leadingDashRejected := make(map[packInputRef]bool)
	mappedEnumSuccess := make(map[packInputRef]map[int]bool)

	for caseIndex, testCase := range document.Cases {
		_, packExists := registry.FindPack(testCase.PackID)
		if !packExists {
			if !expectsPlannerError(testCase, planner.ErrUnknownPack, "packId") {
				collector.add(PackLintError, "PACK_TEST_UNKNOWN_PACK", casesSource, fmt.Sprintf("cases[%d].packId", caseIndex), "contract case references a pack outside the lint target")
			}
			continue
		}
		command, commandExists := registry.FindCommand(testCase.PackID, testCase.CommandID)
		if !commandExists {
			if !expectsPlannerError(testCase, planner.ErrUnknownCommand, "commandId") {
				collector.add(PackLintError, "PACK_TEST_UNKNOWN_COMMAND", casesSource, fmt.Sprintf("cases[%d].commandId", caseIndex), "contract case references an undeclared command")
			}
			continue
		}

		declared := make(map[string]packs.Input, len(command.Inputs))
		for _, input := range command.Inputs {
			declared[input.ID] = input
		}
		unknown := make([]string, 0)
		for inputID := range testCase.Values {
			if _, ok := declared[inputID]; !ok {
				unknown = append(unknown, inputID)
			}
		}
		sort.Strings(unknown)
		if len(unknown) != 0 {
			firstPath := "values." + unknown[0]
			if !expectsPlannerError(testCase, planner.ErrUnknownInput, firstPath) {
				for _, inputID := range unknown {
					collector.add(PackLintError, "PACK_TEST_UNKNOWN_INPUT", casesSource, fmt.Sprintf("cases[%d].values.%s", caseIndex, inputID), "contract case references an undeclared input")
				}
			}
			continue
		}

		commandRef := packCommandRef{packID: testCase.PackID, commandID: testCase.CommandID}
		if testCase.ExpectArgs != nil {
			successCommands[commandRef] = true
			usage := commandInputUsage(command)
			for _, input := range command.Inputs {
				raw, ok := testCase.Values[input.ID]
				if !ok {
					continue
				}
				inputRef := packInputRef{packID: testCase.PackID, commandID: testCase.CommandID, inputID: input.ID}
				if input.Type == packs.InputBoolean {
					var enabled bool
					if json.Unmarshal(raw, &enabled) == nil && enabled {
						successInputs[inputRef] = true
					}
				} else {
					successInputs[inputRef] = true
				}
				if input.Type == packs.InputEnum && usage[input.ID].mapped {
					var value string
					if json.Unmarshal(raw, &value) == nil {
						for enumIndex, enumValue := range input.Validation.Enum {
							if value == enumValue {
								if mappedEnumSuccess[inputRef] == nil {
									mappedEnumSuccess[inputRef] = make(map[int]bool)
								}
								mappedEnumSuccess[inputRef][enumIndex] = true
							}
						}
					}
				}
			}
			continue
		}

		if testCase.ExpectError == nil || testCase.ExpectError.Code != planner.ErrInvalidInput {
			continue
		}
		for _, input := range command.Inputs {
			inputPath := "values." + input.ID
			if testCase.ExpectError.Path != inputPath {
				continue
			}
			raw, ok := testCase.Values[input.ID]
			if !ok {
				continue
			}
			inputRef := packInputRef{packID: testCase.PackID, commandID: testCase.CommandID, inputID: input.ID}
			switch input.Type {
			case packs.InputInteger:
				var value int64
				if json.Unmarshal(raw, &value) != nil {
					continue
				}
				if input.Validation.Min != nil && value < *input.Validation.Min {
					integerMinCovered[inputRef] = true
				}
				if input.Validation.Max != nil && value > *input.Validation.Max {
					integerMaxCovered[inputRef] = true
				}
			case packs.InputString:
				var value string
				if json.Unmarshal(raw, &value) == nil && strings.HasPrefix(value, "-") {
					leadingDashRejected[inputRef] = true
				}
			case packs.InputEnum:
				var value string
				if json.Unmarshal(raw, &value) != nil {
					continue
				}
				if strings.HasPrefix(value, "-") {
					leadingDashRejected[inputRef] = true
				}
				if !stringInSlice(value, input.Validation.Enum) {
					enumRejected[inputRef] = true
				}
			}
		}
	}

	for _, loaded := range registry.Packs() {
		source := loaded.Source.Name
		packID := loaded.Pack.Metadata.ID
		for _, named := range registry.Commands(packID) {
			command := named.Command
			if !commandBrowserRunnable(command) {
				continue
			}
			commandRef := packCommandRef{packID: packID, commandID: named.ID}
			commandPath := "commands." + named.ID
			if !successCommands[commandRef] {
				collector.add(PackLintWarning, "PACK_TEST_SUCCESS_MISSING", source, commandPath, "no success contract case exercises this planner-runnable command")
			}
			usage := commandInputUsage(command)
			for index, input := range command.Inputs {
				if usage[input.ID].count == 0 {
					continue
				}
				inputRef := packInputRef{packID: packID, commandID: named.ID, inputID: input.ID}
				inputPath := fmt.Sprintf("%s.inputs[%d]", commandPath, index)
				if !successInputs[inputRef] {
					collector.add(PackLintWarning, "PACK_TEST_INPUT_SUCCESS_MISSING", source, inputPath, "no success contract case meaningfully exercises this consumed input")
				}
				if input.Type == packs.InputInteger {
					if input.Validation.Min != nil && !integerMinCovered[inputRef] {
						collector.add(PackLintWarning, "PACK_TEST_INTEGER_MIN_MISSING", source, inputPath+".validation.min", "bounded integer input has no below-minimum rejection contract case")
					}
					if input.Validation.Max != nil && !integerMaxCovered[inputRef] {
						collector.add(PackLintWarning, "PACK_TEST_INTEGER_MAX_MISSING", source, inputPath+".validation.max", "bounded integer input has no above-maximum rejection contract case")
					}
				}
				if usage[input.ID].positional &&
					(input.Type == packs.InputString || input.Type == packs.InputEnum) &&
					!leadingDashRejected[inputRef] {
					collector.add(PackLintWarning, "PACK_TEST_POSITIONAL_DASH_MISSING", source, inputPath+".validation.disallowLeadingDash", "positional string/enum input has no leading-dash rejection contract case")
				}
				if input.Type == packs.InputEnum {
					if !enumRejected[inputRef] {
						collector.add(PackLintWarning, "PACK_TEST_ENUM_REJECTION_MISSING", source, inputPath+".validation.enum", "enum input has no out-of-set rejection contract case")
					}
					if usage[input.ID].mapped {
						for enumIndex := range input.Validation.Enum {
							if !mappedEnumSuccess[inputRef][enumIndex] {
								collector.add(PackLintWarning, "PACK_TEST_MAP_BRANCH_MISSING", source, fmt.Sprintf("%s.validation.enum[%d]", inputPath, enumIndex), "mapped enum branch has no success contract case")
							}
						}
					}
				}
			}
		}
	}
}

func expectsPlannerError(testCase packTestCase, code planner.ErrorCode, path string) bool {
	if testCase.ExpectError == nil || testCase.ExpectError.Code != code {
		return false
	}
	return testCase.ExpectError.Path == "" || testCase.ExpectError.Path == path
}

func stringInSlice(value string, values []string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func diagnosticDisplaySource(source string) string {
	if source == "" || source == "-" {
		return strconv.Quote("-")
	}
	return strconv.QuoteToASCII(filepath.Base(source))
}

func sortedMapKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
