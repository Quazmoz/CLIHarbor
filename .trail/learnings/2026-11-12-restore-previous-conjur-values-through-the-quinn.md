---
title: Restore previous Conjur values through the approved write with the same qualified ID
author: Quinn
date: 2026-11-12
branch: dev
id: l-11430a1a
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
Restore a retained Conjur value by composing the existing acknowledged version read with the existing secret-set-value approval and write-only stdin task. A restore creates a new current Conjur version; it does not edit historical records or reset the credential in another system. Always construct the same account-qualified variable ID used by retrieval, even when the entered identifier itself looks fully qualified. Otherwise the CLI can interpret the write target differently from the source read.

## Tried and ruled out
A second vendor write endpoint, a new pack command and secret prefills in ordinary task forms were unnecessary: the existing CLI path already binds context, executable identity and exact stdin into one-use approval and durable mutation evidence. The Chrome check initially timed out after a successful write because innerText applied uppercase CSS to the result heading. Assert semantic heading text with textContent instead of treating styled innerText as a state protocol.

## Watch out
Start the hidden-value retention timer when the source read returns, including while preview is pending; invalidate late previews after expiry, visibility loss, selection/target/consent changes or unmount. Keep mutation activity registered until the submitted request settles, so remounting cannot repeat it. Browser tests must wait for the approval checkbox to enable the native action before testing duplicate clicks. The source read log and write journal are separate records, not a durable source-version ledger. Native Windows and real-tenant acceptance remain separate gates.

In the code: web/src/platforms/conjur/ConjurRestoreSecretVersion.tsx; ConjurSecretVersions.tsx; internal/platforms/conjur/secret_retrieval.go prepare; packs/conjur/conjur-v9.yaml secret-set-value; internal/app/browser_e2e_test.go; test/browser_e2e.mjs; ADR-044 in docs/DECISIONS.md.
