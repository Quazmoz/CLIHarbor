---
title: Session cancellation must keep terminal evidence and refresh abandoned connection capabilities
author: Quinn
date: 2026-10-29
branch: dev
id: l-e375ece9
scope: repo
status: active
src: agent
touches:
  - docs/AUTHENTICATION.md
  - docs/TEST_STRATEGY.md
  - internal/app/browser_e2e_test.go
  - internal/webui/static/assets/index-CQU0jvQr.js
  - internal/webui/static/index.html
  - internal/webui/static/web-source.sha256
  - test/browser_e2e.mjs
  - web/src/AuthenticationPage.tsx
  - web/src/AuthenticationRecovery.test.tsx
  - web/src/platforms/conjur/ConjurBackendConnection.test.tsx
---

## Decided
AuthenticationPage keeps a session check's existing SSE subscription during cancellation. POST /runs/<id>/cancel returns the manager's current snapshot immediately, so running is an acknowledgement, not terminal cancellation. Preserve the original attempt and run ID; a streamed terminal result wins over a later cancellation response. Lost acknowledgements expose a separate cancellation error without discarding live verification or starting another check. Focus returns to the stable card heading when its cancellation control disappears or fails.

ConjurBackendConnection refreshes shell capability metadata in the write's finally block even if its form unmounted or the acknowledgement was lost. Local readback still stops on unmount; the shell must learn the new sign-in method without a background authentication command.

## Tried and ruled out
Closing SSE and incrementing the attempt before cancelling loses the real terminal evidence. Reporting cancelled from a running acknowledgement was incorrect. Refreshing capabilities only inside mounted success paths leaves a remounted first-run wizard stale after an accepted connection write.

## Watch out
Keep read-only session-check recovery separate from mutation replay. The production fixture's private delay marker only pauses synthetic whoami; Chrome independently holds its real completion and cancellation acknowledgement to exercise response ordering at 1366/320px. It never alters the trusted command metadata or response identity. Native Windows and live vendor sessions remain separate acceptance gates.
