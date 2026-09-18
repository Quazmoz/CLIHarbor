package app

import (
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/evidence"
)

const evidencePreviewBytes = 240

// InspectEvidence validates an exported Phase 0 evidence file and renders a
// deterministic operator-side review. The artifact remains inert data: review
// never loads a pack, discovers an executable, plans a command, or starts a
// process.
func InspectEvidence(options Options, path string) error {
	if options.Out == nil {
		return fmt.Errorf("evidence review output writer is required")
	}
	bundle, err := evidence.ReadBundle(path)
	if err != nil {
		return err
	}
	return printEvidenceReview(options.Out, bundle)
}

func printEvidenceReview(out io.Writer, bundle evidence.Bundle) error {
	if _, err := fmt.Fprintf(out,
		"CLIHarbor Phase 0 evidence review\nSchema: %s\nGenerated: %s\nArtifact: version=%s commit=%s build=%s\nHost: %s",
		bundle.SchemaVersion, bundle.GeneratedAt.Format("2006-01-02T15:04:05.999999999Z07:00"),
		bundle.CLIHarbor.Version, bundle.CLIHarbor.Commit, bundle.CLIHarbor.BuildMode, bundle.Host.OS,
	); err != nil {
		return err
	}
	if bundle.Host.OSVersion != "" {
		if _, err := fmt.Fprintf(out, " %s", bundle.Host.OSVersion); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(out, "/%s\nTools: %d\n", bundle.Host.Architecture, len(bundle.Tools)); err != nil {
		return err
	}

	gaps := evidenceGaps(bundle)
	for _, tool := range bundle.Tools {
		if _, err := fmt.Fprintf(out, "\n%s/%s: %s\n  pack version: %s\n  candidates: %d\n",
			tool.PackID, tool.ToolID, tool.Status, tool.PackVersion, tool.CandidateCount); err != nil {
			return err
		}
		if tool.Version != "" {
			if _, err := fmt.Fprintf(out, "  version: %s\n", tool.Version); err != nil {
				return err
			}
		} else if _, err := fmt.Fprintln(out, "  version: not evidenced"); err != nil {
			return err
		}
		if tool.VersionConstraint != "" {
			if _, err := fmt.Fprintf(out, "  trusted constraint: %s\n", tool.VersionConstraint); err != nil {
				return err
			}
		}
		if len(tool.AvailableHelpProbes) > 0 {
			if _, err := fmt.Fprintf(out, "  declared help probes: %s\n", strings.Join(tool.AvailableHelpProbes, ", ")); err != nil {
				return err
			}
		} else if _, err := fmt.Fprintln(out, "  declared help probes: none"); err != nil {
			return err
		}
		if tool.Diagnostic != "" {
			if _, err := fmt.Fprintf(out, "  diagnostic: %s\n", strconv.Quote(tool.Diagnostic)); err != nil {
				return err
			}
		}
		for _, probe := range tool.Probes {
			if _, err := fmt.Fprintf(out, "  probe %s [%s]: %s\n", probe.Identity, probe.Kind, probe.Status); err != nil {
				return err
			}
			if _, err := fmt.Fprintf(out, "    fixed argv: %s\n", quotedArguments(probe.Arguments)); err != nil {
				return err
			}
			if probe.ExitCode != nil {
				if _, err := fmt.Fprintf(out, "    exit=%d timeout=%t cancelled=%t truncated=%t\n",
					*probe.ExitCode, probe.TimedOut, probe.Cancelled, probe.Truncated); err != nil {
					return err
				}
			}
			if probe.Stdout != "" {
				if _, err := fmt.Fprintf(out, "    stdout: bytes=%d preview=%s\n", len(probe.Stdout), quotedPreview(probe.Stdout)); err != nil {
					return err
				}
			}
			if probe.Stderr != "" {
				if _, err := fmt.Fprintf(out, "    stderr: bytes=%d preview=%s\n", len(probe.Stderr), quotedPreview(probe.Stderr)); err != nil {
					return err
				}
			}
			if probe.Diagnostic != "" {
				if _, err := fmt.Fprintf(out, "    diagnostic: %s\n", strconv.Quote(probe.Diagnostic)); err != nil {
					return err
				}
			}
		}
	}

	if _, err := fmt.Fprintln(out, "\nEVIDENCE GAPS:"); err != nil {
		return err
	}
	if len(gaps) == 0 {
		if _, err := fmt.Fprintln(out, "- none within the Phase 0 evidence contract"); err != nil {
			return err
		}
	} else {
		for _, gap := range gaps {
			if _, err := fmt.Fprintf(out, "- %s\n", gap); err != nil {
				return err
			}
		}
	}
	_, err := fmt.Fprint(out, "\nPROVES:\n- the file satisfies the strict cliharbor.phase0/v1 structural, bounds, internal-consistency, provenance-shape, and sanitization contract\n- tool/probe identities, state combinations, timestamps, and declared probe relationships are internally consistent\n- captured strings passed the evidence bounds and sanitization checks\n\nUNKNOWN:\n- whether the file is authentic or unmodified since export; schema validation is not a signature or attestation\n- whether the reported build, host, and observations genuinely came from the claimed environment\n- whether the evidence is still current after its generated timestamp\n- vendor authentication/session semantics, undocumented command behavior, and output contracts not directly captured here\n- any executable path, candidate path, environment, credential, or backend authority intentionally excluded from the schema\n\nBLOCKED:\n- evidence text never becomes executable pack or argv authority automatically\n- real vendor workflow promotion requires factual human review against the deployed CLI and/or approved documentation\n- auth-required, credential-sensitive, mutating, destructive, and interactive workflows remain outside this Phase 0 review\n")
	return err
}

func evidenceGaps(bundle evidence.Bundle) []string {
	var gaps []string
	if len(bundle.Tools) == 0 {
		return []string{"no configured tool evidence is present"}
	}
	for _, tool := range bundle.Tools {
		ref := tool.PackID + "/" + tool.ToolID
		if tool.Status != "ready" {
			gaps = append(gaps, fmt.Sprintf("%s is %s rather than ready", ref, tool.Status))
		}
		if tool.Version == "" {
			gaps = append(gaps, ref+" has no parsed semantic-version evidence")
		}
		if len(tool.AvailableHelpProbes) == 0 {
			gaps = append(gaps, ref+" has no trusted help probe declarations")
		}
		captured := make(map[string]string, len(tool.Probes))
		for _, probe := range tool.Probes {
			captured[probe.ID] = probe.Status
			if probe.Status != "exited" {
				gaps = append(gaps, fmt.Sprintf("%s probe %s did not complete successfully (%s)", ref, probe.ID, probe.Status))
			}
		}
		for _, id := range tool.AvailableHelpProbes {
			if _, ok := captured[id]; !ok {
				gaps = append(gaps, fmt.Sprintf("%s declared help probe %s was not captured", ref, id))
			}
		}
		if tool.VersionProbeConfigured {
			if _, ok := captured["version"]; !ok {
				gaps = append(gaps, ref+" configured version probe was not captured as explicit probe evidence")
			}
		}
	}
	sort.Strings(gaps)
	return gaps
}

func quotedArguments(arguments []string) string {
	if len(arguments) == 0 {
		return "[]"
	}
	quoted := make([]string, len(arguments))
	for i, argument := range arguments {
		quoted[i] = strconv.Quote(argument)
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

func quotedPreview(value string) string {
	if len(value) <= evidencePreviewBytes {
		return strconv.Quote(value)
	}
	cut := evidencePreviewBytes
	for cut > 0 && (value[cut]&0xC0) == 0x80 {
		cut--
	}
	return strconv.Quote(value[:cut] + "…")
}
