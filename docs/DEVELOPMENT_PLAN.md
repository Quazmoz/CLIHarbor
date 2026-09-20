# Development Plan

## 1. Strategy

Build CLIHarbor as a production-quality vertical slice around a real Idira/CyberArk workflow, with a generic runtime underneath it. Do not begin with universal CLI auto-discovery or a marketplace.

The implementation sequence should minimize speculative work and de-risk the security-sensitive boundaries first.

Current implementation status:

- Phase 1 — local runtime/browser foundation: **implemented**.
- Phase 2 — versioned pack schema/validation/trusted loader foundation: **implemented**.
- Phase 3 — tool discovery/version probing/doctor foundation: **implemented**.
- Phase 4a — deterministic planner/executor and Windows process lifecycle: **implemented**.
- Phase 4b — fixture-backed loader/discovery/planner/executor integration: **implemented**.
- Phase 4c-A — authenticated create/get/cancel run API with bounded in-memory polling: **implemented**.
- Phase 4c-B — bounded live SSE replay plus minimal safe task/run UI: **implemented**.
- Phase 0 — vendor environment inventory: **still required before real Idira/CyberArk command definitions**.
- Phase 5 — generic bounded structured-output vertical slice: **implemented with fixture schemas/results; real vendor schemas remain blocked on Phase 0**.
- Phase 6+ — vendor auth orchestration and later release milestones remain incomplete unless explicitly noted below.

## 2. Phase 0 — Environment inventory

Before writing vendor-specific execution code:

- record the exact Windows versions used for development/test;
- record installed `idsec` and `conjur` versions;
- capture `--help`/version output and command trees for the deployed versions;
- identify safe read-only status/list commands;
- identify available JSON/structured-output flags;
- document login/status/logout behavior;
- identify commands that prompt interactively;
- classify sensitive outputs and destructive operations;
- identify how the existing internal company CLI could embed/launch CLIHarbor.

Deliverable: verified command inventory and first two candidate workflows.

This remains a hard blocker for vendor-specific pack contents. Do not substitute guessed vendor commands.

## 3. Phase 1 — Skeleton and local runtime — IMPLEMENTED

Created:

```text
cmd/cliharbor
internal/app
internal/server
internal/webui
internal/platform/browser
web
tools/task
```

Implemented:

- Go executable starts on IPv4 loopback ephemeral port;
- frontend assets served locally/embedded for production;
- development mode proxies Vite through a constrained loopback-only boundary;
- default browser launch;
- graceful shutdown;
- authenticated status endpoint;
- per-launch browser session/bootstrap protection;
- strict Host/Origin/CSRF handling;
- Windows/Linux CI and cross-platform task tooling.

## 4. Phase 2 — Pack schema and loader — IMPLEMENTED

Created:

```text
schemas/pack.v1.schema.json
schemas/embed.go
internal/packs/
packs/example/pack.yaml
```

Implemented:

- `cliharbor.dev/v1` typed pack model;
- bounded UTF-8 YAML parsing;
- rejection of aliases/anchors/merge keys/multiple documents/custom tags/duplicate keys/excessive depth or node count;
- embedded Draft 2020-12 JSON Schema validation with strict unknown-field rejection;
- semantic validation for tool/input references, input constraints, enum mappings, optional argument layout, output sensitivity, and supported schema version;
- security validation preventing executable paths, browser-selectable executable shapes, generic interpolation/free-form positional values, and common shell/interpreter tool declarations;
- deterministic trusted loading from built-in bytes or explicitly named local files/directories;
- no cwd/repository auto-discovery, remote URL loading, pack downloads, or plugin code;
- symlink/non-regular local entry rejection and bounded file reads;
- deterministic effectively immutable registry with pack/tool/command lookup;
- regression coverage for the primary structural, semantic, trust, ordering, resource-bound, and injection failure modes;
- synthetic non-vendor example pack only.

Acceptance achieved at the component boundary: malformed/unsupported packs fail closed; schema compatibility is enforced; valid trusted sources produce deterministic runtime metadata without creating a general execution surface.

