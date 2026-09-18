# Architecture Decision Record Index

This file records decisions already made during product discovery so future agents do not accidentally reverse them without evidence.

## ADR-001 — Local browser app instead of desktop shell

**Status:** Accepted.

**Decision:** CLIHarbor runs a local backend and serves a browser UI over loopback rather than using Electron/Tauri as the primary architecture.

**Why:** The desired company adoption flow is “pull/run the repo or invoke a subcommand, then use the browser.” It also makes embedding into an existing company CLI straightforward and avoids shipping a separate desktop runtime.

**Consequences:** Browser/local-server security must be treated seriously. We need loopback binding, secure bootstrap/session handling, origin/host checks, and XSS-safe rendering.

## ADR-002 — Direct executable invocation, not PowerShell/CMD for normal commands

**Status:** Accepted.

**Decision:** If a user normally types `idsec ...` in PowerShell, CLIHarbor resolves `idsec.exe` and launches it directly with an argument vector.

**Why:** PowerShell is usually only locating/starting the binary. Direct invocation reduces quoting ambiguity and shell-injection exposure.

**Exception:** PowerShell/CMD may be used only when the task intentionally targets a script/shell behavior and the pack/security review explicitly allows it.

## ADR-003 — Vendor CLI remains source of truth

**Status:** Accepted.

**Decision:** CLIHarbor wraps the official CLI rather than reimplementing vendor REST APIs for the MVP.

**Why:** It minimizes code, preserves existing auth/profile semantics, lowers approval burden, and keeps the product thin.

## ADR-004 — Authentication delegated to wrapped CLI

**Status:** Accepted.

**Decision:** MVP does not provide its own username/password storage or token cache. Login is vendor-owned.

**Why:** `idsec` already supports interactive auth and OS-keystore token storage. Rebuilding this increases risk without adding core product value.

## ADR-005 — External interactive login before embedded PTY

**Status:** Accepted.

**Decision:** When login needs terminal interaction, launch/attach to the vendor CLI through an external terminal first. Embedded PTY is deferred.

**Why:** It is the smallest secure implementation and avoids secret input/terminal-emulation complexity.

## ADR-006 — Idira/CyberArk first, generic engine underneath

**Status:** Accepted.

**Decision:** Build the first real pack for the concrete internal Idira/CyberArk need. Do not try to support every CLI on day one.

**Why:** This guarantees utility even if broader market adoption never occurs and lets real workflows shape the abstraction.

## ADR-007 — Curated packs before automatic CLI interpretation

**Status:** Accepted.

**Decision:** Runtime behavior is defined by reviewed packs. Automatic `--help`/AI extraction may later help authors draft packs but will not make live production execution decisions.

**Why:** Existing projects such as instagui already pursue automatic extraction. CLIHarbor's differentiation is correctness/security/enterprise trust, not maximal zero-config coverage.

## ADR-008 — Windows first

**Status:** Accepted.

**Decision:** Windows is the first supported platform.

**Why:** It matches the initial environment and keeps early process/auth/browser integration focused.

**Consequence:** Core data models should remain portable, but platform-specific execution/cancellation code may live behind explicit interfaces.

## ADR-009 — Go backend + React/TypeScript frontend

**Status:** Accepted as initial implementation default.

**Decision:** Use Go for the local runtime and React + TypeScript + Vite for the browser UI.

**Why:** Go supports a small self-contained executable, easy static asset embedding, solid Windows process/HTTP support, and future embedding/companion-binary use with an internal CLI.

**Revisit condition:** If the existing company CLI's architecture makes a different implementation materially simpler, preserve the browser/pack/execution contracts while reassessing language choice.

## ADR-010 — No arbitrary shell endpoint

**Status:** Accepted / security invariant.

**Decision:** Browser requests identify pack tasks and typed fields. There is no endpoint that accepts a free-form executable or command string.

**Why:** CLIHarbor should be a safe action/workflow layer, not a browser-exposed shell.

## ADR-011 — Single executable release target

**Status:** Accepted as packaging objective.

**Decision:** Release builds should embed the web frontend into the local runtime where practical.

**Why:** Simplifies enterprise adoption and reduces runtime dependencies. Development may still use Node/Vite tooling.

## ADR-012 — Structured output preferred, raw output preserved

**Status:** Accepted.

**Decision:** Use vendor machine-readable output where reliable, but always preserve raw output as fallback and evidence.

**Why:** Parsed tables improve UX; vendor version changes can break parsers. Silent parser failure must not create false data.

## ADR-013 — Packs are privileged configuration

