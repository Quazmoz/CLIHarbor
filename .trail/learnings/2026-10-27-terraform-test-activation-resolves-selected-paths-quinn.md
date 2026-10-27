---
title: Terraform test activation resolves selected paths before identity capture
author: Quinn
date: 2026-10-27
branch: dev
id: l-484cf882
scope: repo
status: active
replaces: l-a7d6d064
src: agent
touches:
  - README.md
  - docs/ARCHITECTURE.md
  - docs/ROADMAP.md
  - docs/SECURITY.md
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - internal/platforms/terraform/state_removal_test.go
  - internal/webui/static/assets/index-Bqtv-iw8.js
  - internal/webui/static/index.html
  - internal/webui/static/web-source.sha256
---

## Decided
The state-removal test harness now resolves the selected executable with filepath.EvalSymlinks in activateExecutable before CaptureExecutableIdentity. Both the synthetic helper and the real installed Terraform integration pass the resolved regular path and captured identity to the platform. This replaces the earlier manual CLIHARBOR_TEST_TERRAFORM resolved-path workaround in README.md; the override remains optional. Production discovery and identity checks were not relaxed. A Unix-specific regression asserts that direct production identity capture still rejects the link itself.

## Tried and ruled out
The baseline real integration failed before executing Homebrew Terraform because activateExecutable passed its PATH symlink directly to identity capture. Skipping the integration or accepting unresolved symlinks in production would hide the harness mismatch. Native macOS acceptance now runs Terraform 1.12.2 against disposable local state with a project backend block that must not redirect the operation.

## Watch out
This supersedes the workaround in l-a7d6d064. Native Windows filesystem identity, reparse points and locking still need runtime acceptance; Windows cross-compilation does not establish it. The generic pack still has no state-rm task; the dedicated adapter owns its approval and backup contract.
