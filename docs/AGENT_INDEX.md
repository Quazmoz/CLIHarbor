# Agent Index

Use this document as the canonical read order for development agents.

## Current repository state

CLIHarbor has completed the **Phase 1 local-runtime foundation**, **Phase 2 pack-schema/loader foundation**, **Phase 3 tool-discovery/version-probing foundation**, and the **Phase 4 low-level planner/executor foundation**. The repository now contains a Go command/runtime, IPv4 loopback listener, one-time browser bootstrap/session boundary, Host/Origin/CSRF protections, hardened browser headers, an authenticated status API, graceful shutdown, a React/TypeScript/Vite UI, locally embedded production frontend assets, automatic default-browser launch, a loopback-only frontend development proxy, cross-platform task tooling, Windows/Linux CI, a versioned trusted-pack model with strict validation/loading, and fail-closed local executable discovery with bounded version probes and `cliharbor doctor`.

The pack foundation supports schema version `cliharbor.dev/v1`, built-in pack bytes, and explicitly requested local YAML files/directories. Tool discovery considers only absolute PATH entries or explicit backend-only overrides tied to declared pack/tool IDs; it rejects ambiguity rather than taking the first match. Version probes are fixed pack-authored argv with bounded time/output and no shell. Repository/cwd packs still receive no implicit trust.

The internal planner/executor exists for the constrained read-only safety envelope, and Phase 4b proves the explicit-local pack → discovery/version probe → planner → executor path with two isolated synthetic pack/tool scenarios using distinct tool IDs, versions, and command shapes. Phase 4c-A adds authenticated create/get/cancel run APIs backed by a bounded in-memory run manager. Phase 4c-B adds bounded authenticated SSE replay plus safe task metadata and a minimal React task/run UI. Phase 5 adds a generic bounded structured-output path: strict pack-declared scalar JSON is parsed only after execution into a normalized run DTO, temporary parser buffers are released after normalization, the result is bound to the same authenticated SSE completion for that run, and raw stdout/stderr remain available with inert React cards for successful parsing. Browser requests and parsed output still cannot choose executable/path/argv authority. Auth execution, secret-bearing structured handling, mutating/destructive execution, persisted run state, and verified Idira/CyberArk workflows do **not** exist yet. Never infer that a planned component is implemented merely because it appears in the specifications.

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

Use for exact executable resolution, explicit path overrides, ambiguity handling, semantic-version parsing/constraints, bounded direct version probes, and discovery state consumed by startup/doctor. Discovery state is not authorization to add undeclared commands.

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
- `internal/planner` and `internal/executor` are source of truth for the implemented low-level read-only execution boundary.
- PRD/spec docs are source of truth for intended behavior not yet implemented.
- `DECISIONS.md` is source of truth for accepted architectural decisions.
- Upstream vendor documentation wins over old assumptions about CLI flags/commands.
- Before adding Idira/CyberArk task definitions, verify exact commands against the deployed tool version.

## Current implementation checkpoint

Phases 1-4 low-level foundations and the generic Phase 5 structured-output foundation are implemented. The runtime keeps `/bootstrap` and `/api/*` server-owned; frontend production assets are embedded in the executable; development frontend traffic is proxied only from an explicitly configured `http://127.0.0.1:<port>` Vite origin; browser launch failure degrades to the explicit short-lived local bootstrap URL.

The pack layer parses bounded UTF-8 YAML, rejects aliases/anchors/merge keys/multiple documents and duplicate mapping keys, validates against the embedded strict v1 JSON Schema, applies cross-reference and execution-shape checks, and produces an effectively immutable deterministic registry. Local loading is explicit, non-recursive, symlink-rejecting, and fail-closed.

The discovery layer resolves declared executable basenames across absolute PATH entries or explicit `pack/tool=/absolute/path` overrides, reports fail-closed discovery states, captures an in-memory executable file identity for ready tools, uses direct bounded version probes, fails closed on ambiguous semantic-version output, and exposes exact diagnostic evidence through `cliharbor doctor`. The synthetic example pack still ships no fixture executable and is not vendor evidence.

The planner accepts only validated pack commands plus current ready discovery state, validates typed runtime values, constructs exact argv, and currently permits read-only/non-auth/non-secret commands only. The executor revalidates executable filesystem identity plus SHA-256 content fingerprint, invokes the executable directly without a shell, bounds output/time, preserves exit semantics, and owns Windows descendants through a per-run Job Object established before the process resumes.

Phase 4b integration coverage uses an explicitly trusted local fixture pack, backend-only executable override, fixed version probe/constraint, typed planner request, and real executor; it compares stdout/stderr/exit behavior to direct invocation and exercises cancellation after observable output.

Phase 4c-A exposes authenticated create/get/cancel run APIs with strict JSON/UTF-8/duplicate-key/body-size validation, existing Host/Origin/CSRF/session protections, Base64 output events in bounded snapshots, bounded concurrency/retention, and application-owned shutdown cancellation.

Phase 4c-B adds `GET /api/v1/runs/{runId}/events` with bounded manager-backed SSE replay, strict `Last-Event-ID` parsing, independent slow-client writes, explicit stream-disconnect/server-shutdown semantics, and bounded browser recovery. `GET /api/v1/tasks` exposes only currently runnable read-only/non-auth/non-secret metadata. The React client keeps CSRF only in runtime memory, derives typed controls from server metadata, streams stdout/stderr as inert text, caps automatic EventSource recovery at five consecutive failures, reconciles retained snapshot output/state, and requires an explicit action for another live-stream attempt.

Local `go-build`/`build` now also emit `bin/SHA256SUMS` for the built executable. CI additionally verifies Go module checksums, audits the locked npm tree, and runs pinned `govulncheck@v1.8.0` as a separate dependency-vulnerability job. The next product milestone is the first verified read-only Idira workflow after Phase 0 inventory. Authentication orchestration and real vendor structured schemas remain subsequent milestones.

Do not begin with marketplace work, universal AI extraction, a cloud backend, an embedded terminal, or guessed Idira/CyberArk commands.
