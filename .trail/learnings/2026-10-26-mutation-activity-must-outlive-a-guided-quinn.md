---
title: Mutation activity must outlive a guided form and lock remounted submits
author: Quinn
date: 2026-10-26
branch: dev
id: l-dedc1f7c
scope: repo
status: active
src: agent
touches:
  - web/src/AuthenticationPage.tsx
  - web/src/RunsPage.tsx
  - test/browser_e2e.mjs
---

## Decided
Keep guided mutation activity registered until the original request's finally block runs, even after its form unmounts (web/src/OperationActivity.tsx). Unmount stops later dependent mutations but cannot prove that the current CLI step stopped. Remounted forms consult the same pending activity before allowing another submission. Global activity stores only presentation metadata; retained run evidence remains authoritative for recovery.

Quick session requests reuse AuthenticationPage's existing startCheck. Consume each explicit request once using a cleanup-cancelled microtask: React StrictMode discards the first effect setup, so starting directly in that setup can duplicate or lose the requested CLI check. RunsPage receives a new request object per activity click so selecting another history entry does not make a repeated link to the original run inert.

## Tried and ruled out
Effect-cleanup-only activity loses evidence as soon as a guided form unmounts and lets a remounted form submit while the old mutation is unresolved. Component-local busy state cannot guard a new component instance. Automatically retrying an unconfirmed mutation is unsafe; completion cards direct operators to inspect history and the target.

## Watch out
Activity polling pauses while document.visibilityState is hidden. The production browser harness opens an attacker tab for origin checks; bring the application page to the foreground before asserting fresh activity metadata, rather than removing the visibility guard. Metadata GET /runs calls are not command execution; tests checking for no executions must count POSTs. Native Windows acceptance remains separate from macOS browser coverage.
