---
title: Real Terraform integration requires resolved executable paths for symlinked installs
author: Quinn
date: 2026-10-26
branch: dev
id: l-a7d6d064
scope: repo
status: active
src: agent
touches:
  - README.md
  - internal/platforms/terraform/state_removal_test.go
---

## Decided
`TestStateRemovalWithInstalledTerraform` in `internal/platforms/terraform/state_removal_test.go` converts the selected executable to an absolute path but does not resolve symlinks before calling `activateExecutable`. That helper calls `discovery.CaptureExecutableIdentity` directly. A normal Homebrew Terraform symlink therefore fails with `invalid argument` at the activation call before Terraform executes. Set the documented `CLIHARBOR_TEST_TERRAFORM` override to the approved resolved regular executable to run the real integration without changing production safeguards.

## Tried and ruled out
The unmodified `go run ./tools/task check` reached this failure on macOS with a Homebrew installation. The focused real-Terraform test passed with the resolved executable override. Skipping the real test or relaxing executable identity checks would conceal the harness/path mismatch, so neither is appropriate. No Terraform runtime or test code was changed during the documentation work.

## Watch out
This is the integration harness's direct identity-capture path, not evidence that ordinary discovered Terraform execution is broken. A future test fix should resolve the selected executable before activation while preserving identity checks. macOS results do not qualify native Windows paths, locking, reparse points, or enterprise use. README.md records the existing environment override as troubleshooting guidance.
