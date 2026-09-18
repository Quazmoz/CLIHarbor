package diagnostics

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	SchemaVersion      = "cliharbor.diagnostics/v1"
	MaxSerializedBytes = 64 << 10
	maxPacks           = 64
	maxTools           = 256
	maxCandidateCount  = 64
	privateFileMode    = 0o600
)

type Bundle struct {
	SchemaVersion string        `json:"schemaVersion"`
	CLIHarbor     BuildInfo     `json:"cliharbor"`
	Runtime       RuntimeInfo   `json:"runtime"`
	Configuration Configuration `json:"configuration"`
	Health        Health        `json:"health"`
	Packs         []PackRecord  `json:"packs"`
	Tools         []ToolRecord  `json:"tools"`
}

type BuildInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildMode string `json:"buildMode"`
}

type RuntimeInfo struct {
	GoVersion    string `json:"goVersion"`
	OS           string `json:"os"`
	OSVersion    string `json:"osVersion,omitempty"`
	Architecture string `json:"architecture"`
}

type Configuration struct {
	PackSourceMode    string `json:"packSourceMode"`
	PackCount         int    `json:"packCount"`
	ToolOverrideCount int    `json:"toolOverrideCount"`
}

type Health struct {
	ToolsReady       int `json:"toolsReady"`
	ToolsUnavailable int `json:"toolsUnavailable"`
}

type PackRecord struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}

type ToolRecord struct {
	PackID         string `json:"packId"`
	PackVersion    string `json:"packVersion"`
	ToolID         string `json:"toolId"`
	Status         string `json:"status"`
	Version        string `json:"version,omitempty"`
	CandidateCount int    `json:"candidateCount"`
}

var allowedStatuses = map[string]struct{}{
	"ready": {}, "missing": {}, "ambiguous": {}, "incompatible": {},
	"probe-failed": {}, "invalid-override": {}, "identity-failed": {},
	"unsupported-platform": {},
}

func Validate(bundle Bundle) error {
	if bundle.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported diagnostics schema version %q", bundle.SchemaVersion)
	}
	for name, value := range map[string]string{
		"version":      bundle.CLIHarbor.Version,
		"commit":       bundle.CLIHarbor.Commit,
		"buildMode":    bundle.CLIHarbor.BuildMode,
		"goVersion":    bundle.Runtime.GoVersion,
		"os":           bundle.Runtime.OS,
		"architecture": bundle.Runtime.Architecture,
	} {
		if err := validateToken(name, value, false); err != nil {
			return err
		}
	}
	if err := validateToken("osVersion", bundle.Runtime.OSVersion, true); err != nil {
		return err
	}
	switch bundle.Configuration.PackSourceMode {
	case "none", "files", "directory":
	default:
		return fmt.Errorf("invalid diagnostics pack source mode %q", bundle.Configuration.PackSourceMode)
	}
	if bundle.Configuration.PackCount != len(bundle.Packs) || bundle.Configuration.PackCount < 0 || bundle.Configuration.PackCount > maxPacks {
		return fmt.Errorf("diagnostics pack count is inconsistent or out of bounds")
	}
	if bundle.Configuration.ToolOverrideCount < 0 || bundle.Configuration.ToolOverrideCount > maxTools {
		return fmt.Errorf("diagnostics tool override count is out of bounds")
	}
	if len(bundle.Tools) > maxTools {
		return fmt.Errorf("diagnostics contains too many tools")
	}
	if bundle.Health.ToolsReady < 0 || bundle.Health.ToolsUnavailable < 0 ||
		bundle.Health.ToolsReady+bundle.Health.ToolsUnavailable != len(bundle.Tools) {
		return fmt.Errorf("diagnostics health counts are inconsistent")
	}

	var previousPack string
	for i, pack := range bundle.Packs {
		if err := validateToken("pack id", pack.ID, false); err != nil {
			return fmt.Errorf("pack %d: %w", i, err)
		}
		if err := validateToken("pack version", pack.Version, false); err != nil {
			return fmt.Errorf("pack %s: %w", pack.ID, err)
		}
		if i > 0 && previousPack >= pack.ID {
			return fmt.Errorf("diagnostics packs must be uniquely sorted by id")
		}
		previousPack = pack.ID
	}

	var previousTool string
	for i, tool := range bundle.Tools {
		if err := validateToken("tool pack id", tool.PackID, false); err != nil {
			return fmt.Errorf("tool %d: %w", i, err)
		}
		if err := validateToken("tool pack version", tool.PackVersion, false); err != nil {
			return fmt.Errorf("tool %s/%s: %w", tool.PackID, tool.ToolID, err)
		}
		if err := validateToken("tool id", tool.ToolID, false); err != nil {
			return fmt.Errorf("tool %d: %w", i, err)
		}
		if _, ok := allowedStatuses[tool.Status]; !ok {
			return fmt.Errorf("tool %s/%s has unsupported status %q", tool.PackID, tool.ToolID, tool.Status)
		}
		if err := validateToken("tool version", tool.Version, true); err != nil {
			return fmt.Errorf("tool %s/%s: %w", tool.PackID, tool.ToolID, err)
		}
		if tool.CandidateCount < 0 || tool.CandidateCount > maxCandidateCount {
			return fmt.Errorf("tool %s/%s candidate count is out of bounds", tool.PackID, tool.ToolID)
		}
		key := tool.PackID + "/" + tool.ToolID
		if i > 0 && previousTool >= key {
			return fmt.Errorf("diagnostics tools must be uniquely sorted by pack/tool")
		}
		previousTool = key
	}
	return nil
}

