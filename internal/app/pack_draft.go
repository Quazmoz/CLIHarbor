package app

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"gopkg.in/yaml.v3"
)

const (
	maxDraftHelpBytes    = 1 << 20
	maxDraftSubcommands  = 128
	maxDraftSummaryRunes = 240
)

var (
	draftSubcommandPattern = regexp.MustCompile("^[a-z][a-z0-9-]{0,62}$")
	draftSummarySeparator  = regexp.MustCompile("(?: {2,}|\\t+)")
	// Matches "Commands:", "CORE COMMANDS", "Basic Commands (Beginner):", etc.
	draftCommandsHeader = regexp.MustCompile(`^(?:[a-z][a-z -]* )?(?:sub)?commands(?: \([^)]*\))?:?$`)
	// ANSI CSI sequences (colour, bold), raw or with ESC already replaced by
	// U+FFFD as capture-help's sanitizer does.
	draftANSISequence = regexp.MustCompile(`(?:\x1b|\x{FFFD})\[[0-9;?]*[ -/]*[@-~]`)
)

type draftSubcommandCandidate struct {
	Name    string
	Summary string
}

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

// DraftPack extracts candidate command names and bounded summaries from captured
// help text, but never turns those untrusted hints into executable pack commands.
// Candidates are emitted only as YAML comments beside a valid discovery-only
// scaffold. A human
// must add reviewed command definitions before the pack can execute anything.
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
	if err := rejectReservedNewPackID(config.ID); err != nil {
		return err
	}

	helpText, err := readDraftHelpFile(config.HelpPath)
	if err != nil {
		return err
	}
	candidates := parseSubcommandCandidates(helpText)
	if len(candidates) == 0 {
		return fmt.Errorf("pack draft found no candidate subcommands in %s; capture the vendor's command listing with its --help output, or use 'cliharbor pack init' for a CLI without subcommands", filepath.Base(config.HelpPath))
	}
	if len(candidates) > maxDraftSubcommands {
		return fmt.Errorf("pack draft detected %d subcommands, exceeding the %d-command limit; draft focused packs from narrower help output", len(candidates), maxDraftSubcommands)
	}

	document := packScaffoldDocument{
		APIVersion: packs.SupportedAPIVersion,
		Kind:       packs.PackKind,
		Metadata: packScaffoldMetadata{
			ID:          config.ID,
			Name:        config.Name,
			Version:     "0.1.0",
			Description: "Discovery-only draft generated from captured help output. Candidate command names and summaries are comments only and grant no runtime authority.",
		},
		Runtime: packScaffoldRuntime{
			Platforms: platforms,
			Tools: map[string]packScaffoldTool{
				config.ToolID: {ExecutableNames: []string{config.ExecutableName}},
			},
		},
		Commands: map[string]packScaffoldCmd{},
	}

	data, err := yaml.Marshal(document)
	if err != nil {
		return fmt.Errorf("encode pack draft: %w", err)
	}
	data = append(data, []byte("\n# Candidate subcommands parsed from captured help.\n")...)
	data = append(data, []byte("# These comments are non-authoritative and are never executable.\n")...)
	data = append(data, []byte("# Review vendor documentation, then add only deterministic commands with the correct risk, inputs, argv, and output contract.\n")...)
	for _, candidate := range candidates {
		line := "# - " + candidate.Name
		if candidate.Summary != "" {
			line += " — " + candidate.Summary
		}
		data = append(data, []byte(line+"\n")...)
	}

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
		"Generated discovery-only draft pack %s with %d candidate subcommand(s) for %s/%s from captured help output.\nNo executable, help probe, version probe, or runnable command was generated. Review vendor documentation before adding command authority.\n",
		filepath.Base(absolute),
		len(candidates),
		config.ID,
		config.ToolID,
	)
	return err
}

