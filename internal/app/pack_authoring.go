package app

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
	"gopkg.in/yaml.v3"
)

type PackInitConfig struct {
	ID             string
	Name           string
	ToolID         string
	ExecutableName string
	Platforms      []string
	OutputPath     string
}

type packScaffoldDocument struct {
	APIVersion string                     `yaml:"apiVersion"`
	Kind       string                     `yaml:"kind"`
	Metadata   packScaffoldMetadata       `yaml:"metadata"`
	Runtime    packScaffoldRuntime        `yaml:"runtime"`
	Commands   map[string]packScaffoldCmd `yaml:"commands"`
}

type packScaffoldMetadata struct {
	ID          string `yaml:"id"`
	Name        string `yaml:"name"`
	Version     string `yaml:"version"`
	Description string `yaml:"description"`
}

type packScaffoldRuntime struct {
	Platforms []string                    `yaml:"platforms"`
	Tools     map[string]packScaffoldTool `yaml:"tools"`
}

type packScaffoldTool struct {
	ExecutableNames []string `yaml:"executableNames"`
}

type packScaffoldCmd struct{}

func InitPack(options Options, config PackInitConfig) error {
	if options.Out == nil {
		return fmt.Errorf("pack init output writer is required")
	}
	if config.OutputPath == "" {
		return fmt.Errorf("pack init output path is required")
	}
	extension := strings.ToLower(filepath.Ext(config.OutputPath))
	if extension != ".yaml" && extension != ".yml" {
		return fmt.Errorf("pack init output must use .yaml or .yml")
	}

	platforms, err := normalizePackPlatforms(config.Platforms)
	if err != nil {
		return err
	}

	document := packScaffoldDocument{
		APIVersion: packs.SupportedAPIVersion,
		Kind:       packs.PackKind,
		Metadata: packScaffoldMetadata{
			ID:          config.ID,
			Name:        config.Name,
			Version:     "0.1.0",
			Description: "Discovery-only scaffold. Add only reviewed, deterministic CLI workflows.",
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
		return fmt.Errorf("encode pack scaffold: %w", err)
	}
	if _, err := packs.Parse(data); err != nil {
		return fmt.Errorf("pack scaffold configuration is invalid: %w", err)
	}

	absolute, err := filepath.Abs(config.OutputPath)
	if err != nil {
		return fmt.Errorf("resolve pack scaffold output: %w", err)
	}
	parent := filepath.Dir(absolute)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return fmt.Errorf("inspect pack scaffold output directory %q: %w", filepath.Base(parent), err)
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() {
		return fmt.Errorf("pack scaffold output directory must be a real directory, not a symlink")
	}

	file, err := os.OpenFile(absolute, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return fmt.Errorf("pack scaffold output %q already exists", filepath.Base(absolute))
		}
		return fmt.Errorf("create pack scaffold %q: %w", filepath.Base(absolute), err)
	}
	keep := false
	defer func() {
		_ = file.Close()
		if !keep {
			_ = os.Remove(absolute)
		}
	}()

	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("write pack scaffold: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync pack scaffold: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close pack scaffold: %w", err)
	}
	keep = true

	_, err = fmt.Fprintf(
		options.Out,
		"Created discovery-only pack scaffold %s for %s/%s.\nNo command syntax was guessed or enabled. Add reviewed commands, then run 'cliharbor pack validate %s'.\n",
		filepath.Base(absolute),
		config.ID,
		config.ToolID,
		filepath.Base(absolute),
	)
	return err
}

func normalizePackPlatforms(values []string) ([]string, error) {
	if len(values) == 0 {
		return []string{"windows"}, nil
	}
	seen := make(map[string]struct{}, len(values))
	platforms := make([]string, 0, len(values))
	for _, value := range values {
		switch value {
		case "windows", "linux", "darwin":
		default:
			return nil, fmt.Errorf("unsupported pack platform %q; expected windows, linux, or darwin", value)
		}
		if _, exists := seen[value]; exists {
			return nil, fmt.Errorf("duplicate pack platform %q", value)
		}
		seen[value] = struct{}{}
		platforms = append(platforms, value)
	}
	sort.Strings(platforms)
	return platforms, nil
}

func ValidatePackPaths(options Options, paths []string) error {
	if options.Out == nil {
		return fmt.Errorf("pack validation output writer is required")
	}
	if len(paths) == 0 {
		return fmt.Errorf("at least one pack file or directory is required")
	}

	loader := packs.NewLoader()
	loaded := make([]packs.LoadedPack, 0, len(paths))
	for _, path := range paths {
		if path == "" {
			return fmt.Errorf("pack validation path cannot be empty")
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return fmt.Errorf("resolve pack validation path: %w", err)
		}
		info, err := os.Lstat(absolute)
		if err != nil {
			return fmt.Errorf("inspect pack validation path %q: %w", filepath.Base(absolute), err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("pack validation path %q must not be a symlink", filepath.Base(absolute))
		}

		var registry *packs.Registry
		if info.IsDir() {
			registry, err = loader.LoadDirectory(absolute)
		} else if info.Mode().IsRegular() {
			registry, err = loader.LoadFiles([]string{absolute})
		} else {
			return fmt.Errorf("pack validation path %q must be a regular YAML file or directory", filepath.Base(absolute))
		}
		if err != nil {
			return err
		}
		loaded = append(loaded, registry.Packs()...)
	}
	if len(loaded) == 0 {
		return fmt.Errorf("no pack YAML files found")
	}

	registry, err := packs.NewRegistry(loaded)
	if err != nil {
		return fmt.Errorf("combine validated packs: %w", err)
	}

	packList := registry.Packs()
	if _, err := fmt.Fprintf(options.Out, "Validated %d pack(s); no executable, version probe, help probe, or task was run.\n", len(packList)); err != nil {
		return err
	}
	for _, loadedPack := range packList {
		pack := loadedPack.Pack
		if _, err := fmt.Fprintf(
			options.Out,
			"- %s %s (%s): %d tool(s), %d command(s), source %s\n",
			pack.Metadata.ID,
			pack.Metadata.Version,
			pack.Metadata.Name,
			len(pack.Runtime.Tools),
			len(pack.Commands),
			filepath.Base(loadedPack.Source.Name),
		); err != nil {
			return err
		}
	}
	return nil
}
