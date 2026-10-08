# Architecture

## 1. Objective

CLIHarbor is a thin local application for Windows and macOS that turns explicitly trusted CLI workflows into a guided browser experience without becoming a shell, credential manager, remote execution service, or replacement for the wrapped vendor CLI.

The wrapped CLI remains the operational authority. CLIHarbor owns the local orchestration boundary:

```text
Browser UI
   |
   | authenticated loopback HTTP + bounded SSE
   v
CLIHarbor runtime
   |- embedded/explicit trusted pack loading
   |- schema + semantic/security validation
   |- executable discovery + version compatibility
   |- optional pinned current-user vendor bootstrap
   |- executable identity capture/revalidation
   |- typed request validation
   |- deterministic execution planning
   |- bounded direct process execution
   |- run/event ownership and replay
   |- structured non-secret result parsing
   |- Phase 0 evidence and support diagnostics
   v
Approved installed or exact verified managed CLI executable
   |
   v
Vendor service / vendor-owned auth/session model
```

No daemon, Windows service, privileged helper, cloud backend, external database, arbitrary shell, or credential store is required.

## 2. Technology and deployment model

### Backend

Go provides a self-contained native executable on Windows and macOS, standard-library HTTP/process/download primitives, embedded assets, and a portable core with narrow platform-specific process-control boundaries.

### Frontend

React + TypeScript + Vite produces static assets embedded into the Go executable. The frontend has no direct filesystem, process, pack-source, executable-selection, or download authority.

### Packs

Versioned YAML is validated against the embedded Draft 2020-12 JSON Schema at `schemas/pack.v1.schema.json`, followed by deterministic semantic/security validation in `internal/packs`.

The first-party Conjur pack remains reviewable at `packs/conjur/conjur-v9.yaml` and is also embedded into production/evaluation CLIHarbor binaries. Explicit local packs are first-class additive runtime sources for other reviewed CLIs and can coexist with embedded packs in the same registry.

### Deployment

A single local executable starts an ephemeral IPv4 loopback HTTP server and opens a browser. CLIHarbor installs no Windows service, driver, browser extension, scheduled task, or machine-wide configuration.

When the embedded first-party Conjur pack is active and Conjur is genuinely absent, CLIHarbor may provision the exact reviewed vendor executable into the current user's cache. That fallback is application-managed content, not a machine-wide installation.

## 3. Package boundaries

```text
cmd/cliharbor/             process entry point and operator commands
internal/app/              application lifecycle, default pack and setup wiring
internal/server/           loopback HTTP/session/origin/CSRF boundary
internal/apperror/         closed browser-safe failure taxonomy
internal/webui/            embedded frontend + constrained dev proxy
internal/platform/browser/ default-browser launch boundary
internal/packs/            pack model/schema/semantic validation/registry
internal/discovery/        executable resolution, version probes, identity
internal/toolbootstrap/    generic provisioner interface + pack-declared portable installs
internal/platforms/        dedicated CLI platform interface + routing set (ADR-034)
internal/platforms/conjur/ dedicated Conjur: sign-in, mutation context, security audit, pinned bootstrap
internal/planner/          typed values -> immutable execution plan
internal/executor/         direct bounded process execution
internal/processcontrol/   platform process-lifecycle ownership
internal/runs/             bounded run state/events/replay
internal/structured/       bounded structured-result parsing
internal/evidence/         Phase 0 evidence export/inspection/integrity
internal/diagnostics/      allowlisted privacy-preserving diagnostics
web/                       React + TypeScript source
packs/embed.go             compiled-in first-party pack assets
packs/example/             synthetic fixtures
packs/phase0/              discovery/evidence-only vendor pack
packs/conjur/              real version-gated Conjur pack source
schemas/                   embedded pack schema
tools/task/                repository build/verification tasks
```

CLIHarbor is split into a **generic core** that works with any reviewed CLI and **dedicated platforms** (`internal/platforms/<id>`) that add functionality built and tested for one CLI. The core reaches platform behavior only through `platforms.Set`; see ADR-034.

Vendor-specific command syntax belongs in verified packs or narrowly scoped adapters. Generic discovery/planner/executor code must not contain Conjur-specific command branches. Vendor download logic is likewise isolated from the generic executor and cannot author argv.

## 4. Normal zero-config lifecycle

Normal `serve` lifecycle with no pack flags:

