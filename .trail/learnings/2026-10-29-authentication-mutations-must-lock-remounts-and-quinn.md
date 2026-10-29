---
title: Authentication mutations must lock remounts and abandon late verification
author: Quinn
date: 2026-10-29
branch: dev
id: l-7c2429ca
scope: repo
status: active
src: agent
touches:
  - docs/ARCHITECTURE.md
  - docs/AUTHENTICATION.md
  - docs/DECISIONS.md
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - internal/server/run_api.go
  - internal/server/run_stream_test.go
  - internal/webui/static/assets/index-C0hLrQHC.js
  - internal/webui/static/assets/index-geL7zhFR.css
  - internal/webui/static/index.html
---

## Decided
Conjur sign-in, self-hosted setup and SaaS configuration reuse OperationActivity's request-lifetime mutation guard, keyed to the authentication card. Keep it until finally even after navigation so remounted forms and header checks cannot race the pending request. AuthenticationPage.startCheck also checks its mounted lifetime: a successful password response may otherwise invoke an old verifySession callback after unmount, starting an unwanted CLI command and restoring a stale badge.

GET /api/v1/auth/configure is only a local configuration read under a fail-fast auth gate (CredentialLoginService.Connection), so api/authentication.ts now uses the existing full-response 15s deadline. This deliberately refines ADR-039's old GET exemption; POST login/configuration remain outside read deadlines. ConjurBackendConnection shows reading/error/retry states and restores recovery-panel focus.

## Tried and ruled out
EventSource cannot expose comment-only SSE keepalives to JavaScript. A watchdog based only on output would disconnect healthy quiet commands. internal/server/run_api.go instead sends named heartbeat events without IDs; api/runs.ts resets a 45s idle deadline on heartbeat or new evidence, never on empty opens. Expiry uses retained-run reconciliation without command replay. Browser acceptance also found expanded configuration settings widening 320px pages; the shared credential-login-form grid needs min-width:0 and overflow-wrap:anywhere.

## Watch out
A rejected or abandoned login request may already have changed the vendor-owned session; do not cancel/replay it or infer rollback. External account/configuration changes still require an explicit session check. The browser fixture's wait command lasts 30s, so browser_e2e.mjs silences its native socket and injects the production subscriber's captured idle callback; API tests advance the actual 45s deadline and verify quiet heartbeats, cursor integrity and timer cleanup. Chrome native button Enter events need text:'\\r' as well as the key/code; omitting it leaves the button focused without activating it. Windows and live-tenant qualification remain separate gates.
