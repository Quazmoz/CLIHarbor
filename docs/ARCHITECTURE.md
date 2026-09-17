# Architecture

## 1. Architecture objective

CLIHarbor should remain a thin local application. The browser is presentation only; a small local runtime owns binary discovery, pack validation, process execution, streaming, redaction, and lifecycle.

The core architectural constraint is that the wrapped CLI remains the operational authority.

```text
Browser UI
   |
   | loopback HTTP + streaming events
   v
CLIHarbor local runtime
   |- pack loader / schema validator       [foundation implemented]
   |- tool discovery / version probe       [planned]
   |- command planner / validation          [planned]
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

One local executable starts a loopback server, serves embedded frontend assets, opens the user's default browser, and will execute approved local CLI processes as the current user once the planner/executor milestones are implemented.

No daemon, Windows service, cloud server, external database, or privileged helper is required.

### Future embedded mode

The runtime should be structured so an existing internal company CLI can expose the same application as a subcommand, for example:

```text
company-cli ui
```

The browser/frontend contract should not depend on whether the runtime is standalone or embedded.

## 3. Technology choices

### Backend: Go

Initial default because it offers:

- self-contained Windows binaries;
- strong standard-library HTTP/process primitives;
- straightforward `embed` support for frontend assets and schemas;
- low runtime overhead;
- good fit for adding a subcommand to another CLI or shipping a companion binary;
- cross-platform portability later.

### Frontend: React + TypeScript + Vite

The frontend is static after production build and is embedded into the Go executable. It contains no privileged logic or direct filesystem/process access.

Development uses a loopback-only Vite server behind an explicit Go reverse-proxy mode so the browser still talks to CLIHarbor's authenticated origin.

### Packs: YAML + JSON Schema

Human-authored YAML is used for trusted command definitions. `schemas/pack.v1.schema.json` is the implemented Draft 2020-12 structural contract for `cliharbor.dev/v1`; `internal/packs` adds YAML hardening, semantic/security validation, trusted-source loading, and the runtime registry.

YAML validation is deliberately stricter than generic YAML parsing: aliases/anchors/merge keys/custom tags/multiple documents/duplicate keys are rejected, and size/depth/node-count limits are applied before a pack can become authoritative.

## 4. Backend package boundaries

Current/planned Go module layout:

```text
cmd/cliharbor/             # process entry point
internal/app/              # application lifecycle / dependency wiring
internal/server/           # HTTP routes, browser bootstrap, origin checks
internal/webui/            # embedded frontend + constrained dev reverse proxy
internal/platform/browser/ # platform default-browser launch boundary
internal/packs/            # IMPLEMENTED: pack model/validation/loading/registry
internal/discovery/        # planned: PATH lookup, configured binary paths, version probes
internal/planner/          # planned: form input -> validated execution plan
internal/executor/         # planned: process start/stream/cancel/timeout
internal/auth/             # planned: auth-state adapters and login launch orchestration
internal/output/           # planned: parsers, structured rendering models
internal/redact/           # planned: secret-safe diagnostics and invocation views
internal/runs/             # planned: run state and metadata
tools/task/                # cross-platform repository build/validation entry point
web/                       # React application source
packs/                     # pack fixtures/built-in pack sources; no cwd auto-trust
schemas/                   # IMPLEMENTED: embedded pack schema(s)
```

Avoid placing vendor-specific behavior in generic packages. Idira/CyberArk-specific logic belongs in a verified pack or a narrowly-scoped adapter.

## 5. Server lifecycle

Target lifecycle:

1. Parse CLIHarbor's own flags.
2. Select explicitly trusted pack sources and load them.
3. Validate pack schemas/semantics/compatibility metadata.
4. Resolve required executables and probe versions.
5. Bind an ephemeral port on loopback.
6. Generate unpredictable per-launch bootstrap, session, and CSRF secrets.
7. Start HTTP server.
8. Open browser to the one-time bootstrap URL.
9. Exchange the bootstrap secret for an HttpOnly, SameSite=Strict, host-only session cookie.
10. Redirect immediately to `/` so the bootstrap token is removed from the navigable URL/history.
11. Serve UI/API until shutdown.

Phase 1 implements steps 1 and 5-11. Phase 2 implements the pack component required by steps 2-3, but it is deliberately not auto-wired to repository-local files or command execution. A trusted caller can load built-in bytes or explicitly named local files/directories into a validated registry. Startup integration should occur when the application has an explicit pack-source configuration contract; launching CLIHarbor from a checkout must never silently grant that checkout execution authority.

The runtime binds specifically to IPv4 loopback (`127.0.0.1`) today. Do not bind `0.0.0.0` by default.

## 6. Browser/API contract

Implemented Phase 1 surface:

```text
GET  /bootstrap?token=<one-time-secret>
GET  /api/v1/status
GET  /
GET  /assets/*
```

`/bootstrap` and `/api/*` are server-owned routes and take precedence over frontend handling. Unknown `/api/*` requests remain behind the browser-session boundary and return not found rather than falling through to frontend routing.

Planned API surface:

```text
GET  /api/v1/packs
GET  /api/v1/tools
GET  /api/v1/tasks
GET  /api/v1/tasks/{taskId}
POST /api/v1/runs
GET  /api/v1/runs/{runId}
POST /api/v1/runs/{runId}/cancel
GET  /api/v1/runs/{runId}/events   # SSE or WS
POST /api/v1/auth/{tool}/login
POST /api/v1/auth/{tool}/logout
GET  /api/v1/auth/{tool}/status
```

Phase 2 does not expose pack HTTP endpoints. The internal registry is the future API/planner source of already-validated metadata.

The browser sends task IDs and typed field values, never arbitrary executable names, executable paths, flag names, or free-form command strings.

The future runtime resolves task -> validated pack definition -> deterministic executable/argument vector.

## 7. Pack foundation

The Phase 2 pack path is:

```text
trusted source bytes/file
  -> bounded UTF-8 + hardened single-document YAML parse
  -> supported API-version check
  -> embedded JSON Schema validation
  -> deterministic semantic/security validation
  -> deep-copied Registry
```

The registry:

- sorts packs by stable pack ID;
- rejects duplicate pack IDs;
- provides deterministic pack/tool/command enumeration and lookup;
- returns deep copies so callers cannot mutate authoritative validated state;
- contains no global mutable registry.

The implemented v1 argv model admits only trusted literals, named flags fed by declared scalar inputs, boolean switches, and enum-to-pack-literal maps. It does not admit executable selection, generic interpolation, or free-form positional user input.

## 8. Execution planning

Execution is future two-phase work:

### Plan

The planner will validate:

- pack/task existence in the validated registry;
- compatible discovered tool version;
- browser field types and constraints;
- required/optional flags;
- mutually-exclusive values where later supported;
- risk policy;
- working-directory/environment allowlists where later supported;
- redaction classification.

It should emit an immutable `ExecutionPlan` conceptually like:

```text
runID
packID/version
taskID
toolID
resolvedExecutablePath
args[]
allowedEnvironmentDelta
workingDirectory (optional)
riskClass
secretArgumentIndexes / redaction metadata
timeoutPolicy
outputMode
```

### Execute

The executor accepts only an already-validated plan. It must not reinterpret browser input.

Phase 2 does not build plans or spawn processes.

## 9. Process invocation

For ordinary commands, the future executor should use the equivalent of:

```go
exec.CommandContext(ctx, executablePath, args...)
```

Do not translate this to a shell command string.

The v1 pack validator proactively rejects common shells/general-purpose interpreters as tool executable declarations. This is defense in depth and does not replace the pack trust model.

On Windows, cancellation should account for descendant processes. A Windows Job Object or equivalent process-tree strategy should be evaluated for reliable cleanup.

## 10. Streaming model

The executor is expected to emit normalized events:

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

SSE is preferable for MVP if communication is primarily server -> browser. WebSocket is justified only when bidirectional interactive terminal semantics are required.

Output chunks must have bounded buffering/backpressure behavior to avoid memory exhaustion from noisy commands.

## 11. Output parsing

Prefer native machine-readable output from the wrapped CLI, especially JSON.

Parsing hierarchy:

1. documented structured output;
2. stable line-delimited format;
3. narrowly-tested custom parser;
4. raw text fallback.

Never silently transform parse failures into empty/incorrect tables. Preserve raw output and surface a parser warning.

Phase 2 stores only output-mode/renderer/sensitivity metadata. It does not implement output parsing or adapters.

## 12. Authentication architecture

Authentication is adapter-driven but vendor-owned.

The runtime may eventually:

- query auth/session status through documented CLI commands;
- invoke the CLI's login/logout flows;
- launch an external terminal for interactive login when required;
- detect completion/expiration;
- refresh UI state.

The runtime should not:

- maintain its own password database;
- persist MFA codes;
- copy access tokens into frontend state;
- read OS keystore contents merely to make login look more integrated.

The pack v1 model includes only `requirements.requiresAuth` metadata. It contains no credential values or auth scripts.

A future embedded PTY must be treated as a security-sensitive feature, not a convenience refactor.

## 13. Pack trust model

Packs are privileged configuration because they can define future executable/argument authority. Validation proves shape and invariants; it does not make an untrusted pack trusted.

Implemented Phase 2 source classes:

- **built-in:** bytes explicitly supplied by trusted application code;
- **explicit-local:** specific local pack files/directories deliberately supplied by a trusted caller.

Explicit-local directory loading is non-recursive and deterministic. Symlink pack files/directories and non-regular YAML entries are rejected. Reads are bounded to 256 KiB per pack and checked around the open/read boundary.

The loader does not scan the current working directory, auto-load repository-local packs, follow remote URLs, auto-download content, or execute pack/plugin code. `packs/example/pack.yaml` is a synthetic repository fixture and acquires no authority merely by existing in the checkout.

Remote pack installation/update is out of MVP scope. Future pack distribution should require integrity/signature verification and a permission/capability model.

## 14. State and persistence

MVP should avoid a database.

Potential state:

- runtime memory: validated pack registry, active runs, session bootstrap state;
- local config file: non-secret settings such as explicitly approved pack/binary paths and UI preferences;
- optional local diagnostics/history file: redacted metadata only, disabled or minimal by default until retention requirements are agreed.

Never persist secret field values.

## 15. Browser launch and frontend serving

Use the OS default browser. Do not bundle Chromium/Electron.

The browser launcher receives only a validated URL of the form `http://127.0.0.1:<ephemeral-port>/bootstrap?token=<secret>`. Windows uses native `ShellExecuteW`; normal browser launch does not route through CMD or PowerShell. Linux/macOS use fixed executable + argument invocation with no shell-string evaluation.

A successful automatic launch does not print the bootstrap token to normal CLI output. If automatic browser launch fails, the server remains active and the CLI prints the short-lived bootstrap URL as an explicit recovery path.

Production frontend assets are Vite build output committed under `internal/webui/static/` and embedded with Go `embed`. CI rebuilds `web/` and fails on generated-asset drift.

### Development frontend proxy

Development may be enabled only with an explicit `--web-dev-url http://127.0.0.1:<port>` origin. The runtime rejects non-loopback hosts, HTTPS substitutions, missing/invalid ports, URL credentials, fragments, queries, and path-bearing targets.

The browser continues to use the CLIHarbor loopback origin and authenticated session. Requests forwarded to Vite have CLIHarbor session/authentication headers stripped, including cookies, authorization headers, and the CSRF header. `Set-Cookie` returned by the development server is also removed before it reaches the browser. This prevents the development server from becoming a holder or setter of CLIHarbor browser-session material.

## 16. Extensibility

The engine should support most new CLIs through packs. Add code adapters only when a CLI requires behavior that cannot be expressed safely in the schema, such as:

- nontrivial auth-state discovery;
- complex output parsing;
- special process lifecycle;
- tightly reviewed pre/post execution transformations.

Adapters should have explicit interfaces and tests; they must not gain unrestricted arbitrary execution hooks.

## 17. Architecture quality gates

Before calling the MVP architecture complete:

- no browser-controlled arbitrary executable or shell-string endpoint exists;
- loopback binding and anti-CSRF/origin controls are tested;
- pack schema + semantic validation are mandatory before future planning/execution;
- untrusted repository-local files do not automatically become pack authority;
- deterministic pack loading/duplicate handling is tested;
- process cancellation works on Windows once execution exists;
- secrets are redacted in logs, previews, and errors;
- raw output survives parser failure once parsing exists;
- a second synthetic CLI pack can prove the core is not hard-wired to Idira/CyberArk when the planner/UI reach that stage.
