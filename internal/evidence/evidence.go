package evidence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	SchemaVersion          = "cliharbor.phase0/v1"
	MaxCapturedTextBytes   = 64 << 10
	MaxArgumentBytes       = 256
	maxSerializedBundle    = 2 << 20
	maxTools               = 64
	maxProbesPerTool       = 32
	evidenceFilePermission = 0o600
)

type Bundle struct {
	SchemaVersion string       `json:"schemaVersion"`
	GeneratedAt   time.Time    `json:"generatedAt"`
	CLIHarbor     BuildInfo    `json:"cliharbor"`
	Host          HostInfo     `json:"host"`
	Tools         []ToolRecord `json:"tools"`
}

type BuildInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildMode string `json:"buildMode"`
}

type HostInfo struct {
	OS           string `json:"os"`
	OSVersion    string `json:"osVersion,omitempty"`
	Architecture string `json:"architecture"`
}

type ToolRecord struct {
	PackID                 string        `json:"packId"`
	PackVersion            string        `json:"packVersion"`
	ToolID                 string        `json:"toolId"`
	Status                 string        `json:"status"`
	Version                string        `json:"version,omitempty"`
	VersionConstraint      string        `json:"versionConstraint,omitempty"`
	VersionProbeConfigured bool          `json:"versionProbeConfigured"`
	CandidateCount         int           `json:"candidateCount"`
	Diagnostic             string        `json:"diagnostic,omitempty"`
	AvailableHelpProbes    []string      `json:"availableHelpProbes,omitempty"`
	Probes                 []ProbeRecord `json:"probes,omitempty"`
}

type ProbeRecord struct {
	ID         string    `json:"id"`
	Kind       string    `json:"kind"`
	Identity   string    `json:"identity"`
	Arguments  []string  `json:"arguments,omitempty"`
	Status     string    `json:"status"`
	StartedAt  time.Time `json:"startedAt,omitempty"`
	EndedAt    time.Time `json:"endedAt,omitempty"`
	ExitCode   *int      `json:"exitCode,omitempty"`
	TimedOut   bool      `json:"timedOut,omitempty"`
	Cancelled  bool      `json:"cancelled,omitempty"`
	Truncated  bool      `json:"truncated,omitempty"`
	Stdout     string    `json:"stdout,omitempty"`
	Stderr     string    `json:"stderr,omitempty"`
	Diagnostic string    `json:"diagnostic,omitempty"`
}

var (
	authorizationPattern    = regexp.MustCompile(`(?i)\b(authorization\s*:\s*(?:bearer|basic))\s+[^\s]+`)
	secretAssignmentPattern = regexp.MustCompile(`(?i)\b(password|passwd|token|access[_ -]?token|refresh[_ -]?token|secret|api[_ -]?key|client[_ -]?secret)(\s*[:=]\s*)[^\s"']+`)
	jwtPattern              = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)
)

func SanitizeText(raw []byte) string {
	text := strings.ToValidUTF8(string(raw), "\uFFFD")
	var builder strings.Builder
	builder.Grow(len(text))
	for _, r := range text {
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			builder.WriteRune('\uFFFD')
			continue
		}
		builder.WriteRune(r)
	}
	text = builder.String()
	text = authorizationPattern.ReplaceAllString(text, "$1 [REDACTED]")
	text = secretAssignmentPattern.ReplaceAllString(text, "$1$2[REDACTED]")
	text = jwtPattern.ReplaceAllString(text, "[REDACTED_JWT]")
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		text = RedactPath(text, home, "[USER_HOME]")
	}
	if temp := os.TempDir(); temp != "" {
		text = RedactPath(text, temp, "[TEMP]")
	}
	return trimUTF8Bytes(text, MaxCapturedTextBytes)
}

func SanitizeArgument(argument string) string {
	return trimUTF8Bytes(SanitizeText([]byte(argument)), MaxArgumentBytes)
}

