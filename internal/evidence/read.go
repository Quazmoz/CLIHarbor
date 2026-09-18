package evidence

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	semver "github.com/Masterminds/semver/v3"
)

const (
	maxBuildTokenBytes     = 128
	maxHostTokenBytes      = 256
	maxDiagnosticBytes     = 1024
	maxCandidateCount      = 4096
	maxAvailableHelpProbes = 16
	maxProbeArguments      = 16
	maxEvidenceCaptureSpan = 10 * time.Minute
)

var (
	evidenceIDPattern      = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}package evidence

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	semver "github.com/Masterminds/semver/v3"
)

const (
	maxBuildTokenBytes     = 128
	maxHostTokenBytes      = 256
	maxDiagnosticBytes     = 1024
	maxCandidateCount      = 4096
	maxAvailableHelpProbes = 16
	maxProbeArguments      = 16
	maxEvidenceCaptureSpan = 10 * time.Minute
)

var (
)
	buildTokenPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}package evidence

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	semver "github.com/Masterminds/semver/v3"
)

const (
	maxBuildTokenBytes     = 128
	maxHostTokenBytes      = 256
	maxDiagnosticBytes     = 1024
	maxCandidateCount      = 4096
	maxAvailableHelpProbes = 16
	maxProbeArguments      = 16
	maxEvidenceCaptureSpan = 10 * time.Minute
)

var (
)
	hostTokenPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}package evidence

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	semver "github.com/Masterminds/semver/v3"
)

const (
	maxBuildTokenBytes     = 128
	maxHostTokenBytes      = 256
	maxDiagnosticBytes     = 1024
	maxCandidateCount      = 4096
	maxAvailableHelpProbes = 16
	maxProbeArguments      = 16
	maxEvidenceCaptureSpan = 10 * time.Minute
)

var (
)
	windowsIdentityPath    = regexp.MustCompile(`(?i)(?:[A-Z]:\\(?:Users|Documents and Settings)\\|[A-Z]:\\[^\r\n\t"'<>|]*\.(?:exe|com)\b)`)
	posixIdentityPath      = regexp.MustCompile(`(?:^|[\s"'(])/(?:home|Users|tmp)/[^\s"')]+`)
	environmentDumpPattern = regexp.MustCompile(`(?im)^(?:PATH|HOME|USERPROFILE|TEMP|TMP|APPDATA|LOCALAPPDATA)\s*=`)
)

var validToolStatuses = map[string]struct{}{
	"ready": {}, "missing": {}, "ambiguous": {}, "incompatible": {},
	"probe-failed": {}, "invalid-override": {}, "identity-failed": {},
	"unsupported-platform": {},
}

var validProbeStatuses = map[string]struct{}{
	"exited": {}, "exited-nonzero": {}, "timed-out": {}, "cancelled": {},
	"failed": {}, "unavailable": {}, "identity-changed": {},
}