1. Parse CLIHarbor flags.
2. Load the compiled-in first-party Conjur pack through the hardened built-in pack loader.
3. Enforce bounded UTF-8/YAML/schema/semantic/security validation and build the registry.
4. Resolve the declared Conjur executable using normal discovery.
5. If exactly one compatible candidate is already installed, retain it.
6. If and only if the Conjur state is exactly `missing` and auto-setup is enabled, ask the reviewed Conjur provisioner for the pinned current-user fallback.
7. Verify the downloaded bytes before activation and verify the activated file again.
8. Add the managed path as a backend-only override and run normal discovery/version probing again.
9. Capture executable identity for any ready tool.
10. Build the sanitized task/tool catalog from commands permitted by current backend policy.
11. Bind an ephemeral IPv4 loopback port.
12. Create one-time bootstrap/session/CSRF material.
13. Start the authenticated local server and browser bootstrap flow.
14. Accept typed task requests, build immutable plans, and execute them through the bounded run manager.
15. Expose newest-first retained run metadata through the authenticated list API without copying output, inputs, argv, paths or credentials into history summaries; fetch full retained evidence only through the existing single-run endpoint.
16. Stop all owned execution and browser state on shutdown.

`--no-auto-setup` disables step 6 while retaining the embedded pack.

If `--pack-file` or `--pack-dir` is supplied to `serve` or `doctor`, those explicit sources are added to the embedded first-party pack set. `--no-default-packs` opts into a custom-only registry. Duplicate pack IDs across sources fail closed. Automatic dependency provisioning remains identity-scoped to the reviewed embedded Conjur pack/tool and is never inherited by an unrelated custom pack.

`doctor` and Phase 0 inventory/evidence remain operator surfaces and do not need to trigger the normal zero-config provisioning path.

## 5. Generic pack onboarding boundary

Pack onboarding is deliberately split from execution authority:

1. `cliharbor pack init` creates a discovery-only v1 scaffold containing one declared executable basename and **no commands, version probes, or help probes**.
2. `cliharbor pack validate` runs the hardened YAML/schema/semantic/security loader over one or more explicit files/directories and combines them into one deterministic registry solely to detect cross-pack conflicts such as duplicate IDs.
3. Validation does not run executables, version probes, evidence probes, or tasks.
4. A pack author must add command/probe/version contracts from reviewed documentation or evidence.
5. `doctor` performs ordinary discovery for the resulting trusted pack; `serve` only exposes commands that pass the existing task policy.

The scaffold generator therefore improves onboarding without becoming an automatic CLI scraper or a source of guessed security-sensitive argv.

## 6. Pinned Conjur bootstrap boundary

The only implemented automatic vendor executable bootstrap is CyberArk Conjur CLI v9.3.1 Windows amd64:

```text
source: https://github.com/cyberark/conjur-cli-go/releases/download/v9.3.1/conjur_windows_amd64.exe
size:   21,950,000 bytes
SHA-256: da2b31ca00b8faaefb8e1fe891563b5cc07c39460e776fb42e7f89b05d3ee4f6
```

Normal managed target:

```text
<current-user-cache>\CLIHarbor\tools\conjur\9.3.1\conjur.exe
```

The bootstrapper:

- is Windows amd64 and Conjur-tool specific;
- never accepts a browser-supplied URL, hash, destination or executable name;
- does not use a mutable latest-version endpoint;
- uses HTTPS in production and restricts redirects to reviewed GitHub origins;
- bounds redirect count, response size and downloaded bytes;
- stages into the destination directory;
- verifies exact expected size and SHA-256 before activation;
- syncs the staged file;
- activates by rename;
- verifies the activated file again;
- re-verifies cached copies before reuse;
- removes invalid managed copies rather than executing them;
- tolerates a concurrent successful installer only when the winning target exactly verifies;
- never modifies machine PATH, Program Files, services, drivers, registry or elevation state.

Bootstrap success grants no task authority by itself. The returned file still must pass the ordinary Conjur basename/version/discovery/identity contract.

## 7. Fail-closed provisioning policy

Automatic provisioning is a fallback for an absent dependency, not a repair mechanism for uncertain enterprise state.

CLIHarbor does **not** auto-replace:

- ambiguous candidates;
- incompatible versions;
- failed version probes;
- identity failures;
- unsupported platforms;
- invalid explicit overrides;
- explicitly selected operator paths.

