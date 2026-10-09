# Agent Index

Use this document as the canonical read order for development agents.

## Current repository state

CLIHarbor is a Go local-first launcher with an embedded React/TypeScript interface, a reviewed declarative pack registry, loopback-only authenticated APIs, bounded direct executable discovery/planning/execution, Windows process-tree containment, and an explicit run approval/audit boundary. The runtime ships four first-party packs: Conjur, Docker, kubectl and GitHub CLI. The Conjur dedicated UI includes reviewed vendor-owned sign-in, read-only metadata and access exploration, regex-pattern auditing, and guarded change workflows. Browser-side custom pack authoring produces only discovery-only drafts requiring separate review and explicit trusted loading.

**Qualification is not the same as implementation.** Corporate Conjur authentication/MFA, target-host policy, and real Docker/kubectl/GitHub environments require on-device acceptance. The Windows evaluation bundle remains unsigned. The latest source may exceed the committed embedded frontend: [issue #59](https://github.com/Quazmoz/CLIHarbor/issues/59) tracks the release-blocking asset rebuild and verification. Never release an executable until the production browser bundle is regenerated from the matching React source and the applicable pinned-toolchain checks are observed passing.

For current feature status and non-goals, use [ROADMAP.md](ROADMAP.md), [SECURITY.md](SECURITY.md), [AUTHENTICATION.md](AUTHENTICATION.md) and the live implementation; do not infer the product's present capabilities from historical phase milestones below.

## Read order

1. `../AGENTS.md`
2. `PRD.md`
3. `ARCHITECTURE.md`
4. `SECURITY.md`
5. `AUTHENTICATION.md`
6. `PACK_SPEC.md`
7. `UX.md`
8. `DECISIONS.md`
9. `DEVELOPMENT_PLAN.md`
10. `TEST_STRATEGY.md`
11. `ROADMAP.md`
12. `RESEARCH.md`

## Ownership map

### Product behavior

Canonical: `PRD.md`

Use for goals, non-goals, functional requirements, personas, success criteria, and open product questions.

### Runtime architecture

Canonical: `ARCHITECTURE.md`

Use for component boundaries, API shape, discovery/execution pipeline, state, streaming, packaging, and extension points.

### Security invariants

Canonical: `SECURITY.md`

Security constraints override convenience-driven interpretations elsewhere. Any feature that weakens a listed invariant requires explicit design review.

### Authentication

Canonical: `AUTHENTICATION.md`

Use for vendor-owned auth/session principles, external terminal login, future PTY considerations, and credential handling.

### Pack/schema design

Canonical: `PACK_SPEC.md`

Use for the implemented v1 declarative model, validation stages, version probes, trust model, constrained argument mappings, output metadata, and compatibility rules. The executable schema is `../schemas/pack.v1.schema.json`; code under `../internal/packs/` is source of truth for implemented semantic/security validation.

### Tool discovery

Canonical implementation: `../internal/discovery/`.

Use for exact executable resolution, explicit path overrides, ambiguity handling, semantic-version parsing/constraints, bounded direct version probes, minimal-environment/neutral-cwd probe isolation, shared platform process-tree ownership, and discovery state consumed by startup/doctor. Discovery state is not authorization to add undeclared commands.

### Execution planning

Canonical implementation: `../internal/planner/`.

Use for typed runtime values, exact argv construction, discovery-state/identity gating, and the current read-only/auth/output policy envelope.

### Process execution

Canonical implementation: `../internal/executor/`.

Use for direct `os/exec` invocation, run events, output bounds, timeout/cancellation, neutral working directories, executable revalidation, and platform process-lifecycle ownership. Windows uses a per-run Job Object with suspended start/assignment-before-resume.

### Run orchestration

Canonical implementation: `../internal/runs/` and `../internal/server/run_api.go`.

Use for bounded in-memory run ownership, create/get/cancel semantics, browser-safe snapshots, monotonic event sequencing/replay, concurrency/retention limits, and the authenticated loopback run/SSE APIs.

### User experience

Canonical: `UX.md`

Use for navigation, task forms, run views, auth UX, destructive-action UX, accessibility, and diagnostics. Exact filesystem discovery evidence remains in CLI `doctor`; the browser now has a sanitized read-only tool-status/remediation view that deliberately omits executable and candidate paths.

### Historical decisions

Canonical: `DECISIONS.md`

Do not casually reverse accepted decisions. Add a superseding decision when new evidence requires change.

### Build sequence

Canonical: `DEVELOPMENT_PLAN.md`

Use to choose the highest-value next implementation milestone.

### Verification

Canonical: `TEST_STRATEGY.md`

Security-sensitive runtime behavior is not complete without tests described here.

### Product sequence

Canonical: `ROADMAP.md`

Use for staging from Idira-specific MVP to multi-CLI packs and optional ecosystem work.

### External evidence

Canonical: `RESEARCH.md`

Use to understand existing tools, upstream Idira/CyberArk status, and demand evidence. Refresh this document when material market/upstream facts change.

## Source-of-truth rules

- Repository code is source of truth for implemented behavior.
- `schemas/pack.v1.schema.json` plus `internal/packs` are source of truth for the currently supported pack format and pack validation.
- `internal/discovery` is source of truth for current local tool discovery/version semantics and discovery-time executable identity, including the SHA-256 replacement-detection fingerprint.
- `internal/planner`, `internal/executor`, and `internal/runs` are source of truth for current execution, approval, and lifecycle boundaries.
- PRD/spec docs are source of truth for intended behavior not yet implemented.
- `DECISIONS.md` is source of truth for accepted architectural decisions.
- Upstream vendor documentation wins over old assumptions about CLI flags/commands.
- Before adding Idira/CyberArk task definitions, verify exact commands against the deployed tool version.

## Current implementation checkpoint

The core has progressed beyond its initial Phase 0–5 read-only foundation. Current ownership and verification entry points:

- `internal/packs/`, `schemas/`, and `packs/`: trusted-pack validation and the reviewed first-party CLI declarations; explicit custom packs never gain authority from captured help text.
- `internal/discovery/`, `internal/planner/`, `internal/executor/`, and `internal/runs/`: executable identity/version checks, typed argv, direct process lifecycle, bounded streaming, approval gating, and retained run state.
- `internal/platforms/conjur/` and `internal/server/`: Conjur-specific configuration/authentication/audit adapters behind the generic loopback security boundary.
- `web/src/`: generic task discovery, command previews, output inspection, diagnostics, install catalog and safe custom-pack draft UX; `web/src/platforms/conjur/` owns dedicated Conjur screens.
- `internal/webui/static/`: **generated** embedded browser artifacts, not authoritative React source. Build and synchronize them only with the repository task tooling; do not hand-edit the bundle. The generator records `web-source.sha256`; `verify-web-sync` compares the current frontend source and package inputs to this marker before checking Git status. An absent/outdated marker blocks qualification even on a clean checkout.
- `tools/task/`, `test/`, `web/src/**/*.test.ts*`, and `.github/workflows/`: local qualification commands, integration/browser harness, and manual-only CI workflows.

Use `go run ./tools/task check` with the pinned Go/Node/npm versions, then verify embedded frontend synchronization and perform relevant Windows/browser acceptance before considering release. GitHub Actions may be dispatched **only with specific user authorization**; routine commits/merges must not auto-trigger workflows. The older Phase 0 procedures below remain useful for isolated managed-laptop discovery and evidence review, but are not a current feature inventory.

### Phase 0 work-laptop test-readiness checkpoint

The repository now implements the pre-vendor-integration work-laptop evaluation boundary:

- `cliharbor version` reports version, source commit, build mode, Go version, and target platform;
- `cliharbor self-test` validates temp access, pack/registry loading, structured parsing, embedded frontend/session/bootstrap, IPv4 loopback, and direct self-process execution without a vendor CLI or external network;
- `cliharbor inventory` reports sanitized host/build/tool discovery state for explicitly trusted packs;
- optional operator-selected version/help evidence probes can use only fixed trusted pack declarations and backend-owned discovery state;
- discovery-time version probes and operator-selected evidence probes run directly with shared platform process-tree ownership, a neutral temp cwd, minimal environment, and strict timeout/output bounds; Windows uses the same suspended-start Job Object boundary for both, and version discovery fails closed on truncated/invalid-UTF-8 output;
- evidence probes revalidate discovery-time executable fingerprints immediately before launch;
- `cliharbor.phase0/v1` evidence export is typed, bounded, sanitized, self-describing with sanitized fixed argv, omits timestamps for probes that did not execute, and uses atomic no-clobber activation;
- `packs/phase0/idira-cyberark-inventory.yaml` is discovery-only and asserts no vendor command/probe argv;
- `go run ./tools/task windows-eval` produces `bin/cliharbor-windows-x64-evaluation.exe` plus the root authoritative `EVALUATION_SHA256SUMS` covering that executable and the trusted Phase 0 pack;
- `cliharbor evaluation preflight` is the self-contained extracted-bundle gate: it validates exact build identity, exact bundle layout/integrity, discovery-only Phase 0 pack authority, temp/loopback/frontend/self-process suitability, then revalidates the bundle without running discovery or any vendor executable;
- CI stages an extracted-copy bundle, places deliberately invalid `idsec.exe`/`conjur.exe` sentinels first on `PATH`, and requires the packaged evaluation executable to pass preflight without touching those sentinels before upload;
- evidence/diagnostics from a managed-laptop run belong outside the immutable extracted evaluation bundle so exact-layout preflight remains meaningful;
- the exact laptop procedure is `WORK_LAPTOP_EVALUATION.md`.

Managed-laptop preflight and evidence collection remain available independently of the newer reviewed Conjur v9 pack. Neither upstream command documentation nor a green synthetic test proves employer approval, current vendor session state, or native Windows acceptance.

### Phase 0 evidence-consumption checkpoint

`cliharbor evidence inspect <file>` is the authoritative operator-side review path for returned `cliharbor.phase0/v1` artifacts. Its implementation is in `internal/evidence/read.go` and `internal/app/evidence_inspect.go`.

Agents must treat imported evidence as untrusted inert data. Never derive executable pack authority automatically from captured stdout/stderr or fixed argv strings. A real vendor workflow requires a separate human-reviewed pack change supported by the exact evidence or approved documentation.

### Phase 0 evidence transfer-integrity checkpoint

For Phase 0 handoff work:

- export prints a detached SHA-256 of the exact JSON bytes written;
- `cliharbor evidence inspect --sha256 <digest> <file>` is the preferred review path when the export digest was independently retained;
- `cliharbor evidence checksum <file>` only calculates the current received file's digest and is not an independent proof;
- checksum verification establishes byte equality with the supplied digest, not signer/build/host authenticity;
- evidence remains inert and cannot acquire pack or execution authority.
