package app

import (
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

type packCompatibilityRow struct {
	source            string
	packID            string
	toolID            string
	platform          string
	versionConstraint string
	managedVersion    string
	managedArtifacts  []string
}

// ReportPackCompatibility renders only declared, validated pack metadata. It
// does not inspect the current host, discover executables, execute probes,
// download artifacts, or read vendor authentication/session state.
func ReportPackCompatibility(options Options, paths []string) error {
	if options.Out == nil {
		return fmt.Errorf("pack compatibility output writer is required")
	}

	registry, err := loadPackAuthoringRegistry(paths)
	if err != nil {
		return err
	}
	rows := collectPackCompatibilityRows(registry)

	if _, err := fmt.Fprintln(
		options.Out,
		"SOURCE\tPACK\tTOOL\tPLATFORM\tVERSION_CONSTRAINT\tMANAGED_VERSION\tMANAGED_ARTIFACTS",
	); err != nil {
		return err
	}
	for _, row := range rows {
		constraint := "<none>"
		if row.versionConstraint != "" {
			constraint = strconv.Quote(row.versionConstraint)
		}
		managedVersion := "<none>"
		if row.managedVersion != "" {
			managedVersion = row.managedVersion
		}
		artifacts := "none"
		if len(row.managedArtifacts) != 0 {
			artifacts = strings.Join(row.managedArtifacts, ",")
		}
		if _, err := fmt.Fprintf(
			options.Out,
			"%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			filepath.Base(row.source),
			row.packID,
			row.toolID,
			row.platform,
			constraint,
			managedVersion,
			artifacts,
		); err != nil {
			return err
		}
	}

	if _, err := fmt.Fprintf(
		options.Out,
		"Reported %d declared compatibility row(s) from %d pack(s). Static pack metadata only; no executable, discovery, probe, task, network, install, or authentication/session state was accessed.\n",
		len(rows),
		len(registry.Packs()),
	); err != nil {
		return err
	}
	_, err = fmt.Fprintln(
		options.Out,
		"Runtime qualification remains separate. A row with managed artifacts 'none' does not imply CPU-architecture support; it means the pack declares no CLIHarbor-managed artifact for that platform.",
	)
	return err
}

func collectPackCompatibilityRows(registry *packs.Registry) []packCompatibilityRow {
	if registry == nil {
		return nil
	}
	rows := make([]packCompatibilityRow, 0)
	for _, loaded := range registry.Packs() {
		pack := loaded.Pack
		platforms := append([]string(nil), pack.Runtime.Platforms...)
		sort.Strings(platforms)
		for _, namedTool := range registry.Tools(pack.Metadata.ID) {
			for _, platform := range platforms {
				row := packCompatibilityRow{
					source:            loaded.Source.Name,
					packID:            pack.Metadata.ID,
					toolID:            namedTool.ID,
					platform:          platform,
					versionConstraint: namedTool.Tool.VersionConstraint,
				}
				if namedTool.Tool.Install != nil {
					row.managedVersion = namedTool.Tool.Install.Version
					prefix := platform + "-"
					for key := range namedTool.Tool.Install.Artifacts {
						if strings.HasPrefix(key, prefix) {
							row.managedArtifacts = append(row.managedArtifacts, key)
						}
					}
					sort.Strings(row.managedArtifacts)
				}
				rows = append(rows, row)
			}
		}
	}
	return rows
}
