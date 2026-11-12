---
title: "Browser acceptance must isolate the runtime preference store, not assert localStorage"
author: Quinn
date: 2026-11-12
branch: dev
id: l-8aa0fa24
scope: repo
status: active
src: agent
touches:
  - README.md
  - docs/ARCHITECTURE.md
  - docs/CONJUR_INTEGRATION.md
  - docs/DECISIONS.md
  - docs/ROADMAP.md
  - docs/SECURITY.md
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - internal/app/browser_e2e_test.go
  - internal/webui/static/assets/ConjurAccessExplorer-Dd0nVMV9.js
---

## Decided
The production browser harness must run with a temporary HOME and XDG_CONFIG_HOME before constructing the application. Runtime-backed task favorites use os.UserConfigDir independently of the mutation journal's explicit test path, so isolating AuditPath alone does not isolate browser preference writes. Verify saved favorites through GET /api/v1/preferences and exact packId/commandId-only entries; the ephemeral browser origin must not own the persisted preference key.

## Tried and ruled out
The old E2E assertion expected cliharbor.task-preferences.v1 in localStorage even though preferences had moved into the runtime. It failed after the new restore journey passed. Keeping that assertion, restoring localStorage writes, or weakening persistence coverage would contradict the accepted restart behavior. A fresh authenticated preferences GET proves the runtime saved the selected identity.

## Watch out
Read the existing runtime preferences before browser reconciliation may save them. A normal-user test profile can otherwise affect real favorites even though vendor credentials and the mutation journal use fixture paths. Keep all test profile/cache paths temporary; never delete or guess repairs to the operator's preference file. Native Windows and real vendor acceptance remain separate.

In the code: internal/app/browser_e2e_test.go TestProductionEmbeddedBrowserE2E; internal/app/task_preferences.go newTaskPreferencesStore; internal/server/preferences_api.go; test/browser_e2e.mjs favorite persistence assertions; web/src/taskPreferences.ts.
