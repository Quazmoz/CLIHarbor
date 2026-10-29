---
title: Responsive acceptance must use client width when scrollbars consume the viewport
author: Quinn
date: 2026-10-29
branch: dev
id: l-27e3fe92
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
At 320px, compare documentElement.scrollWidth with documentElement.clientWidth in production browser acceptance. innerWidth includes the space consumed by a classic vertical scrollbar, so comparing against it can miss a real horizontal scrollbar. Remove styles.css's body min-width:320px: it forces overflow whenever the layout viewport loses scrollbar space.

## Tried and ruled out
The configuration recovery test passed scrollWidth <= innerWidth after wrapping the settings grid, yet its screenshot still showed horizontal scrolling. The stricter clientWidth assertion covers the actual available page width.

## Watch out
Keep expanded settings and failure/retry states in the 320px journey; a collapsed authentication card does not exercise their intrinsic widths. Internal result-table scrollers remain valid and should not be mistaken for page-wide overflow.
