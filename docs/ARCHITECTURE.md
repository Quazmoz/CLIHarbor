# Architecture

## 1. Objective

CLIHarbor is a thin, Windows-first local application that turns explicitly trusted CLI workflows into a guided browser experience without becoming a shell, credential manager, remote execution service, or replacement for the wrapped vendor CLI.

The wrapped CLI remains the operational authority. CLIHarbor owns only the local orchestration boundary:

```text
Browser UI
   |
   | authenticated loopback HTTP + bounded SSE
   v
CLIHarbor runtime
   |- explicit trusted pack loading
   |- schema + semantic/security validation
   |- executable discovery + version compatibility
   |- executable identity capture/revalidation
   |- typed request validation
   |- deterministic execution planning
   |- bounded direct process execution
   |- run/event ownership and replay
   |- structured non-secret result parsing
   |- Phase 0 evidence and support diagnostics
   v
Approved installed CLI executable
   |
   v
Vendor service / vendor-owned auth/session model
```

No daemon, Windows service, privileged helper, cloud backend, external database, arbitrary shell, or credential store is required.

## 2. Technology and deployment model

### Backend

Go provides a self-contained Windows executable, standard-library HTTP/process primitives, embedded frontend assets, and a portable core with narrow platform-specific process-control boundaries.

### Frontend

React + TypeScript + Vite produces static assets embedded into the Go executable. The frontend has no direct filesystem/process authority.

### Packs

Versioned YAML validated against the embedded Draft 2020-12 JSON Schema at `schemas/pack.v1.schema.json`, followed by deterministic semantic/security validation in `internal/packs`.

### Deployment

A single local executable starts an ephemeral IPv4 loopback HTTP server and opens a browser. Approved packs are supplied explicitly by the operator. CLIHarbor installs no Windows service, driver, browser extension, scheduled task, or machine-wide configuration.

## 3. Package boundaries

```text
cmd/cliharbor/             process entry point and operator commands
internal/app/              application lifecycle and runtime wiring
internal/server/           loopback HTTP/session/origin/CSRF boundary
internal/apperror/         closed browser-safe failure taxonomy
internal/webui/            embedded frontend + constrained dev proxy
internal/platform/browser/ default-browser launch boundary
internal/packs/            pack model/schema/semantic validation/registry
internal/discovery/        executable resolution, version probes, identity
internal/planner/          typed values -> immutable execution plan
internal/executor/         direct bounded process execution
internal/processcontrol/   platform process-lifecycle ownership
internal/runs/             bounded run state/events/replay
internal/structured/       bounded structured-result parsing
internal/evidence/         Phase 0 evidence export/inspection/integrity
internal/diagnostics/      allowlisted privacy-preserving diagnostics
web/                       React + TypeScript source
packs/example/             synthetic fixtures
packs/phase0/              discovery/evidence-only vendor pack
packs/conjur/              real version-gated Conjur pack
schemas/                   embedded pack schema
tools/task/                repository build/verification tasks
```

Vendor-specific command syntax belongs in verified packs or narrowly scoped adapters. Generic discovery/planner/executor code must not contain Conjur-specific command branches.

## 4. Runtime lifecycle

Normal `serve` lifecycle:

1. Parse CLIHarbor flags.
2. Load only explicitly configured pack files/directories.
3. Enforce bounded UTF-8/YAML/schema/semantic/security validation.
4. Build an effectively immutable registry.
5. Resolve each declared tool.
6. Run only fixed pack-authored version probes when configured.
7. Enforce version constraints and capture executable identity for ready tools.
8. Build the sanitized task/tool catalog from commands permitted by current backend policy.
9. Bind an ephemeral IPv4 loopback port.
10. Create one-time bootstrap/session/CSRF material.
11. Start the authenticated local server and browser bootstrap flow.
12. Accept typed task requests, build immutable plans, and execute them through the bounded run manager.
13. Stop all owned execution and browser state on shutdown.

`doctor` performs pack loading/discovery/version checks without opening a browser. Phase 0 inventory/evidence commands use the same trusted discovery boundary but do not grant normal browser task authority.

## 5. Browser/API authority