func readDraftHelpFile(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve pack draft help file: %w", err)
	}
	before, err := os.Lstat(absolute)
	if err != nil {
		return "", fmt.Errorf("inspect pack draft help file %q: %w", filepath.Base(absolute), err)
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() {
		return "", fmt.Errorf("pack draft help file %q must be a regular file, not a symlink", filepath.Base(absolute))
	}
	if before.Size() < 0 || before.Size() > maxDraftHelpBytes {
		return "", fmt.Errorf("pack draft help file %q exceeds the %d-byte limit", filepath.Base(absolute), maxDraftHelpBytes)
	}

	file, err := os.Open(absolute)
	if err != nil {
		return "", fmt.Errorf("open pack draft help file %q: %w", filepath.Base(absolute), err)
	}
	defer file.Close()

	opened, err := file.Stat()
	if err != nil {
		return "", fmt.Errorf("inspect opened pack draft help file %q: %w", filepath.Base(absolute), err)
	}
	if !opened.Mode().IsRegular() || !os.SameFile(before, opened) {
		return "", fmt.Errorf("pack draft help file %q changed while opening", filepath.Base(absolute))
	}
	if opened.Size() < 0 || opened.Size() > maxDraftHelpBytes {
		return "", fmt.Errorf("pack draft help file %q exceeds the %d-byte limit", filepath.Base(absolute), maxDraftHelpBytes)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxDraftHelpBytes+1))
	if err != nil {
		return "", fmt.Errorf("read pack draft help file %q: %w", filepath.Base(absolute), err)
	}
	if len(data) > maxDraftHelpBytes {
		return "", fmt.Errorf("pack draft help file %q exceeds the %d-byte limit", filepath.Base(absolute), maxDraftHelpBytes)
	}
	after, err := file.Stat()
	if err != nil {
		return "", fmt.Errorf("reinspect pack draft help file %q: %w", filepath.Base(absolute), err)
	}
	if !os.SameFile(opened, after) || after.Size() != int64(len(data)) || !opened.ModTime().Equal(after.ModTime()) {
		return "", fmt.Errorf("pack draft help file %q changed while reading", filepath.Base(absolute))
	}
	if !utf8.Valid(data) {
		return "", fmt.Errorf("pack draft help file %q must be valid UTF-8", filepath.Base(absolute))
	}
	return string(data), nil
}

// parseSubcommandCandidates extracts bounded authoring hints from captured help
// text. Captured vendor output is untrusted: names and summaries are comments
// only and never become executable commands without an explicit human-authored
// pack edit.
func parseSubcommandCandidates(helpText string) []draftSubcommandCandidate {
	helpText = draftANSISequence.ReplaceAllString(strings.TrimPrefix(helpText, "\ufeff"), "")
	summaries := make(map[string]string)
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
		name := strings.TrimSuffix(strings.SplitN(fields[0], ",", 2)[0], ":")
		if !draftSubcommandPattern.MatchString(name) {
			continue
		}
		summary := parseDraftSummary(trimmed)
		previous, exists := summaries[name]
		if !exists || (previous == "" && summary != "") {
			summaries[name] = summary
		}
	}

	names := make([]string, 0, len(summaries))
	for name := range summaries {
		names = append(names, name)
	}
	sort.Strings(names)

	candidates := make([]draftSubcommandCandidate, 0, len(names))
	for _, name := range names {
		candidates = append(candidates, draftSubcommandCandidate{Name: name, Summary: summaries[name]})
	}
	return candidates
}

// parseSubcommands remains the name-only view used by earlier authoring tests
// and callers. Richer summaries stay inert draft metadata.
func parseSubcommands(helpText string) []string {
	candidates := parseSubcommandCandidates(helpText)
	names := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		names = append(names, candidate.Name)
	}
	return names
}

func parseDraftSummary(trimmed string) string {
	separator := draftSummarySeparator.FindStringIndex(trimmed)
	if separator == nil {
		return ""
	}
	summary := strings.TrimSpace(trimmed[separator[1]:])
	if summary == "" || utf8.RuneCountInString(summary) > maxDraftSummaryRunes || containsTerminalControl(summary) {
		return ""
	}
	return summary
}

func isCommandsHeader(trimmed string) bool {
	return draftCommandsHeader.MatchString(strings.ToLower(trimmed))
}
