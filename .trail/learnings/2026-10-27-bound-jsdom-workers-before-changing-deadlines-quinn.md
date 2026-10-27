---
title: Bound jsdom workers before changing deadlines for widespread test failures
author: Quinn
date: 2026-10-27
branch: dev
id: l-b08609ee
scope: repo
status: active
src: agent
touches:
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - test/browser_e2e.mjs
  - web/src/App.test.tsx
  - web/src/OutputExplorer.test.tsx
  - web/src/OutputExplorer.tsx
  - web/src/StructuredResultView.test.tsx
  - web/src/StructuredResultView.tsx
  - web/vite.config.ts
---

## Decided
Keep the existing vmThreads pool and per-file module isolation in web/vite.config.ts, capped at two workers. The default used ten jsdom workers on a many-core developer laptop under load. Broad failures included synchronous OutputExplorer assertions exceeding the ordinary five-second test deadline, alongside unchanged sign-in, navigation and Terraform tests. The same complete 385-test suite passed with --maxWorkers=2, without raising deadlines or changing product behavior.

## Tried and ruled out
The normal web-build stopped on 22 failures before generating or activating assets. Focused output and App acceptance passed first. Treating the widespread timeouts as separate application defects, raising every test deadline, or weakening isolation would obscure runner contention. A worker cap makes repository builds and the existing development restart helper use the validated concurrency setting.

## Watch out
A lower worker count does not excuse a repeatable assertion failure. Keep fail-loud network fakes, real asynchronous completion assertions, unchanged deadlines and browser acceptance. Source synchronization still requires regenerating the embedded frontend after the Vite configuration changes.
