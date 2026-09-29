package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

const (
	maxDraftHelpBytes      = 1 << 20
	maxDraftSubcommands    = 128
	draftPositionalInputID = "args"
)

var draftSubcommandPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

// PackDraftConfig describes a reviewable, discovery-only draft synthesized from
// captured vendor help output. Drafting never executes an executable, help
// probe, or version probe; it only reads previously captured text.
type PackDraftConfig struct {
	ID             string
	Name           string
	ToolID         string
	ExecutableName string
	Platforms      []string
	HelpPath       string
	OutputPath     string
}

// DraftPack turns a captured "--help" command listing into an unreviewed draft
// pack. Each detected subcommand becomes a read-classified command whose single
// optional positional argument maps to a leading-dash-rejecting string input.
// The result is validated with packs.Parse so an author never receives a draft
// that cannot load, but every command still requires human review before use.
func DraftPack(options Options, config PackDraftConfig) error {
	if options.Out == nil {
		return fmt.Errorf("pack draft output writer is required")
	}
	if config.HelpPath == "" {
		return fmt.Errorf("pack draft help file path is required")
	}
	if config.OutputPath == "" {
		return fmt.Errorf("pack draft output path is required")
	}
	extension := strings.ToLower(filepath.Ext(config.OutputPath))
	if extension != ".yaml" && extension != ".yml" {
		return fmt.Errorf("pack draft output must use .yaml or .yml")
	}

	platforms, err := normalizePackPlatforms(config.Platforms)
	if err != nil {
		return err
	}

	helpText, err := readDraftHelpFile(config.HelpPath)
	if err != nil {
		return err
	}
	subcommands := parseSubcommands(helpText)
	if len(subcommands) == 0 {
		return fmt.Errorf("pack draft found no reviewable subcommands in %s; capture the vendor's command listing with its --help output", filepath.Base(config.HelpPath))
	}
	if len(subcommands) > maxDraftSubcommands {
		return fmt.Errorf("pack draft detected %d subcommands, exceeding the %d-command limit; draft focused packs from narrower help output", len(subcommands), maxDraftSubcommands)
	}

	pack := packs.Pack{
		APIVersion: packs.SupportedAPIVersion,
		Kind:       packs.PackKind,
		Metadata: packs.Metadata{
			ID:          config.ID,
			Name:        config.Name,
			Version:     "0.1.0",
			Description: "Draft pack generated from captured help output. Every command is unreviewed; confirm risk, inputs, and argv against authoritative vendor documentation before enabling.",
		},
		Runtime: packs.Runtime{
			Platforms: platforms,
			Tools: map[string]packs.Tool{
				config.ToolID: {ExecutableNames: []string{config.ExecutableName}},
			},
		},
		Commands: make(map[string]packs.Command, len(subcommands)),
	}
	for _, subcommand := range subcommands {
		pack.Commands[subcommand] = draftCommand(config.ToolID, subcommand)
	}

	data, err := json.MarshalIndent(pack, "", "  ")
	if err != nil {
		return fmt.Errorf("encode pack draft: %w", err)
	}
	data = append(data, '\n')
	if _, err := packs.Parse(data); err != nil {
		return fmt.Errorf("pack draft configuration is invalid: %w", err)
	}

	absolute, err := filepath.Abs(config.OutputPath)
	if err != nil {
		return fmt.Errorf("resolve pack draft output: %w", err)
	}
	parent := filepath.Dir(absolute)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return fmt.Errorf("inspect pack draft output directory %q: %w", filepath.Base(parent), err)
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() {
		return fmt.Errorf("pack draft output directory must be a real directory, not a symlink")
	}

	file, err := os.OpenFile(absolute, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return fmt.Errorf("pack draft output %q already exists", filepath.Base(absolute))
		}
		return fmt.Errorf("create pack draft %q: %w", filepath.Base(absolute), err)
	}
	keep := false
	defer func() {
		_ = file.Close()
		if !keep {
			_ = os.Remove(absolute)
		}
	}()

	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("write pack draft: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync pack draft: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close pack draft: %w", err)
	}
	keep = true

	_, err = fmt.Fprintf(
		options.Out,
		"Generated draft pack %s with %d unreviewed command(s) for %s/%s from captured help output.\nNo executable, help probe, or version probe was run. Review every command's risk, inputs, and argv before enabling.\n",
		filepath.Base(absolute),
		len(subcommands),
		config.ID,
		config.ToolID,
	)
	return err
}

