---
title: Vendor login focus listeners need the latest launch acknowledgement
author: Quinn
date: 2026-10-29
branch: dev
id: l-eb5de833
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
ConjurSignIn's return-focus handler uses React useEffectEvent so an already registered listener reads the current vendor launch acknowledgement and check state. Keep its existing explicit-launch, actual-departure and visible-page guards; an unrelated focus still must not run a command.

## Tried and ruled out
The old effect-local closure could still see vendorLoginOpened=false after the success notice rendered, before passive effects replaced the launch-time listener. A full frontend run exposed the missed return. AuthenticationPage.test.tsx now holds the launch response, captures the launch-time focus listener, acknowledges the launch, then delivers return through that listener. This deterministically fails with the stale closure instead of depending on scheduler timing.

## Watch out
This does not authorize background session polling. AuthenticationPage's mounted-lifetime guard still refuses verification after navigation; do not replace it with a timeout or an automatic retry.
