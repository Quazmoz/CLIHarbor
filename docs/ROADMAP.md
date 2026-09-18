# Roadmap

## Stage 0 — Foundation

Status: specification stage.

Deliverables:

- product requirements;
- architecture/security/auth model;
- pack specification;
- UX specification;
- research/competitive record;
- development/test plans;
- repository governance.

Exit condition: implementation can start without re-litigating the product boundary.

## Stage 1 — Idira read-only vertical slice

Goal: prove the local-browser architecture with one real, high-value, read-only Idira/CyberArk workflow.

Deliverables:

- Windows loopback server;
- React UI;
- browser bootstrap/session protection;
- pack v1 schema;
- Idira pack skeleton;
- binary discovery/version probing;
- secure direct process execution;
- stdout/stderr streaming;
- raw output and exit state;
- first verified workflow.

Exit condition: a Windows user can complete the workflow from browser to official CLI without CLIHarbor owning credentials.

## Stage 2 — Authentication and structured results

Current status: the generic structured-result foundation is implemented with synthetic fixtures; vendor authentication and vendor-specific schemas remain pending Phase 0 evidence.

Deliverables:

- auth-state adapter;
- vendor-owned login launch;
- session status refresh;
- logout when supported;
- reliable structured-output parser/renderer for at least one verified vendor task;
- raw fallback (**generic foundation implemented**);
- bounded strict scalar JSON parsing + inert cards UI (**implemented generically**);
- redaction hardening.

Exit condition: signed-out -> login -> verified vendor task -> structured result works end-to-end without credential persistence.

## Stage 3 — Useful Idira console

Expand only from real operator needs.

Candidate task categories after exact command discovery:

- identity/session/profile visibility;
- common read-only inventory/search operations;
- common change workflows;
- controlled secret-management operations where output classification is explicit;
- diagnostics.

Add:

- risk badges;
- backend-enforced confirmation;
- context/tenant visibility;
- local run metadata/history policy;
- `cliharbor doctor`.

Exit condition: CLIHarbor is genuinely faster/safer than raw CLI for several recurring internal workflows.

## Stage 4 — Production hardening

Deliverables:

- Windows process-tree cancellation;
- timeouts/output limits;
- strict CSP/security headers;
- security regression suite;
- accessibility pass;
- clean error taxonomy;
- clean Windows release build;
- checksums/SBOM;
- signing when feasible.

Exit condition: suitable for routine internal use under the documented local threat model.

## Stage 5 — Embed into internal company CLI

Goal: reduce adoption friction by making CLIHarbor a natural extension of the already-used company CLI.

Potential UX:

```text
company-cli ui
company-cli ui --pack idira
```

Deliverables depend on host CLI technology, but the browser contract and pack system should remain unchanged.

Exit condition: internal users do not need to install/learn a separate front-door tool beyond the approved company CLI distribution path.

## Stage 6 — Prove multi-CLI engine

Add a second materially different pack selected from real demand.

Selection criteria:

- recurring user pain;
- poor/absent GUI;
- stable CLI semantics;
- reasonable licensing/distribution story;
- useful structured output;
- no dominant high-quality existing GUI that makes the pack redundant.

A fixture/test pack does not count as market validation; this stage needs a real second tool.

Exit condition: two real packs run on the same core without vendor-specific branching in planner/executor.

## Stage 7 — Pack authoring tooling

Potential features:

- `cliharbor pack init`;
- schema editor/validation;
- capture `--help` trees;
- generate a draft pack from help/man output;
- AI-assisted draft generation as an optional authoring aid;
- fixture generation;
- `cliharbor pack test`;
- security linter;
- compatibility matrix.

Generated packs must remain reviewable artifacts. Runtime execution should never depend on an LLM making live security-sensitive command decisions.

## Stage 8 — Public pack ecosystem (optional)

Only pursue if actual adoption supports it.

Prerequisites:

- pack signatures;
- publisher identity;
- capability manifest;
- static linting;
- version/update policy;
- trust UI;
- malicious-pack threat-model expansion.

A marketplace is not required for CLIHarbor to be successful as an internal/enterprise tool.

## Stage 9 — Cross-platform expansion

Potential order:

1. Windows — primary/initial.
2. Linux — likely straightforward for non-interactive execution.
3. macOS — later, with signing/notarization considerations.

Cross-platform support should be declared only after real end-to-end tests, not merely cross-compilation.

## Explicitly deferred

- cloud-hosted control plane;
- arbitrary remote execution;
- multi-user remote server;
- built-in credential vault;
- full terminal emulator;
- “support every CLI automatically” promise;
- community marketplace before trust/signature model exists;
- mobile client.

## Product validation loop

After each pack/workflow ships:

1. measure whether it replaces repeated manual CLI steps;
2. record confusing fields/errors;
3. identify new high-value workflow requests;
4. decide whether the solution belongs in the generic pack model or a narrow adapter;
5. avoid adding abstraction until at least two real use cases need it.
