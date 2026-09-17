# Agent Index

Use this document as the canonical read order for development agents.

## Current repository state

CLIHarbor has completed the **Phase 1 local-runtime foundation** and the **Phase 2 pack-schema/loader foundation**. The repository now contains a Go command/runtime, IPv4 loopback listener, one-time browser bootstrap/session boundary, Host/Origin/CSRF protections, hardened browser headers, an authenticated status API, graceful shutdown, a React/TypeScript/Vite UI, locally embedded production frontend assets, automatic default-browser launch, a loopback-only frontend development proxy, cross-platform task tooling, Windows/Linux CI, and a versioned trusted-pack model with strict structural/semantic validation and deterministic registry loading.

The pack foundation supports schema version `cliharbor.dev/v1`, built-in pack bytes, and explicitly requested local YAML files/directories. It does not auto-discover repository-local packs, load remote content, execute plugin code, or execute pack commands. Binary discovery, the execution planner/executor, auth adapter, streaming execution, and verified Idira/CyberArk workflows do **not** exist yet. Never infer that a planned component is implemented merely because it appears in the specifications.

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

Use for component boundaries, API shape, execution pipeline, state, streaming, packaging, and extension points.

### Security invariants

Canonical: `SECURITY.md`

Security constraints override convenience-driven interpretations elsewhere. Any feature that weakens a listed invariant requires explicit design review.

### Authentication

Canonical: `AUTHENTICATION.md`

Use for vendor-owned auth/session principles, external terminal login, future PTY considerations, and credential handling.

### Pack/schema design

Canonical: `PACK_SPEC.md`

Use for the implemented v1 declarative model, validation stages, trust model, constrained argument mappings, output metadata, and compatibility rules. The executable schema is `../schemas/pack.v1.schema.json`; code under `../internal/packs/` is source of truth for implemented semantic/security validation.

### User experience

Canonical: `UX.md`

Use for navigation, task forms, run views, auth UX, destructive-action UX, accessibility, and diagnostics.

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
- `schemas/pack.v1.schema.json` plus `internal/packs` are source of truth for the currently supported pack format and semantic validation.
- PRD/spec docs are source of truth for intended behavior not yet implemented.
- `DECISIONS.md` is source of truth for accepted architectural decisions.
- Upstream vendor documentation wins over old assumptions about CLI flags/commands.
- Before adding Idira/CyberArk task definitions, verify exact commands against the deployed tool version.

## Current implementation checkpoint

Phases 1 and 2 are implemented. The runtime keeps `/bootstrap` and `/api/*` server-owned; frontend production assets are embedded in the executable; development frontend traffic is proxied only from an explicitly configured `http://127.0.0.1:<port>` Vite origin; browser launch failure degrades to the explicit short-lived local bootstrap URL.

The pack layer now parses bounded UTF-8 YAML, rejects aliases/anchors/merge keys/multiple documents and duplicate mapping keys, validates against the embedded strict v1 JSON Schema, applies cross-reference and execution-shape semantic checks, and produces an effectively immutable deterministic registry. Local loading is explicit, non-recursive, symlink-rejecting, and fail-closed. The repository includes only a synthetic example pack; it is not a verified vendor pack and is not automatically granted execution authority.

The next bounded implementation milestone is Phase 3: tool discovery and version probing over already-validated pack tool metadata. Phase 0 vendor inventory still blocks hard-coded Idira/CyberArk command definitions.

Do not begin with marketplace work, universal AI extraction, a cloud backend, an embedded terminal, pack execution, or guessed Idira/CyberArk commands.
