# Architecture

## 1. Architecture objective

CLIHarbor is a thin local application. The browser is presentation only; the local Go runtime owns trusted pack loading, executable discovery, version compatibility, execution planning/process lifecycle, future redaction, and browser-session security. The wrapped CLI remains the operational authority.

```text
Browser UI
   |
   | authenticated loopback HTTP + bounded SSE events
   v
CLIHarbor local runtime
   |- pack loader / schema validator       [implemented]
   |- tool discovery / version probe       [implemented]
   |- command planner / validation          [implemented: read-only browser boundary]
   |- process executor                      [implemented: bounded read-only runs]
   |- auth state adapter                    [planned]
   |- output parsers / redaction            [planned]
   |- run manager / event replay              [implemented: bounded in-memory]
   v
Approved local CLI binary (idsec.exe, conjur.exe, ...)
   |
   v
Vendor service / existing auth/session model
```

## 2. Deployment model

### MVP

One local executable starts a loopback server, serves embedded frontend assets, and opens the default browser. Approved read-only tasks are exposed only through authenticated server-owned task/run APIs; the browser supplies typed values while executable, argv, lifecycle, and replay authority remain in the Go runtime.

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
internal/planner/          # typed input -> immutable read-only execution plan
internal/executor/         # direct process start/stream/cancel/timeout/lifecycle
internal/runs/             # bounded in-memory run ownership/state/events
internal/auth/             # planned auth adapters/login orchestration
internal/output/           # planned parsers/structured rendering models
internal/redact/           # planned secret-safe diagnostics/invocation views
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
5. Build an in-memory discovery snapshot with exact resolved path/version/status and an opaque discovery-time executable file identity for each ready tool.
6. Bind an ephemeral IPv4 loopback port.
7. Generate per-launch bootstrap, session, and CSRF secrets.
8. Start HTTP server and open the one-time browser bootstrap URL.
9. Exchange bootstrap secret for the in-memory browser session and redirect to a clean URL.
10. Serve until shutdown.

`cliharbor doctor` performs steps 1-5 without opening a browser and emits the current pack/tool evidence.

Unavailable tools do not make the browser shell itself unsafe to start; they remain unavailable discovery states and later planning must refuse them.

## 6. Browser/API contract

Implemented HTTP surface now includes:

```text
GET  /bootstrap?token=<one-time-secret>
GET  /api/v1/status
GET  /api/v1/tasks
GET  /api/v1/tools
POST /api/v1/runs
GET  /api/v1/runs/{runId}
GET  /api/v1/runs/{runId}/events
POST /api/v1/runs/{runId}/cancel
GET  /
GET  /assets/*
```

`/bootstrap` and `/api/*` are server-owned and never fall through to frontend routing. Authenticated status returns the per-session CSRF token used by same-origin browser mutations. Task metadata exposes only currently runnable read-only/non-auth/non-secret commands and typed input constraints. Tool diagnostics expose only pack/tool IDs, pack name/version, readiness status, detected version/constraint, and sanitized remediation text. Neither surface exposes executable paths/names, candidate lists, file identity, argv, environment, or pack source paths. Run creation accepts only `packId`, `commandId`, and typed `values`; unknown/duplicate authority fields fail closed. Run-event streaming is read-only and authenticated; `Last-Event-ID` is the only replay cursor.

Planned surface still includes:

```text
GET  /api/v1/packs
GET  /api/v1/tasks/{taskId}
POST /api/v1/auth/{tool}/login
POST /api/v1/auth/{tool}/logout
GET  /api/v1/auth/{tool}/status
```

