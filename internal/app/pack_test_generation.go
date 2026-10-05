package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

const (
	generatedStringSearchLimit = 64
	minGeneratedInt64          = -1 << 63
	maxGeneratedInt64          = 1<<63 - 1
)

func GeneratePackTests(options Options, packPath, outputPath string) error {
	if options.Out == nil {
		return fmt.Errorf("pack test generation output writer is required")
	}
	if packPath == "" {
		return fmt.Errorf("pack test generation pack path is required")
	}
	if outputPath == "" {
		return fmt.Errorf("pack test generation output path is required")
	}
	if strings.ToLower(filepath.Ext(outputPath)) != ".json" {
		return fmt.Errorf("pack test generation output must use .json")
	}

	registry, err := loadPackAuthoringRegistry([]string{packPath})
	if err != nil {
		return err
	}
	document, err := generatePackTestDocument(registry)
	if err != nil {
		return err
	}
	if err := validatePackTestDocument(document); err != nil {
		return fmt.Errorf("generated pack test fixture is invalid: %w", err)
	}

	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return fmt.Errorf("encode generated pack test fixture: %w", err)
	}
	data = append(data, '\n')

	absolute, err := filepath.Abs(outputPath)
	if err != nil {
		return fmt.Errorf("resolve generated pack test output: %w", err)
	}
	parent := filepath.Dir(absolute)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return fmt.Errorf("inspect generated pack test output directory %q: %w", filepath.Base(parent), err)
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() {
		return fmt.Errorf("generated pack test output directory must be a real directory, not a symlink")
	}

	file, err := os.OpenFile(absolute, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return fmt.Errorf("generated pack test output %q already exists", filepath.Base(absolute))
		}
		return fmt.Errorf("create generated pack test output %q: %w", filepath.Base(absolute), err)
	}
	keep := false
	defer func() {
		_ = file.Close()
		if !keep {
			_ = os.Remove(absolute)
		}
	}()

	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("write generated pack test fixture: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync generated pack test fixture: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close generated pack test fixture: %w", err)
	}
	keep = true

	_, err = fmt.Fprintf(
		options.Out,
		"Generated %d planner contract case(s) in %s; no executable, discovery probe, version probe, help probe, task, or authentication/session state was accessed.\nReview expected argv against authoritative vendor evidence before treating the fixture as a semantic contract.\n",
		len(document.Cases),
		filepath.Base(absolute),
	)
	return err
}

