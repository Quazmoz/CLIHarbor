---
title: "Browser storage resets every launch, so per-user state lives in the runtime; reads may show target context"
author: Quinn
date: 2026-11-04
branch: dev
cost: { minutes: 1, tokens: 2122 }
id: l-a5406b29
scope: repo
status: active
src: agent
touches:
  - internal/app/install_locations.go
  - internal/runs/manager.go
  - internal/platforms/conjur/credential_login.go
  - web/src/taskPreferences.ts
  - web/src/api/runs.ts
---

## Decided
- Every launch binds a new loopback port, so localStorage is a new origin each time and silently dropped favorites/recents on every restart. Task preferences are stored by the runtime in the per-user config dir; the browser keeps one in-memory copy.
- The browser never writes preferences before a successful read of the stored copy. Boot reconciliation saves immediately, so without this guard a failed or slow GET would PUT an empty document and wipe saved favorites.
- Preferences load after the workspace renders and never block boot.
- Form values are not persisted: the user chose "favorites only" and the SECURITY.md rule stands. Presets need a fresh decision.
- Read-task previews carry a platform's ExecutionContext when its reviewed resolver succeeds; a resolver failure is ignored for reads, while mutations still fail closed.
- Conjur sign-out runs upstream `conjur logout` (PurgeCredentials only, no server call) through the identity-verified fixed-argv runner, then re-runs the session check.

## Tried and ruled out
- Awaiting the preferences GET before acceptRuntime: blocks boot on a side request, and catch-all test mocks that never resolve unknown paths hang.
- Keeping localStorage as the store: cannot survive a restart because the origin includes the ephemeral port.

## Watch out
- parsePreview in the browser once rejected any context on a read preview; adding backend context alone made every Conjur read fail as an invalid response. The rule is: reads may carry context, never impact or approval.
- Tests built on bootRoutes() answer GET/PUT /api/v1/preferences; hand-rolled catch-all mocks must route it, or it is counted as some other request.

In the code: internal/server/preferences_api.go, internal/app/task_preferences.go, writePrivateFileAtomic in internal/app/install_locations.go, Manager.Preview in internal/runs/manager.go, CredentialLoginService.Logout in internal/platforms/conjur/credential_login.go, web/src/taskPreferences.ts, web/src/api/runs.ts.
