---
title: Display-only JSON rows cannot prove semantic equality between runs
author: Quinn
date: 2026-10-28
branch: dev
id: l-8acaa7d1
scope: repo
status: active
src: agent
touches:
  - docs/SECURITY.md
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - internal/webui/static/assets/index-BTKnCsd1.js
  - internal/webui/static/assets/index-DrEGgqT0.css
  - internal/webui/static/index.html
  - internal/webui/static/web-source.sha256
  - test/browser_e2e.mjs
  - web/src/RunsPage.test.tsx
  - web/src/RunsPage.tsx
---

## Decided
RunComparison.tsx compares already-fetched decoded stdout and stderr through api/runs.ts's existing decodeRunOutput. Its full-text equality result is separate from the bounded positional line preview and from each run's status. RunsPage.tsx retains one completed baseline only in browser memory and drops it on observed eviction.

## Tried and ruled out
Using OutputExplorer.tsx's generic display rows as keys and values for a semantic JSON comparison was considered and rejected. Those rows stringify scalar types, join object names into dotted display paths, and omit empty containers. Treating them as a canonical representation could conflate a number with its string representation or a literal dotted key with a nested key. A semantic comparison needs its own reviewed type-preserving representation, canonical paths and container/resource bounds; do not infer semantic equality from the presentation rows.

## Watch out
The same pack/command/tool identity does not establish matching inputs or vendor account/context, which are absent from history summaries. Matching decoded text is not a byte-identity, successful-execution, effective-access or service-state verdict. Failed/parser-rejected runs remain raw diagnostics. Pin/clear must not fetch or execute anything, and a delayed new selection must not display the previous run's comparison.