**Status:** Accepted.

**Decision:** Pack loading is trusted/reviewed and schema validated. Arbitrary remote pack installation is deferred until a signature/trust model exists.

**Why:** Packs control what executables/arguments CLIHarbor may run.

## ADR-014 — Structured output is bounded declarative post-processing

**Status:** Accepted.

**Decision:** A trusted pack may declare only a bounded top-level JSON object composed of named scalar fields for structured browser rendering. Parsing runs after the single authoritative executor invocation, produces a normalized DTO, never feeds execution, and always leaves raw stdout/stderr and run/exit state available. Secret-bearing output and sensitive structured fields are refused in this phase.

**Why:** This improves operator readability without introducing a scripting/template/plugin surface, without allowing CLI output to become command authority, and without creating a second source of truth for process success.

**Security/reliability implications:** Parser bytes, fields, strings, nesting shape, UTF-8, duplicate keys, unknown fields, integer range, and control characters are fail-closed. A non-zero exit cannot be promoted into structured success. Browser rendering uses inert text only.

**Revisit when:** A verified vendor workflow requires nested collections, tables, or secret-aware structured handling that cannot be represented safely by the scalar-card contract.

## How to supersede a decision

Do not silently change an accepted ADR. Add a new ADR section with:

- the old decision being superseded;
- new evidence/requirement;
- security impact;
- migration impact;
- updated docs/tests required.

## ADR-015 — Phase 0 evidence is CLI-only, fixed, bounded, and exportable

**Status:** Accepted.

**Decision:** Work-laptop inventory and Phase 0 help/version evidence collection live on the operator CLI surface, not the browser API. A probe is selectable only by `pack/tool/probe`; executable path and argv come exclusively from validated trusted pack/discovery state. Evidence exports use a strongly typed, bounded, sanitized schema and atomic non-overwriting creation.

**Why:** The first real integration needs factual data from the company-installed CLI versions without turning CLIHarbor into a diagnostic shell or exposing executable authority to browser input.

**Security/reliability implications:** No arbitrary executable/argv input, no shell, no interactive stdin, neutral temporary working directory, minimal child environment, executable identity revalidation, bounded timeout/output, shared platform process-tree ownership (including Windows Job Objects), conservative redaction, no credential-store/environment enumeration, and no browser/session secrets in evidence. Exported probe provenance includes only sanitized fixed argv from trusted declarations; evidence activation is atomic and no-clobber. Discovery-time version probes fail closed on truncated/invalid-UTF-8 output. Raw vendor prose still requires operator review before external sharing because generic redaction cannot prove organization-specific text is non-sensitive.

**Revisit when:** A verified workflow requires a probe that cannot be represented as fixed read-only argv, or evidence requirements exceed the bounded Phase 0 schema.

## ADR-016 — Unsigned CI artifact for controlled work-laptop evaluation

**Status:** Accepted for the evaluation milestone.

**Decision:** CI may produce an unsigned Windows x64 evaluation executable after the normal quality/security gates, without publishing a GitHub Release or claiming code signing.

**Why:** The immediate need is controlled first-environment validation, not public distribution or installer deployment.

**Security/reliability implications:** Application-control policy is an environmental prerequisite. CLIHarbor must not bypass WDAC/AppLocker/SmartScreen/EDR. A blocked unsigned executable requires the organization's approved signing/allowlisting process.

**Revisit when:** Wider enterprise distribution, persistent installation, or production release requires signing/provenance policy.

## ADR-017 — Phase 0 evidence import is inert review, never command authority

**Status:** Accepted.

**Decision:** CLIHarbor may strictly ingest `cliharbor.phase0/v1` files through an operator-only `evidence inspect` command, but imported evidence is permanently inert. The importer validates bounded structure, identity, provenance, state/timestamp consistency, and sanitization before rendering a deterministic review. It has no path into pack loading, command planning, browser APIs, or process execution.

**Why:** Work-laptop evidence needs a safe engineering review gate before it can inform a real vendor pack. Treating arbitrary captured text as an executable definition would collapse the trust boundary created by the Phase 0 collector.

**Security/reliability implications:** Evidence files are untrusted, symlinks/non-regular files and observed read races fail closed, malformed/duplicate/unknown data is rejected, and sensitive/path-like material excluded by the schema cannot silently re-enter through import. Successful validation does not establish freshness or vendor semantics beyond the captured observations.

**Revisit when:** A signed/attested evidence format or organization-approved promotion workflow exists and has an explicit authority model. Even then, model-generated or arbitrary captured text must not gain command authority implicitly.
