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
   |- pack loader / schema validator
   |- tool discovery / version probe
   |- command planner / validation
   |- process executor
   |- auth state adapter
   |- output parsers / redaction
   |- run metadata
   v
Approved local CLI binary (idsec.exe, conjur.exe, ...)
   |
   v
Vendor service / existing auth/session model
```

## 2. Deployment model

### MVP

One local executable starts a loopback server, serves embedded frontend assets, opens the user's default browser, and executes approved local CLI processes as the current user.

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
- straightforward `embed` support for frontend assets;
- low runtime overhead;
- good fit for adding a subcommand to another CLI or shipping a companion binary;
- cross-platform portability later.

### Frontend: React + TypeScript + Vite

The frontend should be static after build. It should not contain privileged logic or direct filesystem/process access.

### Packs: YAML + JSON Schema

Human-authored YAML is appropriate for command/workflow definitions; JSON Schema provides deterministic validation and tooling. Packs should carry an explicit schema version.

## 4. Backend package boundaries

Suggested Go module layout:

```text
cmd/cliharbor/            # process entry point
internal/app/             # application lifecycle / dependency wiring
internal/server/          # HTTP routes, browser bootstrap, origin checks
internal/packs/           # pack loading, schema validation, versioning
internal/discovery/       # PATH lookup, configured binary paths, version probes
internal/planner/         # form input -> validated execution plan
internal/executor/        # process start/stream/cancel/timeout
internal/auth/            # auth-state adapters and login launch orchestration
internal/output/          # parsers, structured rendering models
internal/redact/          # secret-safe diagnostics and invocation views
internal/runs/            # run state and metadata
internal/platform/windows # Windows-specific process-tree/browser helpers
web/                      # React app
packs/                    # built-in CLI packs
schemas/                  # pack schema(s)
```

Avoid placing vendor-specific behavior in generic packages. Idira/CyberArk-specific logic belongs in its pack or a narrowly-scoped adapter.

## 5. Server lifecycle

1. Parse CLIHarbor's own flags.
2. Load trusted built-in/local packs.
3. Validate schemas and compatibility.
4. Resolve required executables and probe versions.
5. Bind an ephemeral port on loopback.
6. Generate an unpredictable per-launch session/bootstrap secret.
7. Start HTTP server.
8. Open browser to a bootstrap URL or equivalent safe handoff.
9. Exchange bootstrap secret for an HttpOnly/SameSite session cookie or similarly constrained local session mechanism.
10. Remove the secret from navigable URLs/history as soon as practical.
11. Serve UI/API until shutdown.

Do not bind `0.0.0.0` by default.

## 6. Browser/API contract

Suggested API surface:

```text
GET  /api/v1/status
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

The browser sends task IDs and typed field values, never arbitrary executable names or free-form command strings.

The runtime resolves task -> pack definition -> executable/argument vector.

## 7. Execution planning

Execution is two-phase:

### Plan

The planner validates:

- pack/task existence;
- compatible tool version;
- field types and constraints;
- required/optional flags;
- mutually-exclusive values;
- risk policy;
- working-directory/environment allowlists;
- redaction classification.

It emits an immutable `ExecutionPlan` conceptually like:

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

## 8. Process invocation

For ordinary commands:

```go
exec.CommandContext(ctx, executablePath, args...)
```

Do not translate this to a shell command string.

PowerShell/CMD support is reserved for explicit pack types where a script itself is the intended executable and the security implications are reviewed. Even then, arguments must be structured and constrained.

On Windows, cancellation should account for descendant processes. A Windows Job Object or equivalent process-tree strategy should be evaluated for reliable cleanup.

## 9. Streaming model

The executor emits normalized events:

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

## 10. Output parsing

Prefer native machine-readable output from the wrapped CLI, especially JSON.

Parsing hierarchy:

1. documented structured output;
2. stable line-delimited format;
3. narrowly-tested custom parser;
4. raw text fallback.

Never silently transform parse failures into empty/incorrect tables. Preserve raw output and surface a parser warning.

## 11. Authentication architecture

Authentication is adapter-driven but vendor-owned.

The runtime may:

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

A future embedded PTY must be treated as a security-sensitive feature, not a convenience refactor.

## 12. Pack trust model

Packs are privileged configuration because they can define which local executables and arguments are allowed.

MVP trust sources:

- built-in pack compiled/shipped with CLIHarbor;
- repository-local pack explicitly loaded in development;
- administrator-approved local pack directory in future.

Remote pack installation/update is out of MVP scope.

Future pack distribution should require integrity/signature verification and a permission/capability model.

## 13. State and persistence

MVP should avoid a database.

Potential state:

- runtime memory: active runs, session bootstrap state;
- local config file: non-secret settings such as binary path overrides and UI preferences;
- optional local diagnostics/history file: redacted metadata only, disabled or minimal by default until retention requirements are agreed.

Never persist secret field values.

## 14. Browser launch

Use the OS default browser. Do not bundle Chromium/Electron.

If automatic browser launch fails, print a safe loopback URL and clear instructions.

## 15. Extensibility

The engine should support most new CLIs through packs. Add code adapters only when a CLI requires behavior that cannot be expressed safely in the schema, such as:

- nontrivial auth-state discovery;
- complex output parsing;
- special process lifecycle;
- pre/post execution transformations.

Adapters should have explicit interfaces and tests; they must not gain unrestricted arbitrary execution hooks.

## 16. Architecture quality gates

Before calling the MVP architecture complete:

- no browser-controlled arbitrary executable or shell-string endpoint exists;
- loopback binding and anti-CSRF/origin controls are tested;
- pack schema validation is mandatory before execution;
- process cancellation works on Windows;
- secrets are redacted in logs, previews, and errors;
- raw output survives parser failure;
- a second synthetic CLI pack proves the core is not hard-wired to Idira/CyberArk.
