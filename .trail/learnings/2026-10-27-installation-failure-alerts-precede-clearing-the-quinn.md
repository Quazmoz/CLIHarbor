---
title: Installation failure alerts precede clearing the shared busy guard
author: Quinn
date: 2026-10-27
branch: dev
id: l-03123e72
scope: repo
status: active
src: agent
touches:
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - test/browser_e2e.mjs
  - web/src/App.test.tsx
  - web/src/AppFeatures.test.tsx
  - web/src/OutputExplorer.test.tsx
  - web/src/OutputExplorer.tsx
  - web/src/StructuredResultView.test.tsx
  - web/src/StructuredResultView.tsx
  - web/vite.config.ts
---

## Decided
web/src/AppFeatures.test.tsx waits for the Install Fixture CLI button to become enabled after asserting a failed-installation alert, as the successful-installation test already does for Open tasks. The error notice is rendered before the shared working-activity state has fully cleared; seeing the alert alone does not establish that the action is ready.

## Tried and ruled out
The full suite reproduced an immediate toBeEnabled failure after the two-worker cap removed widespread timeouts. The handler in web/src/App.tsx sets its notice in catch and clears its local pending state in finally; shared working activity then clears through its existing lifecycle. Removing the product busy guard or immediately re-enabling controls would weaken duplicate-submit protection. Waiting for the actual ready control fixes the test's assumption.

## Watch out
Keep the retry action blocked while any shared operation remains active. An error message is not a completion signal for all related React state. Do not use sleeps, retries of the installation POST, or weaker assertions to hide the transition.