func Validate(bundle Bundle) error {
	if bundle.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported evidence schema version %q", bundle.SchemaVersion)
	}
	if bundle.GeneratedAt.IsZero() {
		return fmt.Errorf("evidence generatedAt is required")
	}
	if bundle.CLIHarbor.Version == "" || bundle.Host.OS == "" || bundle.Host.Architecture == "" {
		return fmt.Errorf("evidence build and host identity are required")
	}
	if len(bundle.Tools) > maxTools {
		return fmt.Errorf("evidence contains too many tools")
	}
	for i, tool := range bundle.Tools {
		if tool.PackID == "" || tool.ToolID == "" || tool.Status == "" {
			return fmt.Errorf("tool %d is missing required identity", i)
		}
		if len(tool.Probes) > maxProbesPerTool {
			return fmt.Errorf("tool %s/%s contains too many probes", tool.PackID, tool.ToolID)
		}
		for _, probe := range tool.Probes {
			if probe.ID == "" || probe.Kind == "" || probe.Identity == "" || probe.Status == "" {
				return fmt.Errorf("tool %s/%s contains incomplete probe evidence", tool.PackID, tool.ToolID)
			}
			if len(probe.Arguments) > 16 {
				return fmt.Errorf("tool %s/%s probe %s contains too many arguments", tool.PackID, tool.ToolID, probe.ID)
			}
			for _, argument := range probe.Arguments {
				if len(argument) > MaxArgumentBytes || strings.ContainsRune(argument, '\x00') {
					return fmt.Errorf("tool %s/%s probe %s contains an invalid argument", tool.PackID, tool.ToolID, probe.ID)
				}
			}
			if len(probe.Stdout) > MaxCapturedTextBytes || len(probe.Stderr) > MaxCapturedTextBytes {
				return fmt.Errorf("tool %s/%s probe %s exceeds capture bounds", tool.PackID, tool.ToolID, probe.ID)
			}
		}
	}
	return nil
}

func WriteBundle(ctx context.Context, destination string, bundle Bundle) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := Validate(bundle); err != nil {
		return err
	}
	if destination == "" {
		return fmt.Errorf("evidence export path is required")
	}
	if !filepath.IsAbs(destination) && containsParentTraversal(destination) {
		return fmt.Errorf("relative evidence export path may not contain parent traversal")
	}
	clean := filepath.Clean(destination)
	if info, err := os.Lstat(clean); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("evidence export path must not be a symlink")
		}
		return fmt.Errorf("evidence export path already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect evidence export path: %w", err)
	}

	parent := filepath.Dir(clean)
	info, err := os.Stat(parent)
	if err != nil {
		return fmt.Errorf("inspect evidence export directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("evidence export parent is not a directory")
	}

	payload, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return fmt.Errorf("encode evidence bundle: %w", err)
	}
	payload = append(payload, '\n')
	if len(payload) > maxSerializedBundle {
		return fmt.Errorf("evidence bundle exceeds %d-byte serialized limit", maxSerializedBundle)
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	temp, err := os.CreateTemp(parent, ".cliharbor-evidence-*.tmp")
	if err != nil {
		return fmt.Errorf("create evidence staging file: %w", err)
	}
	tempName := temp.Name()
	cleanup := func() { _ = os.Remove(tempName) }
	defer cleanup()
	if err := temp.Chmod(evidenceFilePermission); err != nil {
		_ = temp.Close()
		return fmt.Errorf("protect evidence staging file: %w", err)
	}
	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write evidence staging file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("sync evidence staging file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close evidence staging file: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.Link(tempName, clean); err != nil {
		if _, statErr := os.Lstat(clean); statErr == nil {
			return fmt.Errorf("evidence export path already exists")
		}
		return fmt.Errorf("activate evidence bundle without overwrite: %w", err)
	}
	return nil
}

// RedactPath replaces common representations of one local path. On Windows the
// match is case-insensitive because path casing is not an authority boundary.
func RedactPath(value, path, replacement string) string {
	clean := filepath.Clean(path)
	for _, variant := range []string{clean, filepath.ToSlash(clean), strings.ReplaceAll(clean, "/", "\\")} {
		if variant == "" || variant == "." {
			continue
		}
		if runtime.GOOS == "windows" {
			value = regexp.MustCompile("(?i)" + regexp.QuoteMeta(variant)).ReplaceAllString(value, replacement)
			continue
		}
		value = strings.ReplaceAll(value, variant, replacement)
	}
	return value
}

func containsParentTraversal(path string) bool {
	normalized := strings.ReplaceAll(path, "\\", "/")
	for _, part := range strings.Split(normalized, "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

func trimUTF8Bytes(value string, max int) string {
	if len(value) <= max {
		return value
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}
