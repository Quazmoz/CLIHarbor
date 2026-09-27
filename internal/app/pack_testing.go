package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
)

const (
	PackTestSchemaVersion = "cliharbor.packtest/v1"
	maxPackTestBytes       = 1 << 20
	maxPackTestCases       = 256
	maxPackTestValues      = 64
	maxPackTestArgs        = 256
	maxPackTestArgBytes    = 4096
)

type packTestDocument struct {
	SchemaVersion string         `json:"schemaVersion"`
	Cases         []packTestCase `json:"cases"`
}

type packTestCase struct {
	Name        string                     `json:"name"`
	PackID      string                     `json:"packId"`
	CommandID   string                     `json:"commandId"`
	Values      map[string]json.RawMessage `json:"values,omitempty"`
	ExpectArgs  *[]string                  `json:"expectArgs,omitempty"`
	ExpectError *packTestExpectedError     `json:"expectError,omitempty"`
}

type packTestExpectedError struct {
	Code planner.ErrorCode `json:"code"`
	Path string            `json:"path,omitempty"`
}

func RunPackTests(options Options, packPath, casesPath string) error {
	if options.Out == nil {
		return fmt.Errorf("pack test output writer is required")
	}
	if packPath == "" {
		return fmt.Errorf("pack test pack path is required")
	}
	if casesPath == "" {
		return fmt.Errorf("pack test cases path is required")
	}

	registry, err := loadPackAuthoringRegistry([]string{packPath})
	if err != nil {
		return err
	}
	document, err := readPackTestDocument(casesPath)
	if err != nil {
		return err
	}
	if err := validatePackTestDocument(document); err != nil {
		return err
	}

	snapshot, cleanup, err := syntheticPackTestSnapshot(registry)
	if err != nil {
		return err
	}
	defer cleanup()

	failures := 0
	for _, testCase := range document.Cases {
		plan, planErr := planner.Build(registry, snapshot, planner.Request{
			PackID:    testCase.PackID,
			CommandID: testCase.CommandID,
			Values:    cloneRawValues(testCase.Values),
		})
		passed, reason := evaluatePackTestCase(testCase, plan, planErr)
		if passed {
			if _, err := fmt.Fprintf(options.Out, "PASS %s\n", testCase.Name); err != nil {
				return err
			}
			continue
		}
		failures++
		if _, err := fmt.Fprintf(options.Out, "FAIL %s: %s\n", testCase.Name, reason); err != nil {
			return err
		}
	}

	if failures != 0 {
		if _, err := fmt.Fprintf(options.Out, "Failed %d of %d pack contract case(s).\n", failures, len(document.Cases)); err != nil {
			return err
		}
		return fmt.Errorf("%d of %d pack contract case(s) failed", failures, len(document.Cases))
	}
	_, err = fmt.Fprintf(
		options.Out,
		"Passed %d pack contract case(s); no executable, version probe, help probe, or task was run.\n",
		len(document.Cases),
	)
	return err
}

func evaluatePackTestCase(testCase packTestCase, plan planner.Plan, planErr error) (bool, string) {
	if testCase.ExpectArgs != nil {
		if planErr != nil {
			return false, "expected planning success; " + plannerFailureSummary(planErr)
		}
		if !equalStrings(plan.Args, *testCase.ExpectArgs) {
			return false, "planned argv did not match expected argv"
		}
		return true, ""
	}

	if planErr == nil {
		return false, "expected planner rejection but planning succeeded"
	}
	var typed *planner.Error
	if !errors.As(planErr, &typed) {
		return false, "planner returned an unclassified internal error"
	}
	if typed.Code != testCase.ExpectError.Code {
		return false, fmt.Sprintf("planner returned error code %s instead of %s", typed.Code, testCase.ExpectError.Code)
	}
	if testCase.ExpectError.Path != "" && typed.Path != testCase.ExpectError.Path {
		return false, fmt.Sprintf("planner returned error path %q instead of %q", typed.Path, testCase.ExpectError.Path)
	}
	return true, ""
}

func plannerFailureSummary(err error) string {
	var typed *planner.Error
	if !errors.As(err, &typed) {
		return "planner returned an unclassified internal error"
	}
	if typed.Path == "" {
		return fmt.Sprintf("planner returned %s", typed.Code)
	}
	return fmt.Sprintf("planner returned %s at %s", typed.Code, typed.Path)
}