// ReadBundle reads one regular, non-symlink evidence file through a bounded
// descriptor and rejects replacement or mutation observed during the read.
// Evidence is data only; this function grants no pack or command authority.
func ReadBundle(path string) (Bundle, error) {
	var zero Bundle
	if path == "" {
		return zero, fmt.Errorf("evidence file path is required")
	}
	clean := filepath.Clean(path)
	before, err := os.Lstat(clean)
	if err != nil {
		return zero, fmt.Errorf("inspect evidence file: %w", err)
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() {
		return zero, fmt.Errorf("evidence input must be a regular non-symlink file")
	}
	if before.Size() > maxSerializedBundle {
		return zero, fmt.Errorf("evidence file exceeds %d-byte limit", maxSerializedBundle)
	}

	file, err := os.Open(clean)
	if err != nil {
		return zero, fmt.Errorf("open evidence file: %w", err)
	}
	defer file.Close()

	opened, err := file.Stat()
	if err != nil {
		return zero, fmt.Errorf("inspect opened evidence file: %w", err)
	}
	if !opened.Mode().IsRegular() || !os.SameFile(before, opened) {
		return zero, fmt.Errorf("evidence file changed before it could be read safely")
	}

	data, err := io.ReadAll(io.LimitReader(file, maxSerializedBundle+1))
	if err != nil {
		return zero, fmt.Errorf("read evidence file: %w", err)
	}
	if len(data) > maxSerializedBundle {
		return zero, fmt.Errorf("evidence file exceeds %d-byte limit", maxSerializedBundle)
	}

	afterDescriptor, err := file.Stat()
	if err != nil {
		return zero, fmt.Errorf("reinspect evidence file: %w", err)
	}
	afterPath, err := os.Lstat(clean)
	if err != nil {
		return zero, fmt.Errorf("reinspect evidence path: %w", err)
	}
	if afterPath.Mode()&os.ModeSymlink != 0 || !afterPath.Mode().IsRegular() ||
		!os.SameFile(opened, afterDescriptor) || !os.SameFile(opened, afterPath) ||
		opened.Size() != afterDescriptor.Size() || !opened.ModTime().Equal(afterDescriptor.ModTime()) {
		return zero, fmt.Errorf("evidence file changed while it was being read")
	}

	return Parse(data)
}

// Parse strictly decodes a cliharbor.phase0/v1 evidence document. Unknown
// fields, duplicate JSON keys, trailing values, malformed UTF-8, and semantic
// inconsistencies fail closed before the artifact can be reviewed.
func Parse(data []byte) (Bundle, error) {
	var zero Bundle
	if len(data) == 0 {
		return zero, fmt.Errorf("evidence document is empty")
	}
	if len(data) > maxSerializedBundle {
		return zero, fmt.Errorf("evidence document exceeds %d-byte limit", maxSerializedBundle)
	}
	if !utf8.Valid(data) {
		return zero, fmt.Errorf("evidence document must be valid UTF-8")
	}
	if !json.Valid(data) {
		return zero, fmt.Errorf("evidence document is not valid JSON")
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return zero, err
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var bundle Bundle
	if err := decoder.Decode(&bundle); err != nil {
		return zero, fmt.Errorf("decode evidence document: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return zero, fmt.Errorf("evidence document contains multiple JSON values")
		}
		return zero, fmt.Errorf("decode trailing evidence data: %w", err)
	}
	if err := Validate(bundle); err != nil {
		return zero, fmt.Errorf("validate evidence document: %w", err)
	}
	return bundle, nil
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
			seen := map[string]struct{}{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return fmt.Errorf("evidence object contains a non-string key")
				}
				if _, exists := seen[key]; exists {
					return fmt.Errorf("evidence document contains duplicate JSON key %q", key)
				}
				seen[key] = struct{}{}
				if err := walk(); err != nil {
					return err
				}
			}
			_, err = decoder.Token()
			return err
		case '[':
			for decoder.More() {
				if err := walk(); err != nil {
					return err
				}
			}
			_, err = decoder.Token()
			return err
		default:
			return fmt.Errorf("evidence document contains invalid JSON structure")
		}
	}
	if err := walk(); err != nil {
		return fmt.Errorf("inspect evidence JSON structure: %w", err)
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("evidence document contains trailing JSON")
		}
		return fmt.Errorf("inspect trailing evidence JSON: %w", err)
	}
	return nil
}

func validateBundleSemantics(bundle Bundle) error {
	if !isUTC(bundle.GeneratedAt) {
		return fmt.Errorf("evidence generatedAt must use UTC")
	}
	if err := validateBuildInfo(bundle.CLIHarbor); err != nil {
		return err
	}
	if err := validateHostInfo(bundle.Host); err != nil {
		return err
	}

	seenTools := make(map[string]struct{}, len(bundle.Tools))
	previousTool := ""
	for i, tool := range bundle.Tools {
		key := tool.PackID + "/" + tool.ToolID
		if !evidenceIDPattern.MatchString(tool.PackID) || !evidenceIDPattern.MatchString(tool.ToolID) {
			return fmt.Errorf("tool %d contains an invalid pack or tool id", i)
		}
		if previousTool != "" && key <= previousTool {
			return fmt.Errorf("evidence tools must be uniquely ordered by packId/toolId")
		}
		previousTool = key
		if _, exists := seenTools[key]; exists {
			return fmt.Errorf("duplicate tool identity %q", key)
		}
		seenTools[key] = struct{}{}
		if _, ok := validToolStatuses[tool.Status]; !ok {
			return fmt.Errorf("tool %s has unsupported status %q", key, tool.Status)
		}
		if _, err := semver.StrictNewVersion(tool.PackVersion); err != nil {
			return fmt.Errorf("tool %s has invalid packVersion", key)
		}
		if len(tool.Version) > maxBuildTokenBytes {
			return fmt.Errorf("tool %s version is too long", key)
		}
		if tool.Version != "" {
			if _, err := semver.StrictNewVersion(tool.Version); err != nil {
				return fmt.Errorf("tool %s has malformed semantic version", key)
			}
			if !tool.VersionProbeConfigured {
				return fmt.Errorf("tool %s has version evidence without a configured version probe", key)
			}
		}
		if len(tool.VersionConstraint) > maxBuildTokenBytes {
			return fmt.Errorf("tool %s version constraint is too long", key)
		}
		if tool.VersionConstraint != "" {
			if _, err := semver.NewConstraint(tool.VersionConstraint); err != nil {
				return fmt.Errorf("tool %s has malformed version constraint", key)
			}
			if !tool.VersionProbeConfigured {
				return fmt.Errorf("tool %s has a version constraint without a configured version probe", key)
			}
		}
		if err := validateTextField("tool diagnostic", tool.Diagnostic, maxDiagnosticBytes, true); err != nil {
			return fmt.Errorf("tool %s: %w", key, err)
		}
		if tool.CandidateCount < 0 || tool.CandidateCount > maxCandidateCount {
			return fmt.Errorf("tool %s candidateCount is outside the supported range", key)
		}
		if err := validateToolStateCombination(key, tool); err != nil {
			return err
		}
		if len(tool.AvailableHelpProbes) > maxAvailableHelpProbes {
			return fmt.Errorf("tool %s has too many available help probes", key)
		}
		seenHelp := map[string]struct{}{}
		previousHelp := ""
		for _, id := range tool.AvailableHelpProbes {
			if !evidenceIDPattern.MatchString(id) || id == "version" {
				return fmt.Errorf("tool %s has invalid help probe id %q", key, id)
			}
			if previousHelp != "" && id <= previousHelp {
				return fmt.Errorf("tool %s help probe ids must be unique and sorted", key)
			}
			previousHelp = id
			seenHelp[id] = struct{}{}
		}

		seenProbeIDs := map[string]struct{}{}
		seenProbeIdentities := map[string]struct{}{}
		previousProbeIdentity := ""
		for _, probe := range tool.Probes {
			if err := validateProbe(bundle.GeneratedAt, tool, seenHelp, probe); err != nil {
				return fmt.Errorf("tool %s probe %q: %w", key, probe.ID, err)
			}
			if _, exists := seenProbeIDs[probe.ID]; exists {
				return fmt.Errorf("tool %s contains duplicate probe id %q", key, probe.ID)
			}
			seenProbeIDs[probe.ID] = struct{}{}
			if _, exists := seenProbeIdentities[probe.Identity]; exists {
				return fmt.Errorf("tool %s contains duplicate probe identity %q", key, probe.Identity)
			}
			seenProbeIdentities[probe.Identity] = struct{}{}
			if previousProbeIdentity != "" && probe.Identity <= previousProbeIdentity {
				return fmt.Errorf("tool %s probes must be uniquely ordered by identity", key)
			}
			previousProbeIdentity = probe.Identity
		}
	}
	return nil
}

