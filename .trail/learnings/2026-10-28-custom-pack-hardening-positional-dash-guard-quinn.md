---
title: "Custom-pack hardening: positional dash guard lives in the planner; pack text is untrusted until linted"
author: Quinn
date: 2026-10-28
branch: dev
cost: { minutes: 19, tokens: 219494 }
id: l-1cd843cf
scope: repo
status: active
src: agent
touches:
  - internal/planner/planner.go
  - internal/planner/planner_test.go
  - docs/PACK_SPEC.md
  - internal/app/pack_authoring.go
  - internal/app/pack_authoring_test.go
  - internal/packs/packs_test.go
  - internal/app/pack_draft_test.go
  - internal/app/zz_scratch_smoke_test.go
  - internal/packs/validation.go
  - web/src/packDraft.ts
---

## Decided
- Positional argv values beginning with `-` are refused in internal/planner/planner.go (positional case), not only via `disallowLeadingDash`. Integer inputs cannot declare disallowLeadingDash, so an unbounded integer positional rendered `-1` as an undeclared short flag (`git log -1`, `ls -1`). Flag values are left alone: `--tail -1` is a legitimate value position.
- `pack validate` quotes pack name and source (%q). Lint's PACK_TEXT_CONTROL is the control-character rule by design, but validate runs first on a pack you just received, so its output must not emit raw ESC/OSC 52.
- Tool.UnmarshalJSON invariants (e.g. "versionConstraint requires versionProbe") now reach the user via the decode error in internal/packs/validation.go Parse, with control runes replaced (semver echoes the raw constraint).
- The executable denylist (isForbiddenExecutable) now includes launchers (env, xargs, sudo, doas, runas, busybox) and dash/ksh/csh/tcsh/py/pythonw/osascript, matching PACK_SPEC's "launcher binaries" promise. web/src/packDraft.ts unsafeExecutable mirrors it; keep both in step.
- `pack draft` strips a UTF-8 BOM and ANSI CSI sequences, raw or as capture-help leaves them (ESC already turned into U+FFFD by evidence.SanitizeText). OSC sequences are not stripped, so those summaries are still dropped.

## Watch out
- `trail check` flags rejectReservedNewPackID in internal/app/runtime.go against the Oct 20 "don't bypass prepareRuntime with packs.NewLoader()" learning. False positive: that helper only loads built-ins to enforce the reserved-ID rule at init/draft time. It strengthens the gate rather than bypassing it.
- macOS serve calls /usr/bin/open by absolute path, so the real binary cannot be smoke-tested without opening a browser. Use Run() with a browser.LauncherFunc (see run_api_integration_test.go) or CLIHARBOR_BROWSER_E2E=1 (headless Chrome).
- With --no-default-packs the browser wizard cannot see built-in IDs. `pack validate` still rejects them.
