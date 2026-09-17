# Architecture

## 1. Architecture objective

CLIHarbor is a thin local application. The browser is presentation only; the local Go runtime owns trusted pack loading, executable discovery, version compatibility, future execution planning/process lifecycle, redaction, and browser-session security. The wrapped CLI remains the operational authority.

```text
Browser UI
   |
   | loopback HTTP + future streaming events
   v
CLIHarbor local runtime
   |- pack loader / schema validator       [implemented]
   |- tool discovery / version probe       [implemented]
   |- command planner / validation          [next]
   |- process executor                      [planned]
   |- auth state adapter                    [planned]
   |- output parsers / redaction            [planned]
   |- run metadata                          [planned]
   v
Approved local CLI binary (idsec.exe, conjur.exe, ...)
   |
   v
Vendor service / existing auth/session model
```

## 2. Deployment model

### MVP

One local executable starts a loopback server, serves embedded frontend assets, opens the default browser, and will execute approved local CLI processes as the current user once the planner/executor milestone is complete.

No daemon, Windows service, cloud server, external database, or privileged helper is required.

### Future embedded mode

The same runtime should be embeddable or launchable from an existing internal CLI, for example:

```text
company-cli ui
```

The browser, pack, discovery, and execution contracts must not depend on whether the runtime is standalone or embedded.

## 3. Technology choices

### Backend: Go

Go provides self-contained Windows binaries, standard-library HTTP/process primitives, `embed`, low runtime overhead, and a portable core with narrow platform boundaries.

### Frontend: React + TypeScript + Vite

The production frontend is static and embedded in the Go executable. It has no direct process/filesystem authority. Development Vite traffic is proxied through the authenticated Go origin and is restricted to an explicit loopback target.

### Packs: YAML + JSON Schema

`schemas/pack.v1.schema.json` is the implemented Draft 2020-12 structural contract for `cliharbor.dev/v1`. `internal/packs` adds hardened YAML parsing, semantic/security validation, explicit trusted-source loading, and an effectively immutable registry.

### Version compatibility: semantic versions

Phase 3 uses `github.com/Masterminds/semver/v3` for validated tool constraints. A pack may define only a fixed `semver-text` probe. The runtime does not infer arbitrary probe commands.

## 4. Backend package boundaries

```text
cmd/cliharbor/             # process entry point + serve/doctor CLI parsing
internal/app/              # application lifecycle / runtime wiring / doctor
internal/server/           # loopback HTTP, browser bootstrap, origin/session checks
internal/webui/            # embedded frontend + constrained dev reverse proxy
internal/platform/browser/ # platform default-browser launch boundary
internal/packs/            # pack model/validation/loading/registry
internal/discovery/        # executable resolution/version probes/discovery snapshot
internal/planner/          # NEXT: typed input -> immutable execution plan
internal/executor/         # planned process start/stream/cancel/timeout
internal/auth/             # planned auth adapters/login orchestration
internal/output/           # planned parsers/structured rendering models
internal/redact/           # planned secret-safe diagnostics/invocation views
internal/runs/             # planned run state/metadata
tools/task/                # cross-platform repository validation/build entry point
web/                       # React source
packs/                     # fixtures/built-in pack sources; never cwd auto-trusted
schemas/                   # embedded pack schemas
```

Vendor-specific behavior belongs in a verified pack or narrowly-scoped adapter, not generic discovery/planner/executor packages.

## 5. Runtime lifecycle

Current serve lifecycle:

1. Parse CLIHarbor flags.
2. Load only explicitly configured pack files/directories; no cwd/repository scan.
3. Validate pack syntax/schema/semantics and create the registry.
4. Resolve each declared tool and, when configured, run its fixed bounded version probe.
5. Build an in-memory discovery snapshot with exact resolved path/version/status.
6. Bind an ephemeral IPv4 loopback port.
7. Generate per-launch bootstrap, session, and CSRF secrets.
8. Start HTTP server and open the one-time browser bootstrap URL.
9. Exchange bootstrap secret for the in-memory browser session and redirect to a clean URL.
10. Serve until shutdown.

`cliharbor doctor` performs steps 1-5 without opening a browser and emits the current pack/tool evidence.

Unavailable tools do not make the browser shell itself unsafe to start; they remain unavailable discovery states and later planning must refuse them.

## 6. Browser/API contract

Implemented HTTP surface remains:

```text
GET  /bootstrap?token=<one-time-secret>
GET  /api/v1/status
GET  /
GET  /assets/*
```

`/bootstrap` and `/api/*` are server-owned and never fall through to frontend routing.

Planned surface includes:

```text
GET  /api/v1/packs
GET  /api/v1/tools
GET  /api/v1/tasks
GET  /api/v1/tasks/{taskId}
POST /api/v1/runs
GET  /api/v1/runs/{runId}
POST /api/v1/runs/{runId}/cancel
GET  /api/v1/runs/{runId}/events
POST /api/v1/auth/{tool}/login
POST /api/v1/auth/{tool}/logout
GET  /api/v1/auth/{tool}/status
```

Phase 3 intentionally exposes tool evidence through `doctor`, not new browser endpoints. The browser still cannot choose executable names/paths, flags, or command strings.

## 7. Pack authority

The pack path is:

```text
explicit trusted source
  -> bounded UTF-8 + hardened single-document YAML
  -> supported apiVersion
  -> embedded JSON Schema
  -> deterministic semantic/security validation
  -> deep-copied Registry
```

The registry has deterministic ordering/lookups and returns deep copies, including version-probe argv. There is no global mutable registry.

The v1 task argv model admits trusted literals, fixed named flags fed by typed inputs, boolean switches, and enum-to-pack-literal maps. It does not admit executable selection, shell strings, generic interpolation, or free-form positional user input.

