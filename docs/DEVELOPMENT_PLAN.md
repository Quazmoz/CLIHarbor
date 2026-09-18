# Development Plan

## 1. Strategy

Build CLIHarbor as a production-quality vertical slice around a real Idira/CyberArk workflow, with a generic runtime underneath it. Do not begin with universal CLI auto-discovery or a marketplace.

The implementation sequence should minimize speculative work and de-risk the security-sensitive boundaries first.

Current implementation status:

- Phase 1 — local runtime/browser foundation: **implemented**.
- Phase 2 — versioned pack schema/validation/trusted loader foundation: **implemented**.
- Phase 3 — tool discovery/version probing/doctor foundation: **implemented**.
- Phase 4a — deterministic planner/executor and Windows process lifecycle: **implemented**.
- Phase 0 — vendor environment inventory: **still required before real Idira/CyberArk command definitions**.
- Phase 4b+ — browser/integration/auth/structured-output milestones remain incomplete unless explicitly noted below.

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

This is an internal backend boundary. It is not yet exposed as a browser run API.

### Phase 4b — fixture-backed integration — NEXT

Before adding browser execution endpoints, prove the complete internal chain with a purpose-built fixture:

```text
trusted fixture pack
  -> registry
  -> discovery
  -> planner
  -> executor
  -> bounded events/result
```

Prefer an automated integration test and, only if it adds diagnostic value without widening authority, a narrowly scoped internal/CLI fixture diagnostic. Do not add arbitrary executable/path/argv inputs.

Acceptance for Phase 4b:

- one fixture workflow traverses the real registry/discovery/planner/executor path;
- exact argv/output/exit/cancellation evidence matches direct fixture behavior;
- no shell/browser-selected execution authority is introduced;
- no vendor command syntax is invented.

After Phase 4b, a browser execution API can be designed against the already-proven backend boundary with Host/Origin/CSRF/session controls and bounded streaming.

Real Idira/CyberArk workflows remain blocked on Phase 0 inventory.

## 7. Phase 5 — Structured output

For a command with reliable machine-readable output:

- request documented JSON/structured output;
- parse into a typed normalized result;
- render table/card;
- retain raw output fallback;
- test malformed/unexpected output.

Acceptance:

- parser failure does not hide vendor output or report false success;
- secret-bearing fields are not persisted.

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

- persisted/browser-stream backpressure and bounded run-history policy when run APIs arrive;
- redaction tests;
- fuzz/property tests for planner/schema boundaries where useful;
- dependency scanning;
- frontend accessibility pass;
- error taxonomy;
- diagnostic bundle/redacted doctor output;
- optional publisher/signature/hash verification where enterprise policy requires stronger PATH-binary identity.

Schema/parser resource bounds, adversarial pack tests, discovery ambiguity handling, and bounded version probes already exist; continue extending them rather than duplicating validation logic.

## 11. Phase 9 — Prove generic architecture

Create a second small fixture pack/tool scenario with materially different safe input/output shapes.

Goal: prove core discovery/planner/executor code is not Idira-specific.

Acceptance:

- second pack loads/discovers with no modifications to core;
- different command/input/output shapes render successfully;
- any required extension point is documented before adding it.

The Phase 2/3 synthetic example pack proves generic pack parsing/discovery only; it does not yet prove generic task execution.

## 12. Phase 10 — Packaging

Produce Windows release artifacts:

- frontend embedded into executable;
- no Node runtime required at runtime;
- clear release version;
- checksums;
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
go run ./tools/task check
go run ./tools/task go-build
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

Current CI covers frontend install/typecheck/lint/tests/build, generated frontend asset drift, Go formatting/vet/tests, Windows/Linux executable builds, and Linux race testing.

Discovery tests are ordinary Go tests and therefore belong to the same Windows/Linux gates. Future additions should include execution fixture/E2E gates, dependency scanning, and any pack-specific static/security checks that add value beyond `go test ./...`.

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

7. Fixture-backed registry -> discovery -> planner -> executor integration proof.
8. Browser execution API/streaming boundary for read-only fixture tasks.
9. First verified read-only Idira workflow after Phase 0 inventory.
10. Auth adapter + external login orchestration.
11. Structured result renderer.
12. Additional security hardening/evals.
13. Second executable fixture pack scenario.
14. Windows release qualification.

## 17. Implementation guardrail

At every phase ask: “Can this be delegated to the existing CLI instead of being rebuilt in CLIHarbor?” If yes, prefer delegation unless doing so would create a worse security boundary or unusable UX.

Also ask: “Does this new feature widen who can choose the executable, argv structure, filesystem source, credentials, or side effects?” If yes, stop and define the deterministic authorization/validation boundary before implementation.