func readPackTestDocument(path string) (packTestDocument, error) {
	var zero packTestDocument
	absolute, err := filepath.Abs(path)
	if err != nil {
		return zero, fmt.Errorf("resolve pack test cases path: %w", err)
	}
	pathInfo, err := os.Lstat(absolute)
	if err != nil {
		return zero, fmt.Errorf("inspect pack test cases %q: %w", filepath.Base(absolute), err)
	}
	if pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() {
		return zero, fmt.Errorf("pack test cases %q must be a regular file, not a symlink", filepath.Base(absolute))
	}
	if pathInfo.Size() < 0 || pathInfo.Size() > maxPackTestBytes {
		return zero, fmt.Errorf("pack test cases exceed %d-byte limit", maxPackTestBytes)
	}

	file, err := os.Open(absolute)
	if err != nil {
		return zero, fmt.Errorf("open pack test cases %q: %w", filepath.Base(absolute), err)
	}
	defer file.Close()

	openInfo, err := file.Stat()
	if err != nil {
		return zero, fmt.Errorf("inspect open pack test cases: %w", err)
	}
	if !openInfo.Mode().IsRegular() || !os.SameFile(pathInfo, openInfo) {
		return zero, fmt.Errorf("pack test cases changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxPackTestBytes+1))
	if err != nil {
		return zero, fmt.Errorf("read pack test cases: %w", err)
	}
	if len(data) > maxPackTestBytes {
		return zero, fmt.Errorf("pack test cases exceed %d-byte limit", maxPackTestBytes)
	}
	closeInfo, err := file.Stat()
	if err != nil {
		return zero, fmt.Errorf("reinspect pack test cases: %w", err)
	}
	if closeInfo.Size() != openInfo.Size() || !closeInfo.ModTime().Equal(openInfo.ModTime()) {
		return zero, fmt.Errorf("pack test cases changed while reading")
	}
	if !utf8.Valid(data) {
		return zero, fmt.Errorf("pack test cases must be valid UTF-8")
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return zero, err
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var document packTestDocument
	if err := decoder.Decode(&document); err != nil {
		return zero, fmt.Errorf("decode pack test cases: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return zero, fmt.Errorf("pack test cases must contain exactly one JSON document")
		}
		return zero, fmt.Errorf("decode trailing pack test data: %w", err)
	}
	return document, nil
}

func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()

	var walk func() error
	walk = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := make(map[string]struct{})
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return fmt.Errorf("object key is not a string")
				}
				if _, exists := seen[key]; exists {
					return fmt.Errorf("duplicate object key %q", key)
				}
				seen[key] = struct{}{}
				if err := walk(); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil {
				return err
			}
			if end != json.Delim('}') {
				return fmt.Errorf("object did not terminate")
			}
		case '[':
			for decoder.More() {
				if err := walk(); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil {
				return err
			}
			if end != json.Delim(']') {
				return fmt.Errorf("array did not terminate")
			}
		default:
			return fmt.Errorf("unexpected JSON delimiter %q", delim)
		}
		return nil
	}

	if err := walk(); err != nil {
		return fmt.Errorf("pack test cases are not valid JSON: %w", err)
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("pack test cases must contain exactly one JSON document")
		}
		return fmt.Errorf("pack test cases are not valid JSON: %w", err)
	}
	return nil
}