func generatePackTestDocument(registry *packs.Registry) (packTestDocument, error) {
	if registry == nil {
		return packTestDocument{}, fmt.Errorf("pack test generation registry is required")
	}
	snapshot, cleanup, err := syntheticPackTestSnapshot(registry)
	if err != nil {
		return packTestDocument{}, err
	}
	defer cleanup()

	document := packTestDocument{SchemaVersion: PackTestSchemaVersion}
	for _, loaded := range registry.Packs() {
		packID := loaded.Pack.Metadata.ID
		for _, named := range registry.Commands(packID) {
			command := named.Command
			if policyCode, blocked := generatedPolicyRejection(command); blocked {
				_, planErr := planner.Build(registry, snapshot, planner.Request{
					PackID:    packID,
					CommandID: named.ID,
					Values:    map[string]json.RawMessage{},
				})
				expected, err := generatedExpectedPlannerError(planErr)
				if err != nil {
					return packTestDocument{}, fmt.Errorf("generate policy fixture for %s/%s: %w", packID, named.ID, err)
				}
				if expected.Code != policyCode {
					return packTestDocument{}, fmt.Errorf(
						"generate policy fixture for %s/%s: planner returned %s instead of %s",
						packID,
						named.ID,
						expected.Code,
						policyCode,
					)
				}
				if err := appendGeneratedPackTestCase(&document, named.ID+" policy rejection", packTestCase{
					PackID:      packID,
					CommandID:   named.ID,
					Values:      map[string]json.RawMessage{},
					ExpectError: expected,
				}); err != nil {
					return packTestDocument{}, err
				}
				continue
			}

			values, err := generatedBaselineValues(command)
			if err != nil {
				return packTestDocument{}, fmt.Errorf("generate baseline values for %s/%s: %w", packID, named.ID, err)
			}
			if err := appendGeneratedSuccessCase(
				&document,
				registry,
				snapshot,
				packID,
				named.ID,
				named.ID+" success",
				values,
			); err != nil {
				return packTestDocument{}, err
			}

			usage := commandInputUsage(command)
			for _, input := range command.Inputs {
				if usage[input.ID].count == 0 {
					continue
				}
				inputPath := "values." + input.ID
				switch input.Type {
				case packs.InputInteger:
					if input.Validation.Min != nil && *input.Validation.Min > minGeneratedInt64 {
						invalid := cloneRawValues(values)
						raw, err := generatedRawValue(*input.Validation.Min - 1)
						if err != nil {
							return packTestDocument{}, err
						}
						invalid[input.ID] = raw
						if err := appendGeneratedErrorCase(
							&document,
							packID,
							named.ID,
							named.ID+" "+input.ID+" below minimum",
							invalid,
							planner.ErrInvalidInput,
							inputPath,
						); err != nil {
							return packTestDocument{}, err
						}
					}
					if input.Validation.Max != nil && *input.Validation.Max < maxGeneratedInt64 {
						invalid := cloneRawValues(values)
						raw, err := generatedRawValue(*input.Validation.Max + 1)
						if err != nil {
							return packTestDocument{}, err
						}
						invalid[input.ID] = raw
						if err := appendGeneratedErrorCase(
							&document,
							packID,
							named.ID,
							named.ID+" "+input.ID+" above maximum",
							invalid,
							planner.ErrInvalidInput,
							inputPath,
						); err != nil {
							return packTestDocument{}, err
						}
					}
				case packs.InputString:
					if usage[input.ID].positional {
						invalid := cloneRawValues(values)
						raw, err := generatedRawValue("-cliharbor-invalid")
						if err != nil {
							return packTestDocument{}, err
						}
						invalid[input.ID] = raw
						if err := appendGeneratedErrorCase(
							&document,
							packID,
							named.ID,
							named.ID+" "+input.ID+" leading dash",
							invalid,
							planner.ErrInvalidInput,
							inputPath,
						); err != nil {
							return packTestDocument{}, err
						}
					}
				case packs.InputEnum:
					if usage[input.ID].mapped {
						for index, enumValue := range input.Validation.Enum {
							if index == 0 {
								continue
							}
							variant := cloneRawValues(values)
							raw, err := generatedRawValue(enumValue)
							if err != nil {
								return packTestDocument{}, err
							}
							variant[input.ID] = raw
							if err := appendGeneratedSuccessCase(
								&document,
								registry,
								snapshot,
								packID,
								named.ID,
								fmt.Sprintf("%s %s map branch %d", named.ID, input.ID, index+1),
								variant,
							); err != nil {
								return packTestDocument{}, err
							}
						}
					}

					invalidValue := "__cliharbor_invalid__"
					for stringInSlice(invalidValue, input.Validation.Enum) {
						invalidValue += "x"
					}
					invalid := cloneRawValues(values)
					raw, err := generatedRawValue(invalidValue)
					if err != nil {
						return packTestDocument{}, err
					}
					invalid[input.ID] = raw
					if err := appendGeneratedErrorCase(
						&document,
						packID,
						named.ID,
						named.ID+" "+input.ID+" enum rejection",
						invalid,
						planner.ErrInvalidInput,
						inputPath,
					); err != nil {
						return packTestDocument{}, err
					}

					if usage[input.ID].positional {
						dash := cloneRawValues(values)
						raw, err := generatedRawValue("-cliharbor-invalid")
						if err != nil {
							return packTestDocument{}, err
						}
						dash[input.ID] = raw
						if err := appendGeneratedErrorCase(
							&document,
							packID,
							named.ID,
							named.ID+" "+input.ID+" leading dash",
							dash,
							planner.ErrInvalidInput,
							inputPath,
						); err != nil {
							return packTestDocument{}, err
						}
					}
				}
			}
		}
	}

	if len(document.Cases) == 0 {
		return packTestDocument{}, fmt.Errorf("pack test generation found no commands; add reviewed commands before generating planner contracts")
	}

	for _, testCase := range document.Cases {
		plan, planErr := planner.Build(registry, snapshot, planner.Request{
			PackID:    testCase.PackID,
			CommandID: testCase.CommandID,
			Values:    cloneRawValues(testCase.Values),
		})
		passed, reason := evaluatePackTestCase(testCase, plan, planErr)
		if !passed {
			return packTestDocument{}, fmt.Errorf("generated case %q failed self-verification: %s", testCase.Name, reason)
		}
	}
	return document, nil
}