`cliharbor doctor` remains the operator surface for exact resolved filesystem evidence. The browser receives only sanitized tool status/remediation and still cannot choose or observe executable paths, candidate paths, flags, or command strings.

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
identity-failed
unsupported-platform
```

Only `ready` may become executable authority. A ready state also carries the in-memory executable identity required by the planner.

### Executable identity boundary

Discovery records an in-memory identity for the selected regular file. The planner requires that identity, and the executor revalidates it immediately before process creation using filesystem identity, size/modification metadata, and a SHA-256 content fingerprint. Same-path replacement or same-size content mutation after discovery therefore fails closed.

The content fingerprint detects replacement; it is not a trusted publisher allowlist or code-signing assertion. Enterprise publisher/signature or policy-managed expected-hash verification remains a future hardening option where policy requires it.

## 9. Execution planning — implemented low-level boundary

The planner accepts the validated registry, authoritative discovery snapshot, pack/command IDs, and typed runtime values. It:

- requires a current `ready` tool state whose pack version matches the configured pack;
- requires the discovery-time executable identity;
- validates exact runtime JSON types and pack constraints server-side;
- rejects unknown/missing/null/malformed values and unsafe NUL/leading-dash strings;
- produces only the pack-declared literal/flag/switch/map argv structure;
- sources executable path/name/version/identity solely from discovery;
- currently permits only `risk: read` commands;
- rejects auth-required and secret-bearing commands until those policy boundaries exist.

The resulting `planner.Plan` is consumed internally; browser input cannot provide executable paths, executable names, flag names, or arbitrary argv structure.

## 10. Process invocation and lifecycle — implemented low-level boundary

The executor invokes the planned executable directly with `os/exec` and an argument slice. It does not invoke CMD, PowerShell, or a POSIX shell for ordinary task execution.

Before process creation it revalidates the plan's executable identity. Each run receives a generated run ID and a neutral temporary working directory. Stdout and stderr remain separate, are emitted in bounded chunks, and each stream has a total byte limit. `exec.Cmd.WaitDelay` prevents inherited stdout/stderr handles from keeping a completed root process wait open indefinitely.

Cancellation sources—caller cancellation, timeout, output exhaustion, and event-sink failure—share one lifecycle cancellation path. Non-zero process exits remain normal exited results with the vendor exit code rather than being collapsed into executor failures.

On Windows, each run creates a native Job Object with kill-on-close semantics. CLIHarbor starts the target with `CREATE_SUSPENDED`, assigns the process to the run's Job Object before allowing user code to execute, then resumes the initial thread. Descendants therefore inherit the run boundary by default. Cancellation/timeout terminates the Job Object, and closing the Job Object after normal root completion also prevents leftover descendants from outliving the run. A synchronization handle to the root process avoids reclassifying a natural exit as a timeout when those events race.

Non-Windows platforms use the same executor contract behind a platform file boundary and currently cancel the direct process. This Phase 4 slice does not claim non-Windows descendant-tree ownership.

## 11. Internal execution events

The executor currently emits:

```text
run.started
stdout.chunk
stderr.chunk
run.exited
run.cancelled
run.timed-out
run.failed
```

These events are retained only in the bounded in-memory run manager; there is no persisted run store. Phase 4c-A exposes them through authenticated run snapshots. Phase 4c-B also exposes manager-backed SSE replay. Sequence numbers are monotonic per run, `Last-Event-ID` resumes strictly after an observed sequence, impossible cursors fail closed, and completion is emitted from authoritative manager state even when an executor terminal event could not be retained.

Phase 4b now proves the production authority chain end to end with purpose-built fixtures: explicit-local trusted pack loading → schema/semantic validation → registry → discovery with backend-only overrides → fixed version probes/constraints → typed planner → executor → bounded events/result. A second independent fixture pack/tool uses a distinct tool ID, semantic version, command shape, and input mapping while sharing no command authority with the first pack; both execute through unchanged core code.

Phase 4c-A exposes only this proven read-only path through authenticated loopback create/get/cancel APIs. The run manager defaults to bounded active and retained run counts, bounded output/event memory, finite execution timeout, server-generated run IDs, and root-context cancellation. Request disconnect after a successful create does not implicitly kill the run; explicit cancellation or application shutdown owns termination.

Phase 4c-B observes that same bounded manager state through SSE rather than connecting executor sinks to HTTP writers. Streams share a per-run change signal, do not allocate per-client output queues, never hold the manager lock during network writes, and do not cancel or recreate execution on disconnect/reconnect. Long-lived stream handlers are themselves bounded (default 16); excess streams fail fast with `429 stream_capacity` without affecting run execution. The ordinary server write timeout is disabled only for the long-lived stream, while each write/flush receives its own finite deadline and periodic heartbeat. The React task/run UI consumes only safe server metadata and renders process output as untrusted text.

The next architecture boundary is the first verified read-only Idira workflow after Phase 0 vendor inventory, followed by vendor-owned authentication orchestration and structured result parsing.

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
- discovery snapshot, including opaque executable identities for ready tools;
- bounded in-memory run records, event buffers, monotonic event sequence, cancellation handles, and completion state;
- transient planner plans/executor process state while execution is active;
- browser bootstrap/session state and per-session CSRF secret.

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
- planner exact argv construction and the current read-only/auth/output policy envelope remain regression-tested;
- Windows task execution owns descendants with a per-run Job Object and must remain regression-tested;
- output is bounded and browser-rendered as inert text; future structured parsers/redaction must preserve raw non-secret evidence on parser failure;
- a second fixture pack/tool proves discovery/planner/executor are not Idira-specific;
- real Idira/CyberArk definitions come only from verified Phase 0 inventory.
