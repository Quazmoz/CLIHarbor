---
title: "Custom-CLI authoring: errors must surface before serve, pre-release constraints stay strict"
author: Quinn
date: 2026-10-28
branch: dev
cost: { minutes: 9, tokens: 176153 }
id: l-516b6fd3
scope: repo
status: active
src: agent
touches:
  - internal/packs/validation.go
  - internal/app/runtime.go
  - internal/app/pack_draft.go
---

## Decided
- Pack schema errors report the deepest failing jsonschema leaf plus its reason (internal/packs/validation.go schemaErrorDetail). For oneOf argv shapes the deepest leaf is the branch the author meant (e.g. `argv.0.flag: got string, want object`).
- The reserved built-in pack-ID guard is one helper, rejectReservedPackIDs in internal/app/runtime.go, shared by prepareRuntime and loadPackAuthoringRegistry (validate/lint/compatibility/test/generate-tests). pack init/draft check the ID too. Before this, `pack validate` passed IDs like github-cli that serve then refused.
- pack init/draft and the browser wizard default platforms to the host OS. The old Windows-only default made a fresh scaffold unsupported-platform on the Mac that created it.
- Pre-release versions (macOS ships `jq-1.7.1-apple`) still fail constraints without `-0` bounds. We kept the semver semantics (built-ins opt in with `-0` on purpose); doctor now names the cause and PACK_SPEC §7 documents it.

## Tried and ruled out
- Accepting pre-releases by default in the resolver: it would silently widen every built-in pack's compatibility range.

## Watch out
- `pack draft` header matching uses one regex (draftCommandsHeader in internal/app/pack_draft.go). It covers gh `CORE COMMANDS`, kubectl `Basic Commands (Beginner):` and terraform `Main commands:`; names may end in `:` (gh style).
- jsdom's navigator.userAgent contains `(darwin)`/`(linux)`, not `Mac`, so wizard host detection matches those tokens too.