If policy/proxy/EDR/application control prevents the download or execution, CLIHarbor surfaces sanitized remediation and leaves the tool unavailable. It does not bypass controls.

## 8. Browser/API authority

Implemented browser surface includes:

```text
GET  /bootstrap?token=<one-time-secret>
GET  /api/v1/status
GET  /api/v1/tasks
GET  /api/v1/tools
POST /api/v1/tools/install
POST /api/v1/runs
GET  /api/v1/runs/{runId}
GET  /api/v1/runs/{runId}/events
POST /api/v1/runs/{runId}/cancel
GET  /
GET  /assets/*
```

The browser may submit only trusted pack/command identities and values for pack-declared typed inputs.

The browser cannot choose or supply:

- executable names or paths;
- subcommands or flag names;
- shell commands or raw argv arrays;
- environment-variable names;
- working directories;
- pack source/trust;
- dependency download URLs, versions, hashes or destinations.

Task metadata includes only currently executable commands under backend policy. Tool metadata is sanitized and does not disclose executable/candidate paths or executable identity.

## 9. Loopback/session boundary

The HTTP server binds to `127.0.0.1` on an ephemeral port.

Controls include one-time unpredictable bootstrap material, host-only HttpOnly session cookie, exact Host validation, rejection of foreign non-empty Origin, exact same-origin plus CSRF validation for mutations, restrictive browser headers/CSP, and bounded request/stream concurrency.

## 10. Pack authority and trust

Pack loading follows:

```text
trusted built-in bytes or explicit trusted local source
  -> bounded UTF-8 read
  -> hardened single-document YAML
  -> supported apiVersion
  -> embedded JSON Schema
  -> semantic/security validation
  -> deep-copied deterministic Registry
```

Validation is **not** trust. CLIHarbor does not auto-scan cwd, load pack URLs, auto-download packs, execute pack plugins, or follow arbitrary pack symlinks.

Embedding the first-party Conjur pack removes a user download step; it does not create network-based pack authority.

## 11. Deterministic argv model

The v1 pack model admits only reviewed argument primitives:

- trusted pack-authored literal;
- fixed flag plus validated scalar value;
- fixed boolean switch;
- enum-to-pack-literal mapping;
- constrained positional value where one validated scalar becomes exactly one argv element.

There is no tokenization, template/interpolation language, shell interpretation, browser-selected subcommand/flag, arbitrary argv array, or user-selected executable.

## 12. Tool discovery and compatibility

Discovery consumes validated registry metadata only.

PATH search uses absolute entries, ignores empty/relative/cwd entries, requires regular files, normalizes/de-duplicates candidates, and fails closed on ambiguity. When PATH has no match, discovery checks a bounded non-recursive set of common current-user locations, including the default Go `~/go/bin`, Windows WinGet links and Scoop shims; PATH always has higher priority, and multiple matches within the fallback tier still fail closed. Operators may explicitly pin one absolute path with:

```text
--tool-path pack/tool=/absolute/path
```

An explicit invalid override is authoritative and does not silently fall back to PATH or managed bootstrap.

A pack may define a fixed `semver-text` version probe and version constraint. Probe output must contain exactly one semantic version; timeout, failure, ambiguity or incompatibility prevents executable authority.

Discovery captures executable identity and revalidates it after probing. Execution revalidates identity/content evidence immediately before process creation.

## 13. Planning and authentication policy

The planner requires a known pack/command, `risk: read`, non-secret output, a ready identity-verified tool, exact typed values, and no unknown inputs.

Generic `requiresAuth: true` remains blocked unless an implemented auth mode is explicitly declared. Current Conjur read tasks use:

```yaml
requirements:
  requiresAuth: true
  authMode: vendor-session
```

`vendor-session` reuses vendor-owned authentication state. CLIHarbor does not collect or persist vendor passwords, MFA, API keys or tokens and does not provide interactive credential stdin.

Downloading a vendor executable is independent from authenticating it.

## 14. Process execution and platform lifecycle

The executor starts the exact planned executable directly with `os/exec` and an argv slice. Ordinary execution never invokes CMD, PowerShell or POSIX shell command strings.

Each run has a server-generated ID, neutral temporary working directory, execution deadline, bounded stdout/stderr, explicit cancellation, finite WaitDelay, and pre-launch executable identity revalidation.

