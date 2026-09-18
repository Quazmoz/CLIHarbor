# CLIHarbor

CLIHarbor is a thin, local browser interface for command-line tools.

The product starts with a concrete internal need: provide a substantially better operator experience for Palo Alto Networks Idira / CyberArk command-line workflows, especially `idsec` and `conjur`, without replacing those CLIs, duplicating their APIs, or becoming a new credential store.

The long-term product is broader: a reusable local UI engine that can expose many existing CLIs through declarative **packs**. Each pack describes commands, parameters, output rendering, safety rules, and authentication behavior. CLIHarbor remains the orchestration and presentation layer; the underlying CLI remains the source of truth.

## Product principles

- **Thin by design.** CLIHarbor invokes installed CLIs rather than reimplementing them.
- **Local-first.** The default server binds only to loopback and the UI runs in the user's browser.
- **No credential vault.** Authentication should remain owned by the wrapped CLI and operating-system facilities whenever possible.
- **No shell-string execution.** Commands are represented as executable + argument arrays and started directly.
- **Useful before generic.** The first real pack will be Idira/CyberArk after deployed command inventory is verified. The generic pack system evolves from real workflows rather than speculative abstraction.
- **Easy to adopt.** A developer should be able to clone the repository, run one development command, and open the UI. A packaged release should be a single local executable where practical.
- **Safe for enterprise use.** Local binding, command allowlists, input validation, output redaction, auditability, and explicit handling of destructive operations are first-class requirements.

## Initial scope

Windows is the first supported platform. Users may normally launch the wrapped tools from PowerShell or CMD, but CLIHarbor should execute the actual program directly (for example `idsec.exe`) rather than launching PowerShell/CMD for ordinary commands.

The first product slice will:

1. Discover supported CLI binaries on `PATH` and/or configured locations.
2. Detect version/capabilities.
3. Present a browser UI for curated Idira/CyberArk workflows.
4. Execute allowlisted commands through a local backend.
5. Stream stdout/stderr and surface exit state.
6. Render structured results as tables/cards when reliable structured output exists; otherwise preserve terminal-style output.
7. Delegate login/session persistence to the official CLI rather than storing passwords or tokens itself.
8. Provide an escape hatch to view the exact executable and argument vector before execution.

## Implementation stack

- **Backend / launcher:** Go
- **Frontend:** React + TypeScript + Vite
- **Distribution target:** frontend embedded into the Go binary
- **Transport:** authenticated loopback HTTP with Server-Sent Events for bounded live run-event streaming
- **Pack format:** versioned YAML (`cliharbor.dev/v1`) validated against the embedded JSON Schema plus deterministic semantic/security checks
- **Discovery/version probes:** direct Go process invocation with pack-authored fixed argv, bounded output, bounded timeout, and semantic-version compatibility checks
- **Task execution:** direct Go `os/exec` using an authoritative executable path plus an exact argument array; ordinary execution never concatenates untrusted input into a shell command

Go is used for the standalone runtime because it produces a small self-contained Windows executable, has strong process/HTTP primitives, is easy to embed into an existing CLI, and keeps the local runtime footprint low. If CLIHarbor is later embedded into an existing internal CLI implemented in another language, the browser and pack contracts should remain portable.

## Current foundation

Phase 1 provides the production local-runtime and browser foundation:

- a `cliharbor` Go command entry point;
- an ephemeral IPv4 loopback listener bound specifically to `127.0.0.1`;
- a short-lived, single-use browser bootstrap token;
- an in-memory HttpOnly, SameSite=Strict browser session;
- exact Host validation plus Origin and CSRF enforcement for state-changing requests;
- a restrictive Content Security Policy and browser hardening headers;
- an authenticated `/api/v1/status` endpoint that exposes only non-secret runtime/session state;
- automatic default-browser launch using a platform-specific boundary, with Windows using native `ShellExecuteW` rather than a shell;
- a React + TypeScript + Vite application shell that loads authenticated runtime status and handles session/API failure states;
- generated Vite assets embedded into the Go executable for production builds;
- an explicit development mode that proxies frontend requests only to an `http://127.0.0.1:<port>` Vite origin while retaining the Go runtime's browser/session origin;
- a Go-based cross-platform task entry point for frontend checks, generated-asset synchronization, tests, and production builds;
- graceful shutdown;
- Windows and Linux CI covering frontend install/typecheck/lint/tests/build, embedded-asset drift, Go format/vet/tests, and a final embedded executable build, plus the Linux race detector.

Phase 2 adds the trusted pack-definition foundation:

