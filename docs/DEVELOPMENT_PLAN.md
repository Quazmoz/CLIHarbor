# Development Plan

## 1. Strategy

Build CLIHarbor as a production-quality vertical slice around a real Idira/CyberArk workflow, with a generic runtime underneath it. Do not begin with universal CLI auto-discovery or a marketplace.

The implementation sequence should minimize speculative work and de-risk the security-sensitive boundaries first.

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

## 3. Phase 1 — Skeleton and local runtime

Create:

```text
cmd/cliharbor
internal/app
internal/server
web
```

Implement:

- Go executable starts on loopback ephemeral port;
- frontend assets served locally;
- development mode proxies/serves Vite safely;
- default browser launch;
- graceful shutdown;
- version endpoint;
- per-launch browser session/bootstrap protection;
- strict Host/Origin handling.

Acceptance:

- `cliharbor` opens a browser on Windows;
- no non-loopback listener exists;
- cross-origin state-changing request is rejected;
- shutdown releases port cleanly.

## 4. Phase 2 — Pack schema and loader

Create:

```text
schemas/pack.v1.schema.json
internal/packs
packs/idira/pack.yaml
```

Implement:

- YAML parse;
- JSON Schema validation;
- semantic validation;
- pack metadata API;
- navigation/task exposure;
- invalid-pack fail-closed behavior.

Start with only enough schema to represent the first read-only workflow.

Acceptance:

- malformed/unsupported packs cannot execute;
- frontend can render task metadata from the pack;
- schema version compatibility is enforced.

## 5. Phase 3 — Tool discovery and version probing

Implement:

- Windows PATH discovery;
- optional configured-path override;
- exact resolved path display;
- version probe from pack definition;
- version-constraint checking;
- ambiguous/missing binary UX;
- `cliharbor doctor` baseline.

Acceptance:

- correct binary/version shown;
- missing tool produces actionable remediation;
- incompatible version blocks unsupported tasks rather than guessing.

## 6. Phase 4 — Secure execution vertical slice

Implement planner + executor for one safe read-only Idira/CyberArk command.

Required:

- typed inputs;
- server-side validation;
- executable + args execution via `os/exec`;
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
- a real read-only CLI workflow completes from browser to vendor service;
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

Add:

- Windows child-process-tree cancellation strategy;
- timeouts;
- output backpressure/size limits;
- CSP/security headers;
- redaction tests;
- fuzz/property tests for planner/schema boundaries where useful;
- dependency scanning;
- frontend accessibility pass;
- error taxonomy;
- diagnostic bundle/redacted doctor output.

## 11. Phase 9 — Prove generic architecture

Create a second small test pack for a harmless ubiquitous CLI or a purpose-built fixture executable.

Goal: prove core code is not Idira-specific.

Acceptance:

- second pack loads with no modifications to executor/planner core;
- different command/input/output shapes render successfully;
- any required extension point is documented before adding it.

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

## 14. Development commands target

Aim for a simple contributor experience such as:

```text
make dev
make test
make lint
make build
```

or equivalent cross-platform scripts that work on Windows without requiring GNU-specific tooling. If using a Makefile, also provide PowerShell or Go-based task entry points for Windows.

## 15. CI target

Initial GitHub Actions should eventually cover:

- Go format/vet/test;
- frontend typecheck/lint/test;
- pack schema validation;
- security/static analysis;
- Windows build/test;
- Linux build as portability signal after Windows MVP stabilizes.

Do not claim cross-platform support merely because compilation succeeds.

## 16. First implementation issue sequence

Recommended first backlog:

1. Bootstrap Go module + React/Vite frontend.
2. Loopback server + secure browser bootstrap.
3. Pack v1 schema/loader.
4. Windows binary discovery/version probe.
5. Execution planner with typed args.
6. Streaming executor + cancellation.
7. First verified read-only Idira workflow.
8. Auth adapter + external login orchestration.
9. Structured result renderer.
10. Security hardening/tests.
11. Second fixture pack.
12. Windows release build.

## 17. Implementation guardrail

At every phase ask: “Can this be delegated to the existing CLI instead of being rebuilt in CLIHarbor?” If yes, prefer delegation unless doing so would create a worse security boundary or unusable UX.