// plannerAdmitsRisk mirrors planner.Build: change/destructive plans are built
// but still need a backend approval before the run manager executes them.
func plannerAdmitsRisk(risk packs.Risk) bool {
	return risk == packs.RiskRead || risk == packs.RiskChange || risk == packs.RiskDestructive
}

func generatedPolicyRejection(command packs.Command) (planner.ErrorCode, bool) {
	if !plannerAdmitsRisk(command.Risk) {
		return planner.ErrRiskPolicy, true
	}
	if command.Requirements.RequiresAuth && command.Requirements.AuthMode != packs.AuthModeVendorSession {
		return planner.ErrAuthPolicy, true
	}
	if command.Output.Sensitivity.ContainsSecrets {
		return planner.ErrOutputPolicy, true
	}
	return "", false
}

func generatedBaselineValues(command packs.Command) (map[string]json.RawMessage, error) {
	usage := commandInputUsage(command)
	values := make(map[string]json.RawMessage, len(command.Inputs))
	for _, input := range command.Inputs {
		if !input.Required && usage[input.ID].count == 0 {
			continue
		}

		var sample any
		switch input.Type {
		case packs.InputString, packs.InputSecret:
			value, err := generatedStringSample(input)
			if err != nil {
				return nil, fmt.Errorf("input %s: %w", input.ID, err)
			}
			sample = value
		case packs.InputInteger:
			sample = generatedIntegerSample(input)
		case packs.InputBoolean:
			sample = true
		case packs.InputEnum:
			if len(input.Validation.Enum) == 0 {
				return nil, fmt.Errorf("input %s has no enum values", input.ID)
			}
			sample = input.Validation.Enum[0]
		case packs.InputMultiselect:
			if len(input.Validation.Enum) == 0 {
				sample = []string{}
			} else {
				sample = []string{input.Validation.Enum[0]}
			}
		default:
			return nil, fmt.Errorf("input %s uses unsupported type %q", input.ID, input.Type)
		}

		raw, err := generatedRawValue(sample)
		if err != nil {
			return nil, fmt.Errorf("input %s: %w", input.ID, err)
		}
		values[input.ID] = raw
	}
	return values, nil
}

func generatedIntegerSample(input packs.Input) int64 {
	if input.Validation.Min != nil && *input.Validation.Min > 0 {
		return *input.Validation.Min
	}
	if input.Validation.Max != nil && *input.Validation.Max < 0 {
		return *input.Validation.Max
	}
	return 0
}

