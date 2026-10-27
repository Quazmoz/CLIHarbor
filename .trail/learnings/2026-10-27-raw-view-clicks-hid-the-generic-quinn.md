---
title: Raw-view clicks hid the generic formatter bypass in acceptance tests
author: Quinn
date: 2026-10-27
branch: dev
id: l-ae13056f
scope: repo
status: active
src: agent
touches:
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - internal/app/execution_integration_test.go
  - internal/webui/static/assets/index-B04YQyjT.js
  - internal/webui/static/index.html
  - internal/webui/static/web-source.sha256
  - test/browser_e2e.mjs
  - web/src/App.test.tsx
  - web/src/App.tsx
  - web/src/OutputExplorer.test.tsx
---

## Decided
The existing parser-failure acceptance in web/src/App.test.tsx clicked Raw before inspecting evidence. That allowed a second, generic JSON formatter in OutputExplorer.tsx to render the very data rejected by the backend while the test still passed. Assert the initial output mode and visible diagnostics before interacting with view controls. RunsPage.tsx uses the same component, so retained evidence needs the same acceptance.

## Tried and ruled out
Adding a parser-warning message alone would not solve the problem: App already displayed the warning while the generic formatter selected and copied JSON fields. Duplicate keys demonstrate the consequence because JSON.parse silently keeps only the last value. The backend parser's invalid/unavailable result must suppress this fallback.

## Watch out
Successful commands without a backend structured contract still use the bounded generic preview. Formatting is presentation only; run status, exit code, exact separated stdout/stderr, approvals and vendor authority remain independent. The Chrome fixture checks a real nonzero process in Tasks and History; its existing failure heading includes the exit code (Failed · exit 7).