## 5. Phase 3 — Tool discovery and version probing — IMPLEMENTED

Created/extended:

```text
internal/discovery/
internal/app/runtime.go
internal/app/doctor.go
cmd/cliharbor doctor
```

Implemented:

- pack-declared fixed version probes using the `semver-text` parser;
- optional bounded probe timeout metadata;
- semantic version constraints parsed with `Masterminds/semver`;
- Windows-first executable discovery with portable core behavior;
- PATH scanning restricted to absolute entries so empty/relative/current-directory PATH elements do not silently gain executable authority;
- Windows basename handling for exact names plus `.exe`/`.com` binary forms, without enabling batch/PowerShell/script-host extensions;
- deterministic candidate de-duplication and ordering;
- explicit backend-only `--tool-path pack/tool=/absolute/path` overrides;
- override validation against an already-declared pack/tool executable basename;
- invalid overrides are authoritative failures rather than triggers to fall back to PATH;
- missing/ambiguous/incompatible/probe-failed/unsupported-platform state modeling;
- multiple candidate matches fail closed rather than selecting the first PATH result;
- direct `os/exec` version probes using fixed pack-authored argv, no shell, bounded stdout/stderr capture, timeout, and sanitized failure messages;
- semantic-version output parsing that rejects no-version and multiple-distinct-version output instead of guessing;
- exact resolved executable path and version evidence through `cliharbor doctor`;
- startup loading/discovery only for explicitly configured pack files/directories; no repository/cwd auto-trust;
- startup health counts without changing the current generated React assets.

Deliberately deferred:

- browser tool-status/task UI;
- persistent tool-path configuration files;
- publisher/signature/hash validation of discovered binaries;
- child-process-tree control for version probes beyond the bounded direct process timeout;
- planner/task execution;
- real vendor definitions.

Acceptance at this phase boundary:

- a single matching executable resolves deterministically;
- exact path/version/constraint evidence is available through `doctor`;
- missing tools produce remediation guidance;
- ambiguous candidates, incompatible versions, invalid overrides, and probe failures remain unavailable rather than being guessed through;
- browser input still cannot select executable paths;
- no pack is loaded merely because it is present in the repository/current directory.

Phase 0 inventory should run in parallel for the real company CLI environment so Phase 4 can use evidence rather than invented syntax.

## 6. Phase 4 — Secure execution vertical slice — IN PROGRESS

### Phase 4a — low-level planner/executor — IMPLEMENTED

Implemented against fixture-oriented tests:

- typed runtime inputs validated against already-validated pack definitions;
- deterministic execution plans requiring current `ready` discovery state and matching pack version;
- executable path/name/version plus discovery-time file identity sourced only from authoritative discovery state;
- exact pack-authored argv construction; browser/user values cannot choose executable path/name, flags, subcommands, or arbitrary argv structure;
- direct `os/exec` invocation with no shell for ordinary task execution;
- read-only policy enforced in both planner and executor;
- auth-required, secret-bearing, change, destructive, interactive, and credential-sensitive commands blocked;
- same-path executable replacement rejected at the execution boundary;
- generated run IDs, neutral temporary working directories, separate stdout/stderr events, bounded per-stream output, total deadlines, cancellation, non-zero exit preservation, and `WaitDelay`;
- platform lifecycle abstraction with Windows Job Object ownership established before the target resumes so descendants cannot escape the run boundary;
- cancellation/timeout/output-limit/sink-failure and normal teardown clean up Windows descendants;
- regression coverage for malformed values, exact argv, Unicode/spaces, cancellation races, setup failures, temp-directory cleanup, and descendant/inherited-handle behavior.

Phase 4a established the internal backend boundary. Phase 4c-A now exposes only its constrained read-only create/get/cancel surface through the authenticated loopback API.

### Phase 4b — fixture-backed integration — IMPLEMENTED

The automated integration test now proves:

