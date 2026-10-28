---
title: "Conjur workspace target refresh needs window focus, not just visibility"
author: Quinn
date: 2026-10-28
branch: dev
cost: { minutes: 3, tokens: 84649 }
id: l-281c1441
scope: repo
status: active
src: agent
touches:
  - web/src/platforms/conjur/ConjurWorkspace.tsx
  - web/src/PlatformPage.test.tsx
  - internal/platforms/conjur/secret_audit.go
---

## Decided
Issue #69 fix is frontend-only: web/src/platforms/conjur/ConjurWorkspace.tsx bumps a refresh counter on window `focus` and on `visibilitychange` to visible, and that counter is a dep of the existing fetchSecretAudit effect. The effect's per-run AbortController already handles overlapping refreshes and unmount, and child guided forms are already keyed on discoveryKey+account+endpoint, so a changed target resets them. Remounted forms stay locked by the OperationActivity registry (see l-dedc1f7c).

## Tried and ruled out
Backend changes are not needed: SecretAuditService.withCurrentTarget (internal/platforms/conjur/secret_audit.go) re-reads ~/.conjurrc on every GET and drops a stale idle snapshot's target. A periodic poll was skipped: the change only happens when the operator runs the vendor CLI elsewhere, so "returning to the page" is the right reconciliation point.

## Watch out
`visibilitychange` alone misses the main case: on macOS a terminal in front of a still-visible browser window never changes document visibility, so only window `focus` fires on return. A failed refresh deliberately clears the target (fails closed), which also resets any half-filled guided form. Regression: PlatformPage.test.tsx "re-reads an externally changed target on return without discovery drift".