func validateToken(name, value string, optional bool) error {
	if value == "" {
		if optional {
			return nil
		}
		return fmt.Errorf("diagnostics %s is required", name)
	}
	if len(value) > 128 {
		return fmt.Errorf("diagnostics %s exceeds 128-byte limit", name)
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '.', r == '-', r == '_', r == '+':
		default:
			return fmt.Errorf("diagnostics %s contains unsupported character %q", name, r)
		}
	}
	return nil
}

func MarshalBundle(bundle Bundle) ([]byte, error) {
	if err := Validate(bundle); err != nil {
		return nil, err
	}
	payload, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode diagnostics bundle: %w", err)
	}
	payload = append(payload, '\n')
	if len(payload) > MaxSerializedBytes {
		return nil, fmt.Errorf("diagnostics bundle exceeds %d-byte serialized limit", MaxSerializedBytes)
	}
	return payload, nil
}

func WriteBundle(ctx context.Context, destination string, bundle Bundle) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if destination == "" {
		return "", fmt.Errorf("diagnostics export path is required")
	}
	if !filepath.IsAbs(destination) && containsParentTraversal(destination) {
		return "", fmt.Errorf("relative diagnostics export path may not contain parent traversal")
	}

	payload, err := MarshalBundle(bundle)
	if err != nil {
		return "", err
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(payload))
	if err := ctx.Err(); err != nil {
		return "", err
	}

	clean := filepath.Clean(destination)
	if info, err := os.Lstat(clean); err == nil {
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			return "", fmt.Errorf("diagnostics export path must not be a symlink")
		case !info.Mode().IsRegular():
			return "", fmt.Errorf("diagnostics export path must not be a directory or special file")
		default:
			return "", fmt.Errorf("diagnostics export path already exists")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("inspect diagnostics export path: %w", err)
	}

	parent := filepath.Dir(clean)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return "", fmt.Errorf("inspect diagnostics export directory: %w", err)
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("diagnostics export parent must not be a symlink")
	}
	if !parentInfo.IsDir() {
		return "", fmt.Errorf("diagnostics export parent is not a directory")
	}
	if err := validateExportParent(parent); err != nil {
		return "", err
	}

	temp, err := os.CreateTemp(parent, ".cliharbor-diagnostics-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create diagnostics staging file: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(privateFileMode); err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("protect diagnostics staging file: %w", err)
	}
	if _, err := io.Copy(temp, strings.NewReader(string(payload))); err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("write diagnostics staging file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("sync diagnostics staging file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return "", fmt.Errorf("close diagnostics staging file: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := activateDiagnosticsBundle(tempName, clean); err != nil {
		if _, statErr := os.Lstat(clean); statErr == nil {
			return "", fmt.Errorf("diagnostics export path already exists")
		}
		return "", fmt.Errorf("activate diagnostics bundle without overwrite: %w", err)
	}
	return digest, nil
}

func containsParentTraversal(value string) bool {
	normalized := strings.ReplaceAll(value, "\\", "/")
	for _, part := range strings.Split(normalized, "/") {
		if part == ".." {
			return true
		}
	}
	return false
}