```text
explicit trusted fixture pack
  -> parser/schema/semantic validation
  -> registry
  -> discovery + backend-only absolute override
  -> fixed version probe/constraint
  -> typed planner
  -> executor
  -> bounded events/result
```

Implemented acceptance:

- fixture workflows traverse the real registry/discovery/planner/executor path;
- exact argv including zero-valued integer/Unicode/metacharacters is asserted;
- stdout/stderr and exit code are compared with direct invocation;
- non-zero exit semantics remain intact;
- cancellation after observable output is exercised;
- no shell/browser-selected execution authority is introduced;
- no vendor syntax is invented.

### Phase 4c — authenticated browser execution boundary — IMPLEMENTED

#### Phase 4c-A — create/get/cancel polling API — IMPLEMENTED

Implemented:

- server-side `packId`/`commandId` plus typed `values` only; executable/path/argv fields are rejected;
- existing session, exact Host, Origin, and CSRF controls applied to run mutations;
- authenticated status exposes the per-session CSRF token to same-origin frontend code;
- strict bounded UTF-8 JSON parsing with duplicate-key and unknown-field rejection;
- bounded in-memory run manager with server-generated IDs, active/retained limits, finite timeout, bounded output/event bytes, and no persistence;
- browser-safe run snapshots with Base64 output data and no executable/argv authority;
- duplicate read-only POSTs create separate bounded runs; mutating/idempotency semantics remain deferred with mutating execution disabled;
- request disconnect after accepted creation does not implicitly terminate the run; explicit cancellation or application shutdown owns termination;
- tests for hostile origin, missing CSRF/session, execution-authority substitution, malformed/duplicate/oversize input, cancellation, output exhaustion, retention/capacity, shutdown, and full bootstrap-to-execution integration.

#### Phase 4c-B — live events and minimal fixture UI — IMPLEMENTED

Implemented:

- authenticated `GET /api/v1/runs/{runId}/events` using Server-Sent Events;
- monotonic manager-owned event sequence plus strict `Last-Event-ID` replay and deterministic impossible-cursor rejection;
- SSE observes only bounded in-memory manager state; executor sinks never write to HTTP and no per-client output queue is introduced;
- long-lived SSE handlers are bounded (default 16), with excess observers rejected without touching process execution;
- ordinary server write deadlines are disabled for the long-lived stream while each write/flush retains a finite bound and heartbeat;
- stream disconnect/reconnect neither cancels nor recreates execution; explicit cancel remains authoritative;
- authenticated read-only task metadata exposes only ready, read-only, non-auth, non-secret commands and typed input constraints;
- authenticated read-only tool diagnostics expose sanitized readiness/version/remediation without executable paths, candidate paths, file identity, argv, environment, or pack-source authority;
- minimal React task/run UI with typed inputs, live stdout/stderr, state/exit display, and cancellation;
- CSRF token retained only in frontend runtime memory and sent only on same-origin mutations;
- output rendered as inert React text, never raw HTML;
- regression coverage for manager replay, cursor rejection, stream authentication/disconnect, safe task filtering, sanitized tool diagnostics, typed browser requests, bounded reconnect/reconciliation, and markup-like output rendering.

Production embedded-server real-browser E2E is implemented in CI. It covers bootstrap/session, Host/Origin/CSRF behavior, authenticated task loading, fixture execution, live SSE, browser-native reconnect/`Last-Event-ID`, bounded stream-failure handling and reconciliation, explicit retry/cancellation, retained-run eviction, single-execution semantics, and inert hostile output. Low-level slow-reader behavior is qualified separately with a raw-TCP regression that stops consuming after SSE headers and proves the five-second per-write deadline releases the observer slot without cancelling execution.

Do not expose auth-required, secret-bearing, mutating, destructive, interactive, or credential-sensitive commands in Phase 4c.

Real Idira/CyberArk workflows remain blocked on Phase 0 inventory.

## 7. Phase 5 — Structured output — IMPLEMENTED GENERIC FOUNDATION

Implemented with synthetic fixture commands only:

