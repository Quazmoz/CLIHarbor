package packs

import (
	"encoding/json"
	"fmt"
	"strings"

	semver "github.com/Masterminds/semver/v3"
)

// UnmarshalJSON keeps discovery-related tool invariants inside the pack boundary.
// Structural validation still comes from pack.v1.schema.json before this method runs.
func (t *Tool) UnmarshalJSON(data []byte) error {
	type toolAlias Tool
	var decoded toolAlias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}

	if decoded.VersionConstraint != "" {
		if _, err := semver.NewConstraint(decoded.VersionConstraint); err != nil {
			return fmt.Errorf("invalid versionConstraint: %w", err)
		}
		if decoded.VersionProbe == nil {
			return fmt.Errorf("versionConstraint requires versionProbe")
		}
	}
	if decoded.VersionProbe != nil {
		if decoded.VersionProbe.Parser != VersionParserSemverText {
			return fmt.Errorf("unsupported versionProbe parser %q", decoded.VersionProbe.Parser)
		}
		for _, arg := range decoded.VersionProbe.Args {
			if strings.ContainsRune(arg, '\x00') {
				return fmt.Errorf("versionProbe args cannot contain NUL")
			}
		}
	}
	for id, probe := range decoded.HelpProbes {
		if id == "version" {
			return fmt.Errorf("helpProbe id %q is reserved", id)
		}
		for _, arg := range probe.Args {
			if strings.ContainsRune(arg, '\x00') {
				return fmt.Errorf("helpProbe %q args cannot contain NUL", id)
			}
		}
	}

	*t = Tool(decoded)
	return nil
}