## 8. Tool discovery and version compatibility

Discovery consumes only already-validated `Registry` tool metadata.

### PATH search

- only absolute PATH directory entries are considered;
- empty/relative/current-directory entries are ignored;
- candidates must be regular files; non-Windows candidates must have an executable mode bit;
- symlinks are resolved to an exact absolute target path;
- on Windows an extensionless declaration may resolve to the exact name, `.exe`, or `.com`; script extensions are not considered;
- candidates are de-duplicated and sorted deterministically;
- zero matches => `missing`;
- one match => selected;
- multiple matches => `ambiguous`; no first-hit guessing.

### Explicit path override

Operators may supply:

```text
--tool-path pack/tool=/absolute/path
```

The reference must name a tool in the configured registry. The path must be absolute and resolve to a regular executable whose basename matches the pack allowlist. An invalid override is authoritative and does not fall back to PATH.

This is backend/operator configuration; it is not browser input.

### Version probe

A pack may define fixed probe argv plus `semver-text` parser and bounded timeout. `ExecProbeRunner` invokes the already-selected executable directly with `exec.CommandContext`; no shell is used. Stdout/stderr are separately bounded. Raw probe text is not retained in the discovery snapshot or normal diagnostics.

The parser accepts exactly one distinct strict semantic version from probe text. No version or multiple distinct versions yields `probe-failed`. A parsed version that does not satisfy `versionConstraint` yields `incompatible`.

Current states are:

```text
ready
missing
ambiguous
incompatible
probe-failed
invalid-override
unsupported-platform
```

Only `ready` may become executable authority in Phase 4.

### Identity limitation

Phase 3 proves path/name/version compatibility, not cryptographic publisher identity. Enterprise publisher/signature/hash verification is a future hardening option. Phase 4 must also address discovery-to-execution drift by revalidating executable identity at the execution boundary where practical.

## 9. Execution planning — next

The planner will accept a validated registry, a discovery snapshot, a task ID, and typed browser values. It must:

- require the referenced tool discovery state to be `ready`;
- validate all runtime values server-side against pack constraints;
- reject unknown fields/inputs;
- produce only the pack-declared argv structure;
- source executable path solely from discovery, never browser input;
- enforce risk/confirmation policy;
- emit an immutable `ExecutionPlan`.

Conceptually:

```text
runID
packID/version
commandID
toolID
resolvedExecutablePath
args[]
riskClass
redaction metadata
timeout policy
output mode
```

The executor will accept only a validated plan and must not reinterpret browser input.

## 10. Process invocation

Version probes already use direct process creation with an executable path plus argv.

Future task execution must likewise use the equivalent of:

```go
exec.CommandContext(ctx, executablePath, args...)
```

Never translate a normal task into a shell command string. On Windows, task cancellation must handle descendant processes; a Job Object or equivalent should be evaluated.

## 11. Streaming and output

Future executor events should normalize at least:

```text
run.started
stdout.chunk
stderr.chunk
structured.result
warning
run.exited
run.cancelled
run.failed
```

SSE is preferred while communication is primarily server -> browser. Output buffering/backpressure must be bounded.

Prefer documented structured output, but preserve faithful raw output and surface parser failure rather than fabricating empty structured data.

## 12. Authentication

Authentication remains vendor-owned. CLIHarbor may later query documented status, invoke login/logout, or launch an external interactive terminal, but it must not persist passwords/MFA values/tokens or read vendor keystores merely for convenience.

Pack v1 currently contains only `requirements.requiresAuth`; no credential values or auth scripts exist.

## 13. Trust model

Packs are privileged configuration. Validation proves shape/invariants; it does not confer trust.

Supported pack source classes:

- `builtin`: bytes supplied by trusted application code;
- `explicit-local`: file/directory explicitly named by the trusted caller.

Explicit directories are non-recursive; pack symlinks/non-regular YAML entries are rejected; reads are bounded. Remote loading, pack downloads, cwd scanning, plugin execution, and marketplace behavior are out of scope.

Tool discovery does not widen that trust boundary: it operates only after explicit pack loading, and explicit path overrides must name a declared pack/tool.

## 14. State and persistence

No database is required for MVP.

Current authoritative runtime state is in memory:

- validated pack registry;
- discovery snapshot;
- browser bootstrap/session state.

Future non-secret local config may hold explicitly approved pack/binary paths and UI preferences. Future run history must be redacted and bounded. Never persist credential material.

## 15. Browser launch/frontend serving

Production uses the OS default browser, not bundled Chromium. Windows uses native `ShellExecuteW`; Linux/macOS use fixed executable + argument invocation. Successful launch does not print the bootstrap token; fallback prints the short-lived local URL only when automatic launch fails.

Production Vite assets are embedded. Development proxy targets must be explicit `http://127.0.0.1:<port>` origins; CLIHarbor strips session/auth/CSRF headers before proxying and drops development `Set-Cookie` responses.

## 16. Extensibility

Add code adapters only where a CLI cannot safely fit the declarative model, such as nontrivial auth-state detection or complex output parsing. Adapters require narrow interfaces and tests and must not become unrestricted execution hooks.

## 17. Architecture quality gates

Before MVP architecture is complete:

- browser cannot choose arbitrary executable/path/shell command;
- loopback/session/origin/CSRF controls remain tested;
- packs must be explicitly trusted and validated;
- ambiguous/missing/incompatible/probe-failed tools cannot execute;
- planner must prove exact argv construction and risk enforcement;
- task execution/cancellation must work reliably on Windows;
- output is bounded/redacted/escaped and parser failures preserve raw evidence;
- a second fixture pack/tool proves discovery/planner/executor are not Idira-specific;
- real Idira/CyberArk definitions come only from verified Phase 0 inventory.
