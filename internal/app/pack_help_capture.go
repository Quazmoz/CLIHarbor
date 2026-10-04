package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

// PackHelpCaptureConfig identifies one trusted, pack-declared help probe whose
// sanitized output should be written as an authoring artifact.
type PackHelpCaptureConfig struct {
	ToolSelector string
	ProbeID      string
	OutputPath   string
}

// CapturePackHelp executes exactly one fixed help probe already declared by an
// explicitly trusted pack. It does not accept arbitrary argv, grant command
// authority, auto-provision tools, or make the capture trusted runtime input.
func CapturePackHelp(ctx context.Context, options Options, config PackHelpCaptureConfig) error {
	if options.Out == nil {
		return fmt.Errorf("pack help capture output writer is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if config.OutputPath == "" {
		return fmt.Errorf("pack help capture output path is required")
	}
	if config.ProbeID == "" {
		return fmt.Errorf("pack help capture probe id is required")
	}

	ref, err := parseCaptureToolSelector(config.ToolSelector)
	if err != nil {
		return err
	}
	state, err := prepareRuntime(ctx, options)
	if err != nil {
		return err
	}
	tool, ok := state.Registry.FindTool(ref.PackID, ref.ToolID)
	if !ok {
		return fmt.Errorf("pack help capture tool %q is not present in the explicitly trusted pack set", config.ToolSelector)
	}
	if _, ok := tool.HelpProbes[config.ProbeID]; !ok {
		return fmt.Errorf("pack help capture probe %q is not declared for %s", config.ProbeID, config.ToolSelector)
	}
	toolState, ok := state.Discovery.Find(ref)
	if !ok {
		return fmt.Errorf("pack help capture discovery state is unavailable for %s", config.ToolSelector)
	}

	selector := probeSelector{
		raw:     ref.String() + "/" + config.ProbeID,
		packID:  ref.PackID,
		toolID:  ref.ToolID,
		probeID: config.ProbeID,
	}
	record, err := runInventoryProbe(ctx, toolState, tool, selector)
	if err != nil {
		return err
	}
	if record.Status != "exited" || record.ExitCode == nil || *record.ExitCode != 0 || record.Truncated {
		return fmt.Errorf(
			"pack help capture probe %s/%s did not complete cleanly (status=%s, truncated=%t)",
			config.ToolSelector,
			config.ProbeID,
			record.Status,
			record.Truncated,
		)
	}

	captured := record.Stdout
	if record.Stderr != "" {
		if captured != "" && !strings.HasSuffix(captured, "\n") {
			captured += "\n"
		}
		captured += record.Stderr
	}
	if strings.TrimSpace(captured) == "" {
		return fmt.Errorf("pack help capture probe %s/%s produced no usable output", config.ToolSelector, config.ProbeID)
	}
	if err := writePackHelpCapture(config.OutputPath, []byte(captured)); err != nil {
		return err
	}

	_, err = fmt.Fprintf(
		options.Out,
		"Captured sanitized help from trusted probe %s/%s to %s.\nThe capture is authoring evidence only; it grants no executable, command, argv, or pack authority.\n",
		config.ToolSelector,
		config.ProbeID,
		filepath.Base(config.OutputPath),
	)
	return err
}

func parseCaptureToolSelector(raw string) (discovery.ToolRef, error) {
	parts := strings.Split(raw, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return discovery.ToolRef{}, fmt.Errorf("invalid pack help capture tool %q; expected pack/tool", raw)
	}
	return discovery.ToolRef{PackID: parts[0], ToolID: parts[1]}, nil
}

func writePackHelpCapture(path string, data []byte) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve pack help capture output: %w", err)
	}
	parent := filepath.Dir(absolute)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return fmt.Errorf("inspect pack help capture output directory %q: %w", filepath.Base(parent), err)
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() {
		return fmt.Errorf("pack help capture output directory must be a real directory, not a symlink")
	}

	file, err := os.OpenFile(absolute, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return fmt.Errorf("pack help capture output %q already exists", filepath.Base(absolute))
		}
		return fmt.Errorf("create pack help capture %q: %w", filepath.Base(absolute), err)
	}
	keep := false
	defer func() {
		_ = file.Close()
		if !keep {
			_ = os.Remove(absolute)
		}
	}()

	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("write pack help capture: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync pack help capture: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close pack help capture: %w", err)
	}
	keep = true
	return nil
}
