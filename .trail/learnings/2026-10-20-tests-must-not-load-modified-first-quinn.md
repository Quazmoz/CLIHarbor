---
title: Tests must not load modified first-party packs
author: Quinn
date: 2026-10-20
branch: main
cost: { minutes: 4, tokens: 76886 }
touches:
  - internal/app/conjur_secret_tasks_integration_test.go
  - internal/app/runtime.go
---

## Decided
- Integration tests that exercise a first-party pack (e.g. cyberark-conjur-v9) load it via prepareRuntime(Options{LoadDefaultPacks: true}) and skip on hosts the pack's `platforms` list excludes, rather than loading an edited copy via PackFiles.
- TestConjurSecretTasksExecuteApprovedPolicyAndSecretOnStdin now runs on darwin only (pack targets windows/darwin; stand-in CLI is a POSIX script).

## Tried and ruled out
- Widening the pack's platforms in a temp copy: the reserved-ID guard in internal/app/runtime.go (only byte-identical embedded packs may use a built-in ID) correctly rejects it.
- Bypassing prepareRuntime with packs.NewLoader().LoadFiles + discovery.Resolver directly: it skips the reserved-pack security gate, so don't do that in tests.

## Watch out
- Any test feeding a modified built-in pack through --pack-file/--pack-dir will fail with "reserved for a built-in CLI"; that error is intended behavior, not a regression.