Implemented browser surface includes:

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

The browser may submit:

- trusted `packId`;
- trusted `commandId`;
- values for pack-declared typed inputs.

The browser may **not** submit or select:

- executable names or paths;
- subcommand names;
- flag names;
- shell commands;
- raw argv arrays;
- environment-variable names;
- working directories;
- pack trust/source.

Task metadata includes only currently executable commands under backend policy plus their typed input constraints. Tool metadata is sanitized and does not disclose executable/candidate paths or executable identity.

Browser-facing failures use the closed safe error DTO. Raw internal errors, unreviewed vendor error metadata, executable paths, argv, environments, and session secrets are not copied into that contract.

## 6. Loopback/session boundary

The HTTP server binds to `127.0.0.1` on an ephemeral port.

Controls include:

- one-time unpredictable bootstrap material;
- host-only HttpOnly session cookie;
- exact Host validation;
- rejection of foreign non-empty Origin;
- exact same-origin + CSRF validation for mutations;
- restrictive browser headers/CSP;
- bounded request bodies and stream concurrency.

The one-time bootstrap URL is a narrow local recovery credential and is removed from normal navigation history after exchange.

## 7. Pack authority and trust

Pack loading follows:

```text
explicit trusted source
  -> bounded UTF-8 read
  -> hardened single-document YAML
  -> supported apiVersion
  -> embedded JSON Schema
  -> semantic/security validation
  -> deep-copied deterministic Registry
```

Validation is **not** trust. Supported trust sources are deliberately supplied built-in bytes and explicit local files/directories. CLIHarbor does not auto-scan cwd, auto-download packs, load pack URLs, execute pack plugins, or follow arbitrary pack symlinks.

The registry returns defensive copies so callers cannot mutate authoritative validated state through returned maps/slices/pointers.

## 8. Deterministic argv model

The v1 pack model admits only reviewed argument primitives:

### Trusted literal

One pack-authored argv element.

### Flag + typed value

A fixed pack-authored flag followed by one validated scalar value. User-derived string/enum flag values must reject leading `-`.

### Boolean switch

A fixed pack-authored flag emitted only when the referenced boolean is true.

### Enum-mapped literal

A required enum maps to exactly one pack-authored argv literal from a complete allowlist.

### Constrained positional value

One validated scalar becomes **exactly one argv element** at a pack-defined position.

This primitive was added to represent verified CLI forms such as:

```text
conjur resource show <resource-id>
```

Its invariants are:

- no tokenization or whitespace splitting;
- no template/interpolation language;
- no shell interpretation;
- only scalar string/integer/enum inputs;
- optional positional values omit atomically;
- string/enum positional values must reject leading `-`;
- the browser cannot move the value to another argv position.

The model still does not support free-form command strings, browser-selected subcommands/flags, arbitrary argv arrays, shell expansion, user-selected executables, or executable parser plugins.

## 9. Tool discovery and compatibility

Discovery consumes only validated registry metadata.

PATH search:

- examines absolute PATH entries only;
- ignores empty/relative/current-directory entries;
- requires regular files;
- resolves and de-duplicates candidates deterministically;
- fails closed on multiple matching candidates;
- on Windows permits exact name, `.exe`, or `.com` for an extensionless approved basename, never batch/script extensions.

Operators may explicitly pin one absolute path:

```text
--tool-path pack/tool=/absolute/path
```

This is backend/operator configuration. An invalid override is authoritative and does not fall back to PATH.

### Version probes

A pack may define one fixed `semver-text` probe and a semantic version constraint. The already selected executable is started directly, without a shell, in a bounded probe process.

Probe output must contain exactly one distinct semantic version. No version, ambiguous versions, timeout, invalid output, or a failed probe prevents executable authority. A valid version outside the trusted constraint yields `incompatible`.

### Executable identity

Discovery captures identity for the selected regular file. Identity is revalidated after version probing and again immediately before normal execution, including content fingerprint evidence. Same-path replacement/content mutation therefore fails closed.

This proves file continuity, not vendor publisher identity. Code signing/publisher allowlisting remains a separate enterprise/release control.

## 10. Planning policy

