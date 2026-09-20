package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	evalbundle "github.com/Quazmoz/CLIHarbor/internal/evaluation"
)

var errEvaluationPreflightBlocked = errors.New("evaluation preflight blocked")

type EvaluationPreflightConfig struct {
	BundleRoot string
}

type evaluationPreflightDependencies struct {
	executablePath func() (string, error)
	goos           string
	goarch         string
	temporary      func(context.Context) error
	loopback       func(context.Context) error
	process        func(context.Context) error
}

func EvaluationPreflight(ctx context.Context, options Options, config EvaluationPreflightConfig) error {
	return evaluationPreflight(ctx, options, config, evaluationPreflightDependencies{
		executablePath: os.Executable,
		goos:           runtime.GOOS,
		goarch:         runtime.GOARCH,
		temporary:      selfTestTemporaryDirectory,
		loopback: func(ctx context.Context) error {
			return selfTestLoopback(ctx, normalizeBuildInfo(options).Version)
		},
		process: selfTestProcessExecution,
	})
}

func evaluationPreflight(
	ctx context.Context,
	options Options,
	config EvaluationPreflightConfig,
	deps evaluationPreflightDependencies,
) error {
	if options.Out == nil {
		return fmt.Errorf("evaluation preflight output writer is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	build := normalizeBuildInfo(options)
	if _, err := fmt.Fprintf(options.Out,
		"CLIHarbor evaluation preflight\nversion: %s\ncommit: %s\nbuild: %s\nplatform: %s/%s\n",
		build.Version, build.Commit, build.BuildMode, deps.goos, deps.goarch,
	); err != nil {
		return err
	}

	if err := validateEvaluationBuildIdentity(build.Version, build.Commit, build.BuildMode, deps.goos, deps.goarch); err != nil {
		return preflightBlocked(options.Out, "build identity", "this executable is not the qualified Windows x64 evaluation build", "use the exact Windows evaluation artifact uploaded by CI for this commit")
	}
	if err := preflightPass(options.Out, "build identity"); err != nil {
		return err
	}

	executable, err := deps.executablePath()
	if err != nil {
		return preflightBlocked(options.Out, "running executable identity", "CLIHarbor could not resolve its own executable", "run the executable directly from the extracted evaluation bundle")
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return preflightBlocked(options.Out, "running executable identity", "CLIHarbor could not normalize its executable location", "run the executable directly from the extracted evaluation bundle")
	}
	root, err := resolveEvaluationBundleRoot(config.BundleRoot, executable)
	if err != nil {
		return preflightBlocked(options.Out, "evaluation bundle location", "the extracted evaluation bundle could not be resolved", "extract the artifact completely and pass --bundle to the extracted artifact directory if needed")
	}

	if err := evalbundle.VerifyExtractedLayout(root); err != nil {
		return preflightBlocked(options.Out, "extracted bundle layout", "the extracted artifact layout is missing, altered, or contains unexpected entries", "re-extract the qualified artifact into a new empty directory without adding files")
	}
	if err := preflightPass(options.Out, "extracted bundle layout"); err != nil {
		return err
	}

	if err := evalbundle.VerifyIntegrity(root); err != nil {
		return preflightBlocked(options.Out, "authoritative bundle integrity", "EVALUATION_SHA256SUMS or a covered privileged file did not match the qualified bundle contract", "obtain and extract the qualified artifact again; do not replace the manifest, executable, or Phase 0 pack")
	}
	if err := preflightPass(options.Out, "authoritative bundle integrity"); err != nil {
		return err
	}

	if err := evalbundle.VerifyPhase0Pack(root); err != nil {
		return preflightBlocked(options.Out, "Phase 0 pack authority", "the packaged Phase 0 pack is not the expected discovery-only authority", "use the unmodified Phase 0 pack from the same qualified artifact")
	}
	if err := preflightPass(options.Out, "Phase 0 pack authority"); err != nil {
		return err
	}

	if err := verifyRunningEvaluationExecutable(root, executable); err != nil {
		return preflightBlocked(options.Out, "running executable identity", "the running executable is not the executable covered by this bundle", "invoke bin\\cliharbor-windows-x64-evaluation.exe from this extracted artifact")
	}
	if err := preflightPass(options.Out, "running executable identity"); err != nil {
		return err
	}

	for _, check := range []struct {
		name        string
		run         func(context.Context) error
		remediation string
	}{
		{name: "writable temporary storage", run: deps.temporary, remediation: "use a company-approved user context with writable temporary storage; do not change machine security policy"},
		{name: "embedded frontend and IPv4 loopback", run: deps.loopback, remediation: "record the local policy failure for engineering or IT review; do not weaken firewall, proxy, browser, or EDR policy"},
		{name: "direct self-process execution", run: deps.process, remediation: "record the application-control error for engineering or IT review; do not bypass AppLocker, WDAC, SmartScreen, or EDR"},
	} {
		if err := ctx.Err(); err != nil {
			return preflightBlocked(options.Out, check.name, "preflight was cancelled", "rerun the preflight when the local evaluation can complete uninterrupted")
		}
		if err := check.run(ctx); err != nil {
			return preflightBlocked(options.Out, check.name, "the vendor-free local runtime check failed under the current user or policy", check.remediation)
		}
		if err := preflightPass(options.Out, check.name); err != nil {
			return err
		}
	}

	if err := evalbundle.VerifyBundle(root); err != nil {
		return preflightBlocked(options.Out, "final bundle revalidation", "the evaluation bundle changed or no longer satisfies the discovery-only authority contract", "stop using this extraction and obtain a fresh qualified artifact")
	}
	if err := preflightPass(options.Out, "final bundle revalidation"); err != nil {
		return err
	}

	if _, err := fmt.Fprintln(options.Out, "[WARNING] default-browser launch was not attempted; preflight validates the embedded frontend and loopback session without opening a browser."); err != nil {
		return err
	}
	if _, err := fmt.Fprintln(options.Out, "Vendor discovery and vendor executables were intentionally not invoked."); err != nil {
		return err
	}
	_, err = fmt.Fprintln(options.Out, "READY FOR PHASE 0 INVENTORY")
	return err
}

func validateEvaluationBuildIdentity(version, commit, buildMode, goos, goarch string) error {
	if version != evalbundle.ExpectedVersion || buildMode != evalbundle.ExpectedBuildMode || goos != "windows" || goarch != "amd64" {
		return fmt.Errorf("unexpected evaluation build identity")
	}
	if len(commit) != 40 {
		return fmt.Errorf("source commit must be a full SHA-1")
	}
	for _, char := range commit {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return fmt.Errorf("source commit must be lowercase hexadecimal")
		}
	}
	return nil
}

func resolveEvaluationBundleRoot(configured, executable string) (string, error) {
	if configured == "" {
		return filepath.Clean(filepath.Dir(filepath.Dir(executable))), nil
	}
	root, err := filepath.Abs(configured)
	if err != nil {
		return "", err
	}
	return filepath.Clean(root), nil
}

func verifyRunningEvaluationExecutable(root, executable string) error {
	expected := filepath.Join(root, filepath.FromSlash(evalbundle.ExecutablePath))
	expectedInfo, err := os.Lstat(expected)
	if err != nil {
		return err
	}
	runningInfo, err := os.Lstat(executable)
	if err != nil {
		return err
	}
	if !expectedInfo.Mode().IsRegular() || !runningInfo.Mode().IsRegular() || !os.SameFile(expectedInfo, runningInfo) {
		return fmt.Errorf("running executable does not match bundle executable")
	}
	return nil
}

func preflightPass(out interface{ Write([]byte) (int, error) }, name string) error {
	_, err := fmt.Fprintf(out, "[PASS] %s\n", name)
	return err
}

func preflightBlocked(out interface{ Write([]byte) (int, error) }, name, reason, remediation string) error {
	if _, err := fmt.Fprintf(out, "[BLOCKED] %s: %s\nRemediation: %s\nNOT READY FOR PHASE 0 INVENTORY\n", name, reason, remediation); err != nil {
		return err
	}
	return errEvaluationPreflightBlocked
}