func validatePackTestDocument(document packTestDocument) error {
	if document.SchemaVersion != PackTestSchemaVersion {
		return fmt.Errorf("unsupported pack test schema version %q", document.SchemaVersion)
	}
	if len(document.Cases) == 0 {
		return fmt.Errorf("pack test cases must contain at least one case")
	}
	if len(document.Cases) > maxPackTestCases {
		return fmt.Errorf("pack test cases exceed %d-case limit", maxPackTestCases)
	}

	seenNames := make(map[string]struct{}, len(document.Cases))
	for index, testCase := range document.Cases {
		prefix := fmt.Sprintf("cases[%d]", index)
		if testCase.Name == "" || len(testCase.Name) > 128 || containsControl(testCase.Name) {
			return fmt.Errorf("%s.name must be 1-128 printable characters", prefix)
		}
		if _, exists := seenNames[testCase.Name]; exists {
			return fmt.Errorf("%s.name duplicates another case name", prefix)
		}
		seenNames[testCase.Name] = struct{}{}
		if testCase.PackID == "" || len(testCase.PackID) > 63 || containsControl(testCase.PackID) {
			return fmt.Errorf("%s.packId must be 1-63 printable characters", prefix)
		}
		if testCase.CommandID == "" || len(testCase.CommandID) > 63 || containsControl(testCase.CommandID) {
			return fmt.Errorf("%s.commandId must be 1-63 printable characters", prefix)
		}
		if len(testCase.Values) > maxPackTestValues {
			return fmt.Errorf("%s.values exceeds %d-entry limit", prefix, maxPackTestValues)
		}
		if (testCase.ExpectArgs == nil) == (testCase.ExpectError == nil) {
			return fmt.Errorf("%s must define exactly one of expectArgs or expectError", prefix)
		}
		if testCase.ExpectArgs != nil {
			if len(*testCase.ExpectArgs) > maxPackTestArgs {
				return fmt.Errorf("%s.expectArgs exceeds %d-argument limit", prefix, maxPackTestArgs)
			}
			for _, arg := range *testCase.ExpectArgs {
				if len(arg) > maxPackTestArgBytes || containsNUL(arg) {
					return fmt.Errorf("%s.expectArgs contains an invalid argument", prefix)
				}
			}
		}
		if testCase.ExpectError != nil {
			if !supportedPlannerErrorCode(testCase.ExpectError.Code) {
				return fmt.Errorf("%s.expectError.code %q is not a supported planner error code", prefix, testCase.ExpectError.Code)
			}
			if len(testCase.ExpectError.Path) > 512 || containsControl(testCase.ExpectError.Path) {
				return fmt.Errorf("%s.expectError.path is invalid", prefix)
			}
		}
	}
	return nil
}

func supportedPlannerErrorCode(code planner.ErrorCode) bool {
	switch code {
	case planner.ErrUnknownPack,
		planner.ErrUnknownCommand,
		planner.ErrToolUnavailable,
		planner.ErrStaleDiscovery,
		planner.ErrUnknownInput,
		planner.ErrMissingInput,
		planner.ErrInvalidInput,
		planner.ErrRiskPolicy,
		planner.ErrAuthPolicy,
		planner.ErrOutputPolicy,
		planner.ErrInvalidPlanState:
		return true
	default:
		return false
	}
}

func syntheticPackTestSnapshot(registry *packs.Registry) (discovery.Snapshot, func(), error) {
	if registry == nil {
		return discovery.Snapshot{}, func() {}, fmt.Errorf("pack test registry is required")
	}
	root, err := os.MkdirTemp("", "cliharbor-pack-test-")
	if err != nil {
		return discovery.Snapshot{}, func() {}, fmt.Errorf("create pack test workspace: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(root) }

	states := make([]discovery.ToolState, 0)
	index := 0
	for _, loaded := range registry.Packs() {
		for _, named := range registry.Tools(loaded.Pack.Metadata.ID) {
			index++
			path := filepath.Join(root, fmt.Sprintf("identity-%03d.bin", index))
			if err := os.WriteFile(path, []byte("CLIHarbor pack-test synthetic identity\n"), 0o600); err != nil {
				cleanup()
				return discovery.Snapshot{}, func() {}, fmt.Errorf("create pack test identity: %w", err)
			}
			identity, err := discovery.CaptureExecutableIdentity(path)
			if err != nil {
				cleanup()
				return discovery.Snapshot{}, func() {}, fmt.Errorf("capture pack test identity: %w", err)
			}
			states = append(states, discovery.ToolState{
				PackID:             loaded.Pack.Metadata.ID,
				PackVersion:        loaded.Pack.Metadata.Version,
				ToolID:             named.ID,
				Status:             discovery.StatusReady,
				Path:               path,
				ExecutableName:     named.Tool.ExecutableNames[0],
				Version:            "0.0.0-pack-test",
				VersionConstraint:  named.Tool.VersionConstraint,
				ExecutableIdentity: identity,
			})
		}
	}
	return discovery.NewSnapshot(states), cleanup, nil
}

func cloneRawValues(values map[string]json.RawMessage) map[string]json.RawMessage {
	if values == nil {
		return map[string]json.RawMessage{}
	}
	out := make(map[string]json.RawMessage, len(values))
	for key, value := range values {
		out[key] = append(json.RawMessage(nil), value...)
	}
	return out
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func containsControl(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func containsNUL(value string) bool {
	for _, r := range value {
		if r == 0 {
			return true
		}
	}
	return false
}