func generatedStringSample(input packs.Input) (string, error) {
	minLength := 0
	if input.Validation.MinLength != nil {
		minLength = *input.Validation.MinLength
	}
	maxLength := maxPackTestArgBytes
	if input.Validation.MaxLength != nil && *input.Validation.MaxLength < maxLength {
		maxLength = *input.Validation.MaxLength
	}
	if minLength > maxLength || minLength > maxPackTestArgBytes {
		return "", fmt.Errorf("string constraints cannot fit the %d-byte pack-test argument limit", maxPackTestArgBytes)
	}

	var pattern *regexp.Regexp
	var err error
	if input.Validation.Pattern != "" {
		pattern, err = regexp.Compile(input.Validation.Pattern)
		if err != nil {
			return "", fmt.Errorf("validated input pattern could not be compiled: %w", err)
		}
	}
	allowed := func(candidate string) bool {
		length := utf8.RuneCountInString(candidate)
		if length < minLength || length > maxLength {
			return false
		}
		if input.Validation.DisallowLeadingDash && strings.HasPrefix(candidate, "-") {
			return false
		}
		if strings.ContainsRune(candidate, '\x00') {
			return false
		}
		return pattern == nil || pattern.MatchString(candidate)
	}

	candidates := []string{
		"x",
		"a",
		"1",
		"0",
		"test",
		"value",
		"example",
		"resource",
		"fixed",
		"user:demo",
		"a/b",
		"",
	}
	for _, candidate := range candidates {
		if allowed(candidate) {
			return candidate, nil
		}
	}

	for _, runeValue := range []string{"a", "x", "1", "0"} {
		lengths := make([]int, 0, generatedStringSearchLimit+1)
		if minLength > 0 {
			lengths = append(lengths, minLength)
		}
		for length := 1; length <= generatedStringSearchLimit && length <= maxLength; length++ {
			if length >= minLength {
				lengths = append(lengths, length)
			}
		}
		for _, length := range lengths {
			candidate := strings.Repeat(runeValue, length)
			if allowed(candidate) {
				return candidate, nil
			}
		}
	}
	return "", fmt.Errorf("no deterministic safe sample satisfies the declared string validation; author this fixture value manually")
}

func generatedRawValue(value any) (json.RawMessage, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode generated pack test value: %w", err)
	}
	return json.RawMessage(data), nil
}

func appendGeneratedSuccessCase(
	document *packTestDocument,
	registry *packs.Registry,
	snapshot discovery.Snapshot,
	packID string,
	commandID string,
	descriptor string,
	values map[string]json.RawMessage,
) error {
	plan, err := planner.Build(registry, snapshot, planner.Request{
		PackID:    packID,
		CommandID: commandID,
		Values:    cloneRawValues(values),
	})
	if err != nil {
		return fmt.Errorf("generate success fixture for %s/%s: %s", packID, commandID, plannerFailureSummary(err))
	}
	args := append([]string(nil), plan.Args...)
	return appendGeneratedPackTestCase(document, descriptor, packTestCase{
		PackID:     packID,
		CommandID:  commandID,
		Values:     cloneRawValues(values),
		ExpectArgs: &args,
	})
}

func appendGeneratedErrorCase(
	document *packTestDocument,
	packID string,
	commandID string,
	descriptor string,
	values map[string]json.RawMessage,
	code planner.ErrorCode,
	path string,
) error {
	expected := &packTestExpectedError{Code: code, Path: path}
	return appendGeneratedPackTestCase(document, descriptor, packTestCase{
		PackID:      packID,
		CommandID:   commandID,
		Values:      cloneRawValues(values),
		ExpectError: expected,
	})
}

func appendGeneratedPackTestCase(document *packTestDocument, descriptor string, testCase packTestCase) error {
	if len(document.Cases) >= maxPackTestCases {
		return fmt.Errorf("generated pack test fixture exceeds %d-case limit; author focused fixtures manually", maxPackTestCases)
	}
	testCase.Name = generatedPackTestCaseName(len(document.Cases)+1, descriptor)
	document.Cases = append(document.Cases, testCase)
	return nil
}

func generatedPackTestCaseName(ordinal int, descriptor string) string {
	prefix := fmt.Sprintf("%03d ", ordinal)
	maxDescriptorBytes := 128 - len(prefix)
	if len(descriptor) > maxDescriptorBytes {
		descriptor = descriptor[:maxDescriptorBytes]
	}
	return prefix + descriptor
}

func generatedExpectedPlannerError(err error) (*packTestExpectedError, error) {
	if err == nil {
		return nil, fmt.Errorf("expected planner rejection but planning succeeded")
	}
	var typed *planner.Error
	if !errors.As(err, &typed) {
		return nil, fmt.Errorf("planner returned an unclassified internal error")
	}
	if !supportedPlannerErrorCode(typed.Code) {
		return nil, fmt.Errorf("planner returned unsupported error code %s", typed.Code)
	}
	return &packTestExpectedError{Code: typed.Code, Path: typed.Path}, nil
}