- `schemas/pack.v1.schema.json`, embedded into the Go runtime package for structural validation;
- a typed `internal/packs` model for metadata, tools, commands, inputs, constrained argv mappings, output sensitivity, risk, and auth requirement metadata;
- bounded UTF-8 YAML parsing with rejection of aliases, anchors, merge keys, multiple documents, duplicate mapping keys, unsupported tags, excessive depth, and excessive node counts;
- fail-closed rejection of unsupported schema versions, unknown fields, invalid IDs/types/risk values, unresolved tool/input references, unsafe optional argument layouts, browser-selectable execution shapes, and shell/interpreter tool definitions;
- deterministic loading from built-in bytes or explicitly requested local files/directories only;
- local-file symlink/non-regular-file rejection, bounded reads, non-recursive directory loading, duplicate pack detection, and deterministic ordering;
- an effectively immutable registry that returns isolated copies and supports stable pack/tool/command lookup;
- a clearly synthetic `packs/example/pack.yaml` used only as a non-production example; it is not automatically trusted or executed.

Phase 3 adds tool discovery and version compatibility:

- optional pack-declared fixed version probes using the `semver-text` parser and a bounded timeout;
- discovery across absolute `PATH` entries only; relative/current-directory PATH entries are deliberately ignored;
- Windows basename resolution for declared names plus `.exe`/`.com` binary forms without enabling script extensions;
- explicit backend-only `--tool-path pack/tool=/absolute/path` overrides that are authoritative and never supplied by the browser;
- ambiguity detection instead of first-match guessing when multiple executable candidates exist;
- exact resolved executable paths, semantic versions, constraints, and actionable missing/incompatible/probe-failure states;
- bounded direct version-probe execution with no shell and no raw probe output retained in diagnostics;
- fail-closed parsing when version output contains no semantic version or multiple distinct semantic versions;
- startup wiring for explicitly configured packs plus a `cliharbor doctor` diagnostic surface.

Phase 4 adds the low-level secure execution boundary:

- a typed server-side planner that accepts only commands from the validated pack registry and a current `ready` discovery snapshot;
- exact argv construction from typed values, with unknown/missing/wrongly typed inputs, NUL values, and unsafe leading-dash values rejected rather than reinterpreted;
- server-side enforcement of the current read-only envelope: auth-required, secret-bearing, change, destructive, interactive, and credential-sensitive commands remain blocked;
- discovery-time executable file identity carried into each plan and revalidated immediately before execution so a same-path replacement is rejected;
- direct `os/exec` execution with a neutral temporary working directory, generated run IDs, separate stdout/stderr events, bounded output, deadlines, cancellation, non-zero exit preservation, and `exec.Cmd.WaitDelay` protection against inherited output handles;
- a platform lifecycle boundary: Windows starts the target suspended, assigns it to a per-run Job Object configured with kill-on-close, then resumes it so descendants cannot escape before ownership is established; cancellation, timeout, output exhaustion, sink failure, and normal run teardown all close or terminate that boundary;
- regression coverage for argv boundaries, malformed values, executable replacement, spaces/Unicode, cancellation races, setup failure cleanup, and Windows descendant cleanup;
- Phase 4b integration proofs that load explicit trusted synthetic packs through the real loader, resolve distinct tool IDs/version probes through backend-only overrides, build typed plans, execute exact argv, verify stdout/stderr/exit/cancellation fidelity against direct fixture execution, and prove cross-pack command authority remains isolated.

Phase 4c-A exposes that boundary through authenticated loopback JSON APIs for creating, reading, and cancelling runs. The browser can submit only `packId`, `commandId`, and typed `values`; executable paths, executable names, flag names, and argv remain server-owned. Run state is bounded and in-memory, output chunks are returned as Base64 data inside bounded snapshots, duplicate read-only requests create independent server-generated run IDs, and application shutdown cancels active runs. The existing exact Host, session, Origin, and CSRF boundary applies to run mutations.

Phase 4c-B adds authenticated Server-Sent Events at `GET /api/v1/runs/{runId}/events`, bounded replay using `Last-Event-ID`, per-write deadlines, heartbeat frames, and stream disconnect semantics that do not cancel or recreate executions. A read-only `GET /api/v1/tasks` surface exposes only trusted pack metadata for currently runnable read-only/non-auth/non-secret commands; it never exposes executable paths, argv, environment, or pack source paths. The React UI keeps the CSRF token only in runtime memory, derives typed controls from that safe metadata, creates/cancels runs through the existing protected APIs, and renders Base64-decoded stdout/stderr strictly as text.

There is still **no auth-required or secret-bearing execution, mutating/destructive execution, persisted run history, or real Idira/CyberArk command pack**. Phase 0 vendor inventory remains required before any real vendor command definitions are added.