- pack-declared strict scalar JSON schemas with a cards renderer;
- bounded post-execution parsing into a normalized backend DTO;
- 64 KiB structured-input, 8 KiB string, and 32-field limits;
- strict duplicate/unknown-field, type, UTF-8, integer-range, nesting, trailing-data, and control-character rejection;
- raw stdout/stderr retained independently of parser outcome;
- parser status kept separate from authoritative run status/exit code;
- no second execution and no parsed-data feedback into planner/executor authority;
- normalized results bound directly to the same-run authenticated SSE completion, with snapshot GET retained only for reconnect recovery;
- temporary structured parse buffers released after normalization to avoid retained-run memory amplification;
- structured rendering refused for secret-bearing output or sensitive fields;
- browser-side DTO validation plus inert React text rendering;
- fixture coverage for success, malformed/wrong/unknown/large/markup/non-zero/stderr/Unicode/secret-like/duplicate/invalid-UTF8/overflow/nested/control cases plus completion/replay isolation.

Acceptance achieved for the generic engine. Real Idira/CyberArk structured flags and schemas are still prohibited until Phase 0 inventory verifies them.

## 8. Phase 6 — Authentication integration

Implement auth adapter/status UI.

Start with vendor-owned external interactive login if needed:

- Sign in button launches approved CLI login;
- browser shows pending state;
- completion triggers status refresh;
- logout uses vendor command if documented;
- no password/MFA/token enters persistent CLIHarbor state.

Acceptance:

- login works with real company auth flow;
- credentials/tokens absent from application logs/history;
- cancelled/failed login recovers cleanly.

## 9. Phase 7 — First useful Idira task set

Expand piecemeal based on real internal demand.

Target a balanced set:

- environment/auth/status;
- a few high-frequency read-only tasks;
- at least one normal mutating task with confirmation;
- only then one destructive task if genuinely useful and safe.

Do not aim for complete CLI parity.

## 10. Phase 8 — Hardening

Add/complete:

