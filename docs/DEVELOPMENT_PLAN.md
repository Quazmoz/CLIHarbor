# Development Plan

## 1. Strategy

Build CLIHarbor as a production-quality vertical slice around a real Idira/CyberArk workflow, with a generic runtime underneath it. Do not begin with universal CLI auto-discovery or a marketplace.

The implementation sequence should minimize speculative work and de-risk the security-sensitive boundaries first.

Current implementation status:

- Phase 1 — local runtime/browser foundation: **implemented**.
- Phase 2 — versioned pack schema/validation/trusted loader foundation: **implemented**.
- Phase 0 — vendor environment inventory: **still required before real Idira/CyberArk command definitions**.
- Phase 3+ — not implemented unless explicitly noted below.

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

Deliberately deferred from this phase:

- HTTP/UI pack exposure;
- startup auto-wiring of repository pack paths;
- binary discovery/version probing;
- execution-plan construction;
- process execution;
- vendor auth adapters;
- real Idira/CyberArk pack definitions.

Acceptance achieved at the component boundary: malformed/unsupported packs fail closed; schema compatibility is enforced; valid trusted sources produce deterministic runtime metadata without creating an execution surface.

## 5. Phase 3 — Tool discovery and version probing — NEXT

Implement against the already-validated pack registry:

- Windows PATH discovery;
- optional explicit configured-path override;
- exact resolved path display;
- safe version-probe representation/implementation without introducing arbitrary shell strings;
- version-constraint checking;
- ambiguous/missing binary UX/model;
- `cliharbor doctor` baseline;
- startup/application wiring that injects the validated registry and discovery state without granting cwd/repository files implicit trust.

Acceptance:

- correct binary/version shown for synthetic fixtures and later verified vendor tools;
- missing tool produces actionable remediation;
- incompatible/ambiguous versions block unsupported tasks rather than guessing;
- browser still cannot choose executable paths.

Phase 0 inventory should run in parallel for the real company CLI environment so Phase 4 can use evidence rather than invented syntax.

## 6. Phase 4 — Secure execution vertical slice

Implement planner + executor first against a purpose-built fixture command. Move to one real read-only Idira/CyberArk command only after Phase 0 evidence exists.

Required:

- typed runtime inputs validated against the already-validated pack definition;
- immutable deterministic execution plan;
- executable path sourced only from trusted discovery, never browser input;
- executable + args execution via `os/exec` without a shell;
- stdout/stderr separation;
- exit code/duration;
- cancellation;
- bounded streaming;
- raw output view;
- sanitized invocation preview;
- run IDs.

Acceptance:

- no shell is invoked for ordinary command execution;
- metacharacters in input remain literal argument data;
- a fixture workflow proves exact argv boundaries;
- after Phase 0, one verified real read-only CLI workflow completes from browser to vendor service;
- raw output matches direct CLI behavior.

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

- Windows child-process-tree cancellation strategy;
- timeouts;
- output backpressure/size limits;
- redaction tests;
- fuzz/property tests for planner/schema boundaries where useful;
- dependency scanning;
- frontend accessibility pass;
- error taxonomy;
- diagnostic bundle/redacted doctor output.

Some schema/parser resource bounds and adversarial pack tests already exist from Phase 2; continue extending them rather than duplicating validation logic.

## 11. Phase 9 — Prove generic architecture

Create a second small fixture pack/tool scenario with materially different safe input/output shapes.

Goal: prove core discovery/planner/executor code is not Idira-specific.

Acceptance:

- second pack loads with no modifications to executor/planner core;
- different command/input/output shapes render successfully;
- any required extension point is documented before adding it.

The Phase 2 synthetic example pack proves generic pack parsing only; it does not yet prove generic execution.

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

Do not require GNU-specific tooling for Windows contributors.

## 15. CI target/current state

Current CI covers frontend install/typecheck/lint/tests/build, generated frontend asset drift, Go formatting/vet/tests, Windows/Linux executable builds, and Linux race testing.

Future additions should include pack-specific static/security checks if they add value beyond `go test ./...`, dependency scanning, and later execution fixture/E2E gates.

Do not claim cross-platform runtime support merely because compilation succeeds.

## 16. Current issue sequence

Completed foundations:

1. Bootstrap Go module + React/Vite frontend.
2. Loopback server + secure browser bootstrap.
3. Pack v1 schema/semantic validation/trusted loader/registry.

Next:

4. Windows binary discovery/version probe over validated tool metadata.
5. Execution planner with typed runtime values.
6. Streaming executor + cancellation.
7. First verified read-only Idira workflow after Phase 0 inventory.
8. Auth adapter + external login orchestration.
9. Structured result renderer.
10. Additional security hardening/evals.
11. Second executable fixture pack scenario.
12. Windows release qualification.

## 17. Implementation guardrail

At every phase ask: “Can this be delegated to the existing CLI instead of being rebuilt in CLIHarbor?” If yes, prefer delegation unless doing so would create a worse security boundary or unusable UX.

Also ask: “Does this new feature widen who can choose the executable, argv structure, filesystem source, credentials, or side effects?” If yes, stop and define the deterministic authorization/validation boundary before implementation.