func draftCommand(toolID, subcommand string) packs.Command {
	return packs.Command{
		Name:        "Draft: " + subcommand,
		Description: "Unreviewed draft derived from captured help output. Confirm the risk classification, inputs, argv, and output handling before enabling this command.",
		Tool:        toolID,
		Risk:        packs.RiskRead,
		Inputs: []packs.Input{
			{
				ID:         draftPositionalInputID,
				Type:       packs.InputString,
				Label:      "Additional arguments",
				Required:   false,
				Validation: packs.InputValidation{DisallowLeadingDash: true},
			},
		},
		Argv: []packs.Argument{
			{Literal: subcommand},
			{Positional: &packs.PositionalArgument{ValueFrom: draftPositionalInputID, OmitWhenEmpty: true}},
		},
		Output: packs.Output{Mode: packs.OutputRaw},
	}
}

func readDraftHelpFile(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve pack draft help file: %w", err)
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return "", fmt.Errorf("inspect pack draft help file %q: %w", filepath.Base(absolute), err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", fmt.Errorf("pack draft help file %q must be a regular file, not a symlink", filepath.Base(absolute))
	}
	if info.Size() > maxDraftHelpBytes {
		return "", fmt.Errorf("pack draft help file %q exceeds the %d-byte limit", filepath.Base(absolute), maxDraftHelpBytes)
	}
	data, err := os.ReadFile(absolute)
	if err != nil {
		return "", fmt.Errorf("read pack draft help file %q: %w", filepath.Base(absolute), err)
	}
	if int64(len(data)) > maxDraftHelpBytes {
		return "", fmt.Errorf("pack draft help file %q exceeds the %d-byte limit", filepath.Base(absolute), maxDraftHelpBytes)
	}
	if !utf8.Valid(data) {
		return "", fmt.Errorf("pack draft help file %q must be valid UTF-8", filepath.Base(absolute))
	}
	return string(data), nil
}

// parseSubcommands extracts safe subcommand identifiers from captured help text.
// It only reads indented entries inside a recognized commands section, keeps the
// first whitespace- or comma-delimited token, and accepts a token only when it
// matches the pack id grammar. Flags, uppercase noise, and prose are ignored so
// the draft never invents an executable-facing name from unreviewed text.
func parseSubcommands(helpText string) []string {
	seen := make(map[string]struct{})
	ordered := make([]string, 0)
	inSection := false
	for _, rawLine := range strings.Split(helpText, "\n") {
		line := strings.TrimRight(rawLine, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			inSection = false
			continue
		}
		if isCommandsHeader(trimmed) {
			inSection = true
			continue
		}
		indented := line != strings.TrimLeft(line, " \t")
		if !indented {
			inSection = false
			continue
		}
		if !inSection {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) == 0 {
			continue
		}
		candidate := strings.SplitN(fields[0], ",", 2)[0]
		if !draftSubcommandPattern.MatchString(candidate) {
			continue
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		ordered = append(ordered, candidate)
	}
	sort.Strings(ordered)
	return ordered
}

func isCommandsHeader(trimmed string) bool {
	if !strings.HasSuffix(trimmed, ":") {
		switch strings.ToLower(trimmed) {
		case "commands", "subcommands":
			return true
		default:
			return false
		}
	}
	lower := strings.TrimSpace(strings.ToLower(strings.TrimSuffix(trimmed, ":")))
	if lower == "commands" || lower == "subcommands" {
		return true
	}
	return strings.HasSuffix(lower, " commands")
}