On Windows each run uses a Job Object. The target starts suspended, enters the Job Object before user code executes, then resumes. Cancellation/timeout tears down the contained process tree.

On macOS/Linux, a dedicated process group is established before the child executes. Cancellation/timeout kills that group, and normal teardown removes surviving descendants within it. This covers descendants that retain the group; a deliberate `setsid`/process-group escape requires a stronger OS sandbox and is not equivalent to Windows Job Object containment.

The separate Windows SaaS/cloud sign-in path uses a private CLIHarbor console host to attach fixed, identity-checked Conjur login to native console devices and retain the vendor result until dismissal. Only the approved path and discovery-time SHA-256 content fingerprint cross this local process boundary; no credential I/O is captured. OIDC/JWT retain hidden vendor-owned launch with a bounded fast-failure check. See ADR-029 and [Authentication](AUTHENTICATION.md).

## 15. Run state, streaming and structured output

The run manager owns bounded in-memory state; there is no persisted run database.

SSE observes manager state rather than owning execution. Disconnect/reconnect does not recreate or cancel a run. Replay and stream concurrency are bounded.

Structured parsing happens only after the authoritative process exits successfully and cannot change executable selection, argv, lifecycle, run ID/status or exit code. Secret-bearing commands remain outside the current normal browser execution envelope.

## 16. Real Conjur 9.x vertical slice

The first-party pack is derived from official `cyberark/conjur-cli-go` v9.3.1 at commit:

```text
7207d6a4a2005130978e10d03d7f6b55ab0216d6
```

The tool is constrained to:

```text
>=9.3.1 <10.0.0
```

It exposes reviewed non-secret read workflows for authenticated identity, resource listing/existence/metadata/permission relationships, and role existence/metadata/members/memberships.

Secret retrieval, interactive login, password/API-key rotation, free-form policy load/replace, issuer create/update, host-factory mutation, deprecated operations, and deployment-specific operations that cannot be generalized are absent from browser authority. Reviewed Conjur variable/permission/value changes run only through approval-gated pack templates (see [Conjur integration](CONJUR_INTEGRATION.md)).

See [Conjur CLI 9.x Integration](CONJUR_INTEGRATION.md).

## 17. Phase 0 evidence boundary

The qualified Windows evaluation ZIP remains an immutable preflight/evidence bundle containing the CLIHarbor executable, discovery-only Phase 0 pack and `EVALUATION_SHA256SUMS`.

The real first-party Conjur pack is compiled into the executable rather than copied into the extracted bundle as another file. Therefore the preflight layout remains unchanged while the normal post-preflight `serve` path needs no second pack artifact.

Phase 0 evidence remains inert and never promotes captured help/output into command authority automatically.

## 18. Diagnostics and privacy

Support diagnostics are allowlisted metadata rather than filesystem/environment scraping. Normal diagnostics exclude command output, argv, executable/candidate paths, PATH/environment values, browser secrets, credentials and managed-download raw errors.

`doctor` is a richer local operator diagnostic and may contain exact filesystem paths; it should not be shared blindly.

## 19. Build and distribution architecture

Production frontend assets and the first-party Conjur pack are embedded into the Go executable. The Windows evaluation artifact remains the primary user download.

CI qualification includes frontend typecheck/lint/tests/build, generated-asset drift checks, Go formatting/vet/tests, race detection, module verification, dependency/vulnerability scans, production browser E2E, Windows/macOS/Linux quality jobs, deterministic Windows evaluation rebuilds, authoritative bundle verification, self-test, extracted-bundle preflight and Phase 0 evidence smoke.

The evaluation checksum covers the CLIHarbor executable and external Phase 0 pack. Because the Conjur pack is embedded, its bytes are transitively part of the qualified executable. The optional Conjur vendor binary is downloaded later and independently verified against its own pinned upstream size/SHA before entering discovery.

Code signing, publisher verification and independent provenance/attestation remain separate release controls.

## 20. State and persistence

Authoritative runtime state is in memory:

- validated pack registry;
- discovery snapshot and executable identity;
- browser session/CSRF state;
- bounded run/event state.

The only current application-managed persistent vendor content is the exact verified Conjur executable under the current-user CLIHarbor cache. It contains no CLIHarbor-owned credentials and is reverified before reuse.

## 21. Failure semantics

Expected failures remain explicit:

