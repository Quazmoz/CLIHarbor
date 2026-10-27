---
title: Recovery waits for full responses and binds evidence to the selected run
author: Quinn
date: 2026-10-27
branch: dev
id: l-a713a78b
scope: repo
status: active
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
web/src/api/http.ts keeps its read deadline and caller-abort forwarding active through response.arrayBuffer, then returns a buffered Response to the existing JSON readers. The deadline used to end at headers, leaving a stalled body unbounded. Mutations remain outside this deadline. API tests emulate a body that only settles on abort; older mocks in MutationAuditTrail.test.tsx and TerraformWorkspace.test.tsx now use real Response objects from the shared fakeBackend helpers.

web/src/api/runs.ts classifies lost, malformed, mismatched or internal-error create acknowledgements as run_start_unknown, without replay. Confirmed rejections and caller AbortError retain their semantics. App activity labels these outcomes unconfirmed and directs recovery to History and the target. The Chrome test loses a response after real fixture acceptance and verifies one process execution through retained history.

RunsPage.tsx clears old detail, errors and loading state when a new Activity link selects a different run. Previously the heading and run ID changed immediately but previous output remained until the new fetch settled. Repeated links to the currently selected run preserve its evidence.

## Tried and ruled out
App.test.tsx's transient-status test waited for the static Command Builder heading, which exists during loading, then counted an unrelated Activity GET /runs. A deferred task response and task-specific ready controls establish completion without sleeps or a total fetch count. Browser chooseTask similarly must wait for the task button after opening a disclosure: React mounts the catalog in its toggle handler, so immediate same-evaluation DOM lookup races rendering.

## Watch out
History is bounded and in memory; missing evidence cannot prove a change did not happen. Keep backend one-use approvals, secret exclusions and explicit reconciliation. Unix dev-restart.sh now builds before stopping and executes the freshly pulled helper; its hermetic shell regression uses fake Go/Git and never stops a process. Native Windows acceptance and real vendor sessions remain separate gates.