- continue real-browser stream hardening beyond the implemented bounded replay, server observer cap, five-consecutive-failure client retry budget, snapshot reconciliation, and explicit manual retry;
- any future persisted run-history policy; current run history is bounded and in-memory only;
- redaction tests;
- fuzz/property tests for planner/schema boundaries where useful;
- dependency scanning with locked-tree `npm audit` and pinned `govulncheck@v1.8.0` in CI; **implemented**
- frontend accessibility pass; **implemented for the current task/run/error surface** with field-linked errors, focus handling, targeted live regions, keyboard-operable controls, explicit stream/cancel/timeout/eviction text, and focusable raw-output regions;
- error taxonomy; **implemented for the current browser/runtime boundary** with stable typed codes/categories, reviewed safe remediation, optional validated field association, terminal run failure DTOs, and unknown-code fail-safe handling;
- privacy-preserving diagnostic bundle; **implemented** as deterministic allowlisted \`cliharbor.diagnostics/v1\` export with bounded no-clobber filesystem publication;
- redacted doctor output remains optional/future; current \`doctor\` is explicitly operator-local and may expose exact paths;
- optional publisher/signature/hash verification where enterprise policy requires stronger PATH-binary identity.

Schema/parser resource bounds, adversarial pack tests, discovery ambiguity handling, and bounded version probes already exist; continue extending them rather than duplicating validation logic.

## 11. Phase 9 — Prove generic architecture — IMPLEMENTED

A second explicit-local synthetic fixture pack/tool now traverses the unchanged registry/discovery/planner/executor path with a distinct tool ID, semantic version probe, command name, string+enum inputs, and argv mapping.

Acceptance achieved:

- the second pack loads/discovers with no core modification;
- exact alternate argv/stdout/stderr/exit behavior is compared with direct fixture invocation;
- the primary pack cannot resolve the alternate pack's command;
- authenticated task metadata reports both pack/tool/version scopes correctly;
- no vendor syntax, credential, shell wrapper, or browser-selected execution authority is introduced.

## 12. Phase 10 — Packaging

Produce Windows release artifacts:

- frontend embedded into executable;
- no Node runtime required at runtime;
- clear release version;
- SHA-256 checksum beside ordinary local build artifacts via `bin/SHA256SUMS`; **implemented**
- one authoritative Windows evaluation manifest, `EVALUATION_SHA256SUMS`, covering the evaluation executable plus trusted Phase 0 pack; the local compatibility manifest is excluded from evaluation packaging; **implemented**
- exact `.go-version` toolchain enforcement, controlled evaluation build inputs, and isolated double-build authoritative-manifest equality qualification; **implemented**
- optional code signing when available;
- `cliharbor doctor` included;
- upgrade story documented.

## 13. Phase 11 — Internal CLI integration

Once standalone behavior is stable, evaluate integration with the existing company CLI.

Possible forms:

1. directly import/embed Go runtime if compatible;
2. launch CLIHarbor companion binary from company CLI;
3. expose a small local-process contract if host CLI is another language.

Preserve the same browser API/pack semantics.

## 14. Development commands

Current cross-platform Go task entry point:

```text
go run ./tools/task web-dev
go run ./tools/task web-build
go run ./tools/task verify-web-sync
go run ./tools/task check
go run ./tools/task go-build
go run ./tools/task windows-eval
go run ./tools/task verify-windows-eval
go run ./tools/task verify-windows-eval-repro
go run ./tools/task build
```

Current pack/discovery diagnostics:

```text
go run ./cmd/cliharbor doctor --pack-file <pack.yaml>
go run ./cmd/cliharbor doctor --pack-dir <explicit-directory>
go run ./cmd/cliharbor doctor --pack-file <pack.yaml> --tool-path pack/tool=<absolute-path>
```

Do not require GNU-specific tooling for Windows contributors.

## 15. CI target/current state

Current CI covers frontend install/typecheck/lint/tests/build, generated frontend asset drift, Go module verification, formatting/vet/tests, Windows/Linux executable builds, Linux race testing, dependency vulnerability scanning, the production embedded-server Chrome/Chromium E2E gate on Linux, and Windows evaluation-artifact qualification. All jobs resolve the exact Go patch release from `.go-version`; the Windows evaluation job additionally requires the produced upload candidate and two isolated same-checkout rebuilds to share the same authoritative manifest before upload.

Discovery and fixture integration tests remain ordinary Go tests in the Windows/Linux quality gates. The browser E2E is an explicit Linux CI step because it requires a real installed browser; managed-Windows browser/PATH/antivirus behavior remains a separate manual acceptance boundary.

Do not claim cross-platform runtime support merely because compilation succeeds.

## 16. Current issue sequence

Completed foundations:

1. Bootstrap Go module + React/Vite frontend.
2. Loopback server + secure browser bootstrap.
3. Pack v1 schema/semantic validation/trusted loader/registry.
4. Windows-first binary discovery/version probes/doctor.
5. Typed read-only execution planner with discovery identity gating.
6. Bounded direct executor with Windows Job Object descendant ownership.

Next:

7. Fixture-backed registry -> discovery -> planner -> executor integration proof. **Implemented.**
8. Authenticated create/get/cancel polling API for read-only fixture tasks. **Implemented.**
9. Bounded live event streaming plus minimal fixture task/run UI. **Implemented.**
10. First verified read-only Idira workflow after Phase 0 inventory. **Next product milestone.**
11. Auth adapter + external login orchestration.
12. Structured result renderer.
13. Additional security hardening/evals.
14. Second executable fixture pack scenario. **Implemented.**
15. Windows release qualification.

## 17. Implementation guardrail

At every phase ask: “Can this be delegated to the existing CLI instead of being rebuilt in CLIHarbor?” If yes, prefer delegation unless doing so would create a worse security boundary or unusable UX.

Also ask: “Does this new feature widen who can choose the executable, argv structure, filesystem source, credentials, or side effects?” If yes, stop and define the deterministic authorization/validation boundary before implementation.

## Work-laptop test-readiness milestone

**Implemented in `main`.** This milestone converts the completed Phase 1-5 foundations into a controlled first-environment test path without adding real vendor tasks.

Acceptance implemented:

- deterministic Windows x64 unsigned evaluation build and checksum;
- build/source identity via `cliharbor version`;
- vendor-free `cliharbor self-test`;
- sanitized trusted-pack `cliharbor inventory`;
- inventory-only packs with zero commands;
- optional fixed named help probes plus the existing fixed version probe;
- direct bounded evidence execution with Windows process-tree ownership and executable fingerprint revalidation;
- strongly typed `cliharbor.phase0/v1` evidence export with atomic non-overwriting file creation;
- discovery-only Idira/CyberArk Phase 0 pack with no guessed command/probe argv;
- CI qualification and artifact upload;
- exact company-managed Windows procedure in `WORK_LAPTOP_EVALUATION.md`.

The next milestone is **real Phase 0 evidence collection on the target company laptop**. Use that evidence to author the first real read-only Idira/CyberArk pack. Do not add vendor command trees, auth flows, version constraints, or structured schemas until supported by the returned evidence.

## Phase 0 evidence-review foundation

**Implemented in `main`.** CLIHarbor can strictly ingest and review its own `cliharbor.phase0/v1` files with `cliharbor evidence inspect <file>`. The importer is bounded, rejects symlinks and observed file races, disallows unknown/duplicate JSON fields, enforces evidence ID/version/provenance/state/timestamp/sanitization invariants, and renders a deterministic operator report with explicit evidence gaps plus PROVES / UNKNOWN / BLOCKED classifications.

This does not advance the vendor-command authority boundary. The next external milestone remains collection and human review of evidence from the company-managed laptop. The first real read-only Idira/CyberArk workflow may be authored only after that evidence (or approved documentation) proves exact command behavior.

## Phase 0 evidence-transfer integrity milestone

**Implemented in `main`.** Phase 0 export now emits a SHA-256 for the exact bytes written, `evidence checksum <file>` validates and hashes a received bundle, and `evidence inspect --sha256 <digest> <file>` fails closed before rendering if an independently retained digest does not match. The gated Windows evaluation artifact job exercises that complete vendor-free export/checksum/verified-inspect flow with the packaged executable before upload.

This is intentionally detached from `cliharbor.phase0/v1` and does not alter vendor-command authority. The external gate remains collection of genuine company-laptop evidence and human factual review before the first real read-only Idira/CyberArk workflow.


Evaluation packaging hardening: `windows-eval` now invalidates stale generated checksum authority, emits root `EVALUATION_SHA256SUMS` as the sole evaluation checksum manifest covering the Windows evaluation executable and shipped trusted Phase 0 pack, and leaves `bin/SHA256SUMS` to ordinary local-build compatibility only. `verify-windows-eval` enforces the exact manifest/path/digest contract, and CI reruns it immediately before uploading exactly the covered files plus the manifest. This is integrity-only and does not replace signing/attestation.


## Phase 8 diagnostic-export checkpoint — IMPLEMENTED

Acceptance achieved:

- `cliharbor diagnostics export <output>` is production code, not a log scraper;
- bundle construction is a strict allowlist and cannot represent stdout/stderr, argv, environment values, executable/candidate paths, pack-source paths, browser secrets, or credential material;
- schema/version and scalar/list/resource bounds fail closed;
- records have deterministic ordering and equal state produces equal JSON bytes;
- output is capped at 64 KiB;
- destination must be explicit and no-clobber;
- symlink/non-regular destinations and unsafe parents are rejected, including checked Windows reparse-point parents;
- same-directory staging is private where portable, synced, cleaned on pre-activation failure/cancellation, and atomically/no-replace activated;
- concurrent same-destination exports allow exactly one winner;
- SHA-256 is reported for byte comparison without being described as signing/attestation;
- regression coverage includes secret/path/environment/output sentinels and filesystem/concurrency failures.

The remaining Phase 8 items should continue independently; this checkpoint does not authorize real vendor commands or secret-bearing workflows.
