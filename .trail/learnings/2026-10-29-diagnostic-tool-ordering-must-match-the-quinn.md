---
title: Diagnostic tool ordering must match the composite pack/tool key
author: Quinn
date: 2026-10-29
branch: dev
id: l-344e367d
scope: repo
status: active
src: agent
touches:
  - docs/ARCHITECTURE.md
  - docs/DECISIONS.md
  - docs/PRD.md
  - docs/SECURITY.md
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - internal/app/app.go
  - internal/app/diagnostics.go
  - internal/app/diagnostics_test.go
  - internal/app/run_api_integration_test.go
---

## Decided
Sort the ToolRecord slice in internal/app/diagnostics.go by PackID + "/" + ToolID before the shared diagnostic serializer runs. Both CLI and browser exports use the same deterministic cliharbor.diagnostics/v1 format.

## Tried and ruled out
Relying on discovery.NewSnapshot's tuple ordering caused the real application diagnostic endpoint to return internal_error for the valid integration and integration-alt packs. Tuple ordering puts integration first, while the diagnostic composite key puts integration-alt/alternate before integration/fixture. Changing global discovery order or weakening diagnostics.Validate would affect unrelated behavior or the established format; sorting the export records fixes the shared source once.

## Watch out
A single-pack test misses this failure. Keep the prefix-ID regression in internal/app/diagnostics_test.go and the multi-pack API assertion in internal/app/run_api_integration_test.go. Diagnostic reports remain metadata only; do not add source paths, output, credentials, or browser session material to make debugging richer.