func validateBuildInfo(build BuildInfo) error {
	for name, value := range map[string]string{
		"cliharbor.version":   build.Version,
		"cliharbor.commit":    build.Commit,
		"cliharbor.buildMode": build.BuildMode,
	} {
		if !buildTokenPattern.MatchString(value) {
			return fmt.Errorf("%s must be a bounded build-identity token", name)
		}
	}
	return nil
}

func validateHostInfo(host HostInfo) error {
	if !hostTokenPattern.MatchString(host.OS) || !hostTokenPattern.MatchString(host.Architecture) {
		return fmt.Errorf("host OS and architecture must be bounded identity tokens")
	}
	if err := validateTextField("host OS version", host.OSVersion, maxHostTokenBytes, false); err != nil {
		return err
	}
	return nil
}

func validateToolStateCombination(key string, tool ToolRecord) error {
	switch tool.Status {
	case "missing", "invalid-override", "unsupported-platform":
		if tool.CandidateCount != 0 {
			return fmt.Errorf("tool %s status %s requires candidateCount 0", key, tool.Status)
		}
	case "ambiguous":
		if tool.CandidateCount < 2 {
			return fmt.Errorf("tool %s ambiguous status requires at least two candidates", key)
		}
	case "ready", "incompatible", "probe-failed", "identity-failed":
		if tool.CandidateCount != 1 {
			return fmt.Errorf("tool %s status %s requires exactly one candidate", key, tool.Status)
		}
	}
	if tool.Status == "ready" && tool.VersionProbeConfigured && tool.Version == "" {
		return fmt.Errorf("tool %s ready status with a version probe requires parsed version evidence", key)
	}
	if tool.Status == "incompatible" {
		if !tool.VersionProbeConfigured || tool.Version == "" || tool.VersionConstraint == "" {
			return fmt.Errorf("tool %s incompatible status requires version probe, version, and constraint evidence", key)
		}
	}
	if tool.Status == "probe-failed" && !tool.VersionProbeConfigured {
		return fmt.Errorf("tool %s probe-failed status requires a configured version probe", key)
	}
	return nil
}