The planner accepts:

- immutable registry;
- authoritative discovery snapshot;
- pack/command IDs;
- typed browser values.

It requires:

- a known pack and command;
- `risk: read` under the current execution milestone;
- non-secret output;
- a current `ready` tool whose discovered pack version matches the configured pack;
- valid executable identity;
- exact JSON types and pack validation rules;
- no unknown inputs.

### Authentication policy

Generic:

```yaml
requirements:
  requiresAuth: true
```

remains fail-closed for browser execution unless an approved authentication mode is also declared.

The implemented mode is:

```yaml
requirements:
  requiresAuth: true
  authMode: vendor-session
```

`vendor-session` allows a read-only/non-secret command to use authentication already owned by the vendor CLI/environment/OS credential storage. CLIHarbor does not accept vendor credentials through browser task inputs.

The planner rejects an auth-required task whose mode is not explicitly supported.

## 11. Process execution

The executor starts the planned executable directly with `os/exec` and an argv slice.

It does not invoke CMD, PowerShell, or a POSIX shell for ordinary task execution.

Each run has:

- server-generated run ID;
- neutral temporary working directory;
- bounded execution deadline;
- bounded stdout/stderr streams;
- explicit cancellation;
- finite `WaitDelay`;
- executable identity revalidation immediately before launch.

For `vendor-session` tasks, stdin remains unset. CLIHarbor does not send passwords, MFA values, tokens, or synthesized terminal keystrokes to the child process.

Non-zero vendor exit codes remain normal process-exit results; they are not falsely rewritten as successful CLIHarbor operations.

## 12. Windows process lifecycle

On Windows each run uses a native Job Object with kill-on-close semantics.

CLIHarbor starts the target suspended, associates it with the run Job Object before user code executes, then resumes it. Descendants inherit the containment boundary by default. Timeout/cancellation tears down the job; closing the Job Object prevents descendants from outliving a completed run.

Non-Windows platforms retain the same planner/executor contract but do not claim equivalent descendant-tree ownership unless separately implemented/qualified.

## 13. Run state, streaming and replay

The run manager owns bounded in-memory authoritative run state. There is no persisted run database.

Internal events include:

```text
run.started
stdout.chunk
stderr.chunk
run.exited
run.cancelled
run.timed-out
run.failed
```

SSE observes manager state rather than owning execution. Disconnect/reconnect does not recreate or cancel a run. Replay is sequence-based and bounded. Stream concurrency and write deadlines are finite.

Request disconnect after successful run creation does not implicitly kill the run; explicit cancellation, timeout, or application shutdown owns termination.

## 14. Structured output

Structured parsing is downstream of authoritative process execution.

A validated JSON command may declare a bounded top-level scalar object contract. Current structured fields support only string/integer/boolean values. Parsing rejects malformed JSON, duplicate/unknown fields, nested values, invalid UTF-8, oversized input/strings, integer overflow, and unsafe controls.

Structured parsing cannot:

- change executable selection;
- create argv;
- start another process;
- alter run ID/status/exit code.

Secret-bearing commands cannot enable structured rendering and are currently rejected by normal browser execution entirely.

## 15. Vendor-owned authentication

CLIHarbor does not own vendor passwords, MFA, access tokens, API keys, or credential storage.

The current Conjur 9.x read-only pack uses `vendor-session`. For the qualified upstream contract (`conjur-cli-go v9.3.1`, which pins `conjur-api-go v0.15.4`), the authenticated client loads environment/stored credentials and returns a login-required error when no valid session is available.

Therefore normal browser-triggered Conjur read operations do not need CLIHarbor to implement a credential form or interactive prompt.

Future explicit login/logout/status adapters remain separate reviewed capabilities. Browser password forms and embedded PTY support are not implied by `vendor-session`.

## 16. Real Conjur 9.x vertical slice

The repository includes:

```text
packs/conjur/conjur-v9.yaml
```

Its generic command contract is derived from the official CyberArk/Idira `cyberark/conjur-cli-go` v9.3.1 release at commit:

```text
7207d6a4a2005130978e10d03d7f6b55ab0216d6
```

