---
title: "Generic CLI hardening: event budget, Windows shims, install qualification"
author: Quinn
date: 2026-10-20
branch: hardening/generic-cli-robustness-20261020
cost: { minutes: 19, tokens: 189156 }
touches:
  - internal/webui/static/assets/index-BVICIoeT.css
  - internal/webui/static/assets/index-CXCHFON2.js
  - internal/webui/static/index.html
  - internal/webui/static/web-source.sha256
  - web/src/App.tsx
  - web/src/AppFeatures.test.tsx
  - web/src/AuthenticationPage.tsx
  - web/src/ToolExplorer.tsx
  - web/src/api/errors.test.ts
  - web/src/api/errors.ts
---

## Decided
- Run event memory is bounded by one byte budget (2 MiB) charging 64 bytes per data event; there is no separate event-count cap. Data-less lifecycle events (started/exited) always land.
- Managed install qualification compares versions with semver Equal (build metadata ignored); any pack with `install` must declare a versionProbe.
- On Windows, discovery only accepts .exe/.com (never an extensionless file).
- multiselect inputs are rejected at pack load until a list argv/stdin mapping exists.
- AWS pack passes --no-cli-auto-prompt (available since 2.0.0); Helm releases task passes --all.

## Tried and ruled out
- Guarding /dedicated/conjur/security-audit behind a loaded Conjur platform: AppFeatures.test.tsx asserts the legacy audit URL opens with no dedicated CLI loaded, by design.
- Reproducing the event cap with a Go helper printing lines in a loop: pipe reads coalesce, so test recordEvent directly instead.

## Watch out
- `go run ./tools/task check` fails until the regenerated internal/webui/static bundle is committed.
- `git stash` does not stash untracked built assets; don't follow it with `git clean` on internal/webui/static.
- trail check can flag tests that mention discovery/prepareRuntime against the "don't bypass prepareRuntime" learning even when they comply.