Development targets Go 1.27.1 and Node 24.21.0.

## Development workflow

Install frontend dependencies once after cloning:

```text
npm ci --prefix web
```

Run the production-style embedded application without packs:

```text
go run ./cmd/cliharbor
```

Load an explicitly trusted pack file for discovery:

```text
go run ./cmd/cliharbor --pack-file packs/example/pack.yaml
```

Inspect configured packs/tools without opening the browser:

```text
go run ./cmd/cliharbor doctor --pack-file packs/example/pack.yaml
```

Pin a tool to an explicit absolute path when PATH is missing or ambiguous:

```text
go run ./cmd/cliharbor doctor \
  --pack-file packs/example/pack.yaml \
  --tool-path example/fixture=/absolute/path/to/cliharbor-fixture
```

The synthetic example pack does not ship a fixture executable, so it normally reports the tool as missing unless a compatible fixture is deliberately supplied.

CLIHarbor binds to loopback, generates the one-time bootstrap handoff, and requests the default browser. If browser launch fails, the CLI prints the short-lived local bootstrap URL explicitly so it can be opened manually.

For frontend development, use two terminals:

```text
# terminal 1: Vite, loopback only
go run ./tools/task web-dev

# terminal 2: Go runtime; browser still uses the authenticated Go origin
go run ./cmd/cliharbor --web-dev-url http://127.0.0.1:5173
```

Cross-platform task commands:

```text
# frontend install + typecheck + lint + tests + build, then sync embedded assets
go run ./tools/task web-build

# frontend gates + embedded sync + Go vet/tests
go run ./tools/task check

# build only the embedded Go executable into ./bin
go run ./tools/task go-build

# rebuild frontend, sync assets, then build the executable
go run ./tools/task build
```

When `web/` changes, commit the synchronized generated files under `internal/webui/static/` together with the source change. CI rebuilds the frontend and rejects generated-asset drift.

## Pack and tool trust boundary

Packs are privileged configuration because they define future executable/argument authority. CLIHarbor supports only bytes supplied by trusted built-in application code and local files/directories that a trusted caller explicitly names. It does not scan the current working directory, auto-load `packs/` merely because it exists in a checkout, load remote URLs, download packs, or execute plugin code.

Tool discovery similarly does not let the browser provide executable paths. PATH discovery considers only absolute PATH entries and refuses ambiguity. An explicit `--tool-path` override must reference a tool already declared by an explicitly trusted pack and must resolve to a regular executable whose basename matches that tool declaration.

The repository's example pack is a schema/discovery fixture, not a real Idira/CyberArk pack. Real vendor definitions remain blocked on verified Phase 0 inventory of deployed CLI versions and command trees.

## Development entry points

Read these before implementation:

- [`docs/PRD.md`](docs/PRD.md) — product requirements and acceptance criteria
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and runtime boundaries
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model and security invariants
- [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) — credential/session ownership model
- [`docs/PACK_SPEC.md`](docs/PACK_SPEC.md) — implemented v1 pack contract and future extensions
- [`docs/UX.md`](docs/UX.md) — browser UI and interaction model
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — accepted architectural decisions and supersession rules
- [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) — staged implementation plan
- [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md) — automated/manual verification
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — sequence from Idira-specific MVP to generic platform
- [`docs/RESEARCH.md`](docs/RESEARCH.md) — current ecosystem and upstream CLI notes
- [`AGENTS.md`](AGENTS.md) — repository rules for coding agents

## Upstream Idira/CyberArk notes

As of September 2026, CyberArk's `idsec-cli-golang` repository describes `idsec` as the official CLI for Idira Identity Security Platform operations. Its login flow can prompt for password/MFA and stores access tokens in the computer keystore for their lifetime. CyberArk's current `conjur-cli-go` repository is the Go CLI for Idira Secrets Manager; the older Python `cyberark-conjur-cli` repository is deprecated and archived.

Those properties reinforce CLIHarbor's core boundary: **invoke the official CLI and let it own authentication/session material rather than copying credentials into CLIHarbor.**

## Status

Phases 1-4 now include the secure local browser runtime, trusted versioned pack model/loader, fail-closed tool discovery/version probing with `doctor`, deterministic read-only planning/execution with Windows descendant ownership, a fixture-backed execution proof, Phase 4c-A authenticated create/status/cancel APIs, and Phase 4c-B bounded SSE replay plus a minimal safe task/run UI. The next product milestone is the first verified read-only Idira workflow after Phase 0 vendor inventory; auth orchestration and structured rendering remain later work. Real vendor command definitions remain blocked on verified inventory of the exact deployed CLI versions and command trees.