func validateProbe(generatedAt time.Time, tool ToolRecord, help map[string]struct{}, probe ProbeRecord) error {
	if !evidenceIDPattern.MatchString(probe.ID) {
		return fmt.Errorf("invalid probe id")
	}
	if probe.Kind != "version" && probe.Kind != "help" {
		return fmt.Errorf("unsupported probe kind %q", probe.Kind)
	}
	expectedIdentity := tool.PackID + "/" + tool.ToolID + "/" + probe.ID
	if probe.Identity != expectedIdentity {
		return fmt.Errorf("probe identity does not match its owning tool")
	}
	if probe.Kind == "version" {
		if probe.ID != "version" || !tool.VersionProbeConfigured {
			return fmt.Errorf("version probe provenance is not declared by the tool")
		}
	} else {
		if probe.ID == "version" {
			return fmt.Errorf("help probe cannot use the reserved version id")
		}
		if _, ok := help[probe.ID]; !ok {
			return fmt.Errorf("help probe provenance is not declared by the tool")
		}
	}
	if _, ok := validProbeStatuses[probe.Status]; !ok {
		return fmt.Errorf("unsupported probe status %q", probe.Status)
	}
	if len(probe.Arguments) > maxProbeArguments {
		return fmt.Errorf("too many probe arguments")
	}
	for _, argument := range probe.Arguments {
		if err := validateTextField("probe argument", argument, MaxArgumentBytes, false); err != nil {
			return err
		}
	}
	if err := validateTextField("probe diagnostic", probe.Diagnostic, maxDiagnosticBytes, true); err != nil {
		return err
	}
	if err := validateTextField("probe stdout", probe.Stdout, MaxCapturedTextBytes, true); err != nil {
		return err
	}
	if err := validateTextField("probe stderr", probe.Stderr, MaxCapturedTextBytes, true); err != nil {
		return err
	}
	if probe.TimedOut && probe.Cancelled {
		return fmt.Errorf("probe cannot be both timed out and cancelled")
	}

	executed := probe.Status == "exited" || probe.Status == "exited-nonzero" ||
		probe.Status == "timed-out" || probe.Status == "cancelled"
	if !executed {
		if probe.StartedAt != nil || probe.EndedAt != nil || probe.ExitCode != nil ||
			probe.TimedOut || probe.Cancelled || probe.Truncated || probe.Stdout != "" || probe.Stderr != "" {
			return fmt.Errorf("non-executed probe status carries execution evidence")
		}
		if probe.Diagnostic == "" {
			return fmt.Errorf("non-executed probe status requires a diagnostic")
		}
		return nil
	}
	if probe.StartedAt == nil || probe.EndedAt == nil || probe.ExitCode == nil {
		return fmt.Errorf("executed probe is missing timestamps or exit code")
	}
	if !isUTC(*probe.StartedAt) || !isUTC(*probe.EndedAt) {
		return fmt.Errorf("probe timestamps must use UTC")
	}
	if probe.StartedAt.Before(generatedAt) || probe.EndedAt.Before(*probe.StartedAt) ||
		probe.EndedAt.After(generatedAt.Add(maxEvidenceCaptureSpan)) {
		return fmt.Errorf("probe timestamps are inconsistent with evidence generation")
	}
	switch probe.Status {
	case "exited":
		if *probe.ExitCode != 0 || probe.TimedOut || probe.Cancelled {
			return fmt.Errorf("successful exit state is inconsistent")
		}
	case "exited-nonzero":
		if *probe.ExitCode == 0 || probe.TimedOut || probe.Cancelled {
			return fmt.Errorf("non-zero exit state is inconsistent")
		}
	case "timed-out":
		if !probe.TimedOut || probe.Cancelled {
			return fmt.Errorf("timeout state is inconsistent")
		}
	case "cancelled":
		if !probe.Cancelled || probe.TimedOut {
			return fmt.Errorf("cancellation state is inconsistent")
		}
	}
	return nil
}

func validateTextField(name, value string, maxBytes int, allowFormattingWhitespace bool) error {
	if len(value) > maxBytes {
		return fmt.Errorf("%s exceeds %d-byte limit", name, maxBytes)
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			if allowFormattingWhitespace && (r == '\n' || r == '\r' || r == '\t') {
				continue
			}
			return fmt.Errorf("%s contains unsupported control characters", name)
		}
	}
	if containsUnsanitizedSecret(value) {
		return fmt.Errorf("%s contains unsanitized secret-like material", name)
	}
	if containsForbiddenPathMaterial(value) {
		return fmt.Errorf("%s contains path/environment material excluded by the evidence contract", name)
	}
	return nil
}

func containsUnsanitizedSecret(value string) bool {
	for _, match := range authorizationPattern.FindAllString(value, -1) {
		if !strings.Contains(match, "[REDACTED]") {
			return true
		}
	}
	for _, match := range secretAssignmentPattern.FindAllString(value, -1) {
		if !strings.Contains(match, "[REDACTED]") {
			return true
		}
	}
	return jwtPattern.MatchString(value)
}

func containsForbiddenPathMaterial(value string) bool {
	return windowsIdentityPath.MatchString(value) ||
		posixIdentityPath.MatchString(value) ||
		environmentDumpPattern.MatchString(value)
}

func isUTC(value time.Time) bool {
	_, offset := value.Zone()
	return offset == 0
}