- missing tool with auto-setup disabled -> unavailable;
- missing Conjur with failed bootstrap -> unavailable with sanitized remediation;
- ambiguous/incompatible/probe-failed/identity-failed tool -> no auto-replacement and no execution;
- invalid override -> no PATH/bootstrap fallback;
- changed executable -> no execution;
- invalid/unknown browser input -> no plan;
- unsupported auth mode -> no task exposure/plan;
- secret-bearing output -> no normal browser execution;
- non-read risk -> no normal browser execution;
- timeout/cancellation -> platform lifecycle teardown;
- structured parser failure -> raw process evidence remains, no new authority;
- vendor login/permission/network failure -> vendor process failure through the safe run/error boundary.

## 22. Extension rule

New dependency bootstrappers must not become a generic package manager. Each supported automatic dependency requires an explicit reviewed tool identity, immutable version/source/digest contract, platform scope, destination policy, bounded network behavior, regression coverage, enterprise opt-out and ordinary discovery/version/identity qualification after installation.

New execution capabilities must preserve:

```text
trusted validated pack
+ validated typed input
+ authoritative ready executable
-> immutable exact plan
-> bounded direct execution
```

If a feature requires weakening that chain, it needs a new architecture/security decision rather than an ad hoc exception.

## Supported CLI catalog and live activation

The existing pack-declared portable installer now qualifies only the installed
tool, verifies the captured executable hash against the pinned artifact, and
adds it to the run manager only if its prior state was `missing`. Snapshot reads
and replacement use the manager lock; active plans and run records retain their
original evidence. The task/tool catalog swaps under its own lock. Conjur's
existing auth/audit adapters become available after its tool qualifies. Browser
catalog refresh changes navigation metadata only. The pack registry and all
other executable identities remain unchanged. See ADR-031 and
[Supported CLI catalog](CLI_CATALOG.md).

## Conjur Access Explorer contract

The dedicated React Access Explorer consumes the existing authenticated `/api/v1/runs` read-only executor and `/api/v1/tasks` allowlist; it does not introduce a generic Conjur REST proxy, command syntax, or secret-returning API. It checks the read-only task's pack/tool/risk before starting. It binds each result to two observations of the configuration from `/api/v1/conjur/secret-audit`, the tool version/readiness from `/api/v1/tools`, and the CLI session's reviewed `whoami` result. Inconsistencies discard the result. Browser output is restricted to validated resource ID arrays, role relationship arrays and fields derived from a validated full ID. The explorer does not execute raw `resource-show` or `role-show` to avoid storing unconstrained vendor metadata in generic run history. Operators may separately use those existing approved tasks through the generic task runner.

These pre/post checks detect observed context changes but do not provide server-side snapshot isolation or atomic authorization across the duration of a vendor command. Real Conjur authorization remains enforced by the vendor. The explorer is **not** an authoritative effective-access calculator. A future backend-native context-bound operation would be required to make stronger atomicity guarantees.

## Conjur security audit boundary

The reviewed Conjur audit adapter ([ADR-028/ADR-033](DECISIONS.md)) remains separate from generic pack command execution. It reuses vendor-owned configuration/session material to read and classify values only in backend memory. The browser can select the reference detector or bounded text/regex criteria and confirm a backend URL matching that configuration. Snapshots and exports contain scan type, target metadata, IDs and closed reason/failure codes; they never contain patterns or secret values. No shell, dependency, credential store, or additional pack execution authority is introduced.

## Durable mutation journal (current implementation)

The `internal/audittrail` store serializes mutation approval/terminal records in a bounded private JSONL file, with startup chain validation and fsync on append. `internal/runs.Manager` accepts an audit sink and blocks mutations without one or when the sink fails; the `internal/app` startup wires the default user-config journal. Authenticated `GET /api/v1/audit` exposes only bounded metadata to the Runs UI. Detailed read-only run events remain in memory and are not added to the journal. This is metadata-level lifecycle evidence, **not** transactional rollback or external compliance logging. See [Mutation audit and recovery](MUTATION_AUDIT.md).

## Managed CLI install-location recovery

Custom install locations are stored in a bounded (64 KiB) current-user JSON registry. Reads are limited before allocation, and updates replace a fully synced staging file without deleting the previous registry after a failed rename. In live activation mode, the application records a custom location only after executable discovery, version and pinned-content qualification succeed. Rejected installs leave that location unchanged; ordinary launch still independently revalidates managed tools.