The tool is constrained to:

```text
>=9.3.1 <10.0.0
```

The pack exposes only reviewed non-secret read workflows:

- authenticated identity (`whoami`);
- resource listing with approved filters;
- resource exists/show/permitted roles;
- role exists/show/members/memberships.

Secret retrieval, interactive login, password/API-key rotation, policy/issuer/host-factory mutation, deprecated operations, and deployment-specific operations that cannot be generalized are intentionally absent from browser authority.

Online upstream evidence establishes the generic command contract. It does not attest the exact binary/configuration installed on a company-managed endpoint; managed-device qualification still verifies discovery, version compatibility, relevant help surfaces, network/session behavior, and at least one safe read workflow.

See [Conjur CLI 9.x Integration](CONJUR_INTEGRATION.md).

## 17. Phase 0 evidence boundary

The qualified Windows evaluation bundle contains an immutable discovery-only Phase 0 pack. Its exact layout is verified by `evaluation preflight`.

The real Conjur pack is therefore published as a **separate CI artifact** and loaded explicitly after preflight. This prevents normal vendor task authority from silently entering the immutable preflight bundle.

Evidence exports are inert `cliharbor.phase0/v1` review documents. Evidence inspection never converts captured help text or command output into executable pack authority automatically.

## 18. Diagnostics and privacy

Support diagnostics are allowlisted metadata, not filesystem/environment scraping.

Normal diagnostics exclude:

- command stdout/stderr;
- argv;
- executable/candidate paths;
- PATH/environment values;
- browser bootstrap/session/CSRF values;
- passwords/tokens/MFA/API keys;
- credential-store contents.

`doctor` is a local operator diagnostic and may contain exact filesystem paths; it should not be shared without review/redaction.

## 19. Build and distribution architecture

Production frontend assets are generated from `web/` and embedded into the Go executable. CI verifies source/generated synchronization.

Relevant CI qualification includes:

- frontend typecheck/lint/tests/build;
- generated-asset drift checks;
- Go formatting/vet/tests;
- race detection;
- module verification;
- npm dependency audit;
- reachable Go vulnerability scan;
- production embedded-browser E2E;
- Linux and Windows quality jobs;
- Windows evaluation build metadata;
- deterministic isolated rebuild comparison;
- authoritative evaluation bundle verification;
- vendor-free self-test;
- extracted-bundle preflight;
- Phase 0 evidence smoke;
- final bundle re-verification.

The Windows evaluation ZIP and real Conjur pack are separate CI artifacts. The evaluation bundle's checksum manifest proves covered-byte integrity under the repository qualification contract; it is not publisher identity, independent provenance attestation, or code signing.

## 20. State and persistence

No external database is required.

Authoritative runtime state is in memory:

- validated pack registry;
- discovery snapshot and executable identity;
- browser session/CSRF state;
- bounded run/event state.

CLIHarbor does not persist vendor credentials or command history as part of the current product contract.

## 21. Failure semantics

Expected failures are explicit and fail closed where authority is uncertain:

- missing/ambiguous/incompatible tool -> no execution;
- invalid override -> no PATH fallback;
- changed executable -> no execution;
- invalid/unknown browser input -> no plan;
- unsupported auth mode -> no task exposure/plan;
- secret-bearing output -> no normal browser execution;
- non-read risk -> no normal browser execution;
- timeout/cancellation -> process-tree teardown under the platform lifecycle boundary;
- structured parser failure -> raw process evidence remains, no new execution authority;
- vendor login-required/permission/network failure -> vendor process failure is surfaced through the existing safe run/error boundary.

## 22. Extension rule

New capabilities must preserve:

```text
trusted validated pack
  -> trusted discovered executable
  -> validated typed inputs
  -> deterministic exact argv
  -> bounded direct execution
```

A feature should not enter the generic runtime if it requires arbitrary shell strings, browser-selected command syntax, hidden credential handling, unbounded process ownership, or model-generated runtime command authority.

Potential later boundaries—explicit login adapters, secret-bearing output UX, change/destructive confirmation, richer result schemas, code signing, and a pack distribution trust model—require separate reviewed contracts and qualification.
