---
title: "Executable policy: Windows script types and launchers are rejected, Unix shebang scripts are not; one JSON fixture pins Go and the wizard"
author: Quinn
date: 2026-10-28
branch: dev
cost: { minutes: 21, tokens: 117777 }
id: l-04e2db6c
scope: repo
status: active
src: agent
touches:
  - internal/discovery/discovery_test.go
  - internal/discovery/resolver.go
  - internal/app/run_api_integration_test.go
  - docs/PACK_SPEC.md
  - docs/SECURITY.md
  - internal/packs/packs_test.go
  - internal/packs/testdata/executable-policy.json
  - internal/packs/validation.go
  - internal/webui/static/assets/index-Ch7CYkPa.js
  - internal/webui/static/index.html
---

## Decided
- isForbiddenExecutable (internal/packs/validation.go) is the authority; web/src/packDraft.ts mirrors it advisory-only. internal/packs/testdata/executable-policy.json is read by both TestExecutablePolicyContract and packDraft.test.ts, so add a name there when changing either list. The same file holds the wizard's exact draft YAML, which Go must parse unchanged.
- Script-extension rejection covers Windows types only. CreateProcess routes .bat/.cmd through cmd.exe, which re-parses argv; the rest need a script host. Unix shebang scripts (kafka-topics.sh) are exec'd with argv intact, so .sh/.py are accepted: rejecting them broke real vendor wrappers and protected nothing, because extensionless scripts pass anyway.
- Interpreters match with any trailing version (strings.TrimRight digits/dots: python3.12, perl5.36, node18, javaw). Launchers match exactly, so env0 (a real vendor CLI) stays allowed.
- doctor's pre-release hint fires only when the version's release core satisfies the constraint (internal/discovery/resolver.go).

## Tried and ruled out
- Applying the version-strip to launchers too: it rejected env0.

## Watch out
- In run_api_integration_test.go the fixture executable is the Go test binary, so preview args start with the pack's helper literals (-test.run=..., --, --cliharbor-phase4b-fixture). Stdout strips them; the preview does not.
