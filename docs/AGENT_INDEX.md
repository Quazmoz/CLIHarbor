# Agent Index

Use this document as the canonical read order for development agents.

## Current repository state

CLIHarbor is in the **foundation implementation stage**. The first security-sensitive runtime slice now exists: a Go command entry point, IPv4 loopback listener, one-time browser bootstrap/session boundary, Host/Origin/CSRF protections, security headers, authenticated status endpoint, graceful shutdown, tests, and Windows/Linux CI.

The React/Vite frontend, browser auto-open, pack loader/schema, binary discovery, planner/executor, auth adapter, streaming, and verified Idira/CyberArk workflows do **not** exist yet. Never infer that a planned component is implemented merely because it appears in the specifications.

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

Use for declarative tool/task definitions, argument construction, risk metadata, outputs, auth references, and compatibility.

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
- PRD/spec docs are source of truth for intended behavior.
- `DECISIONS.md` is source of truth for accepted architectural decisions.
- Upstream vendor documentation wins over old assumptions about CLI flags/commands.
- Before adding Idira/CyberArk task definitions, verify exact commands against the deployed tool version.

## Current implementation checkpoint

The first part of Phase 1 is implemented: the secure loopback/session boundary and lifecycle foundation.

The next bounded implementation work should finish Phase 1 by adding the React/Vite development surface, safe browser auto-open, and Windows runtime verification without weakening the existing session boundary. Phase 0 vendor inventory still blocks hard-coded Idira/CyberArk task definitions. After Phase 1, proceed to the versioned pack schema/loader described in `DEVELOPMENT_PLAN.md`.

Do not begin with marketplace work, universal AI extraction, a cloud backend, an embedded terminal, or guessed Idira/CyberArk commands.
