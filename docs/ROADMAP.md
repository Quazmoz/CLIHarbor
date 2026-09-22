# Roadmap

CLIHarbor's foundation and first real vendor read-only integration are now implemented. The roadmap is therefore organized around qualification and controlled capability expansion rather than generic infrastructure invention.

## Stage 0 — Foundation

**Status: complete.**

Implemented:

- product/architecture/security/auth specifications;
- Windows-first local runtime;
- trusted pack model and schema;
- React browser UI;
- repository governance and test strategy.

## Stage 1 — Generic read-only execution platform

**Status: complete.**

Implemented:

- authenticated loopback browser boundary;
- explicit trusted pack loading;
- deterministic executable discovery/version probing;
- executable identity capture/revalidation;
- typed request validation and deterministic argv planning;
- bounded direct process execution;
- Windows Job Object lifecycle containment;
- bounded run state, SSE streaming/replay and cancellation;
- structured scalar JSON cards plus raw fallback;
- operator-safe error taxonomy;
- privacy-preserving diagnostics.

## Stage 2 — Managed-Windows evaluation and evidence

**Status: complete generically; environment qualification remains external.**

Implemented:

- unsigned Windows x64 evaluation artifact;
- authoritative `EVALUATION_SHA256SUMS`;
- deterministic isolated rebuild verification;
- vendor-free self-test;
- immutable extracted-bundle preflight;
- discovery-only Idira/CyberArk Phase 0 pack;
- bounded help/evidence probes;
- sanitized evidence export/inspection/checksum flow.

The evaluation path does not require administrator rights, Go, Node/npm, Git, PowerShell or outbound internet access.

## Stage 3 — Conjur 9.x read-only vertical slice

**Status: implemented from authoritative upstream evidence; managed-laptop qualification pending.**

The repository now includes `packs/conjur/conjur-v9.yaml`, derived from the official `cyberark/conjur-cli-go` v9.3.1 release and commit `7207d6a4a2005130978e10d03d7f6b55ab0216d6`.

Implemented workflows:

- current authenticated identity (`whoami`);
- resource listing with bounded approved filters;
- resource exists/show/permitted-roles;
- role exists/show/members/memberships.

Supporting platform work:

- constrained positional input: one validated scalar -> exactly one argv element;
- explicit `vendor-session` authentication mode;
- generic auth-required tasks remain blocked unless that mode is declared;
- no credential stdin/argv/persistence;
- Conjur version constraint `>=9.3.1 <10.0.0`;
- fixed help probes for deployed-command comparison.

See [Conjur CLI 9.x Integration](CONJUR_INTEGRATION.md).

### Exit condition

On the target company-managed Windows laptop:

1. CLIHarbor evaluation preflight succeeds;
2. the intended corporate `conjur.exe` resolves unambiguously;
3. version probing satisfies the trusted pack constraint;
4. relevant help probes agree with the expected command surface;
5. at least one non-secret read workflow succeeds using the approved existing vendor session.

Online source evidence can establish the generic command contract; it cannot attest the exact enterprise-installed binary/configuration.

## Stage 4 — Authentication UX

**Current state:** read-only `vendor-session` execution is implemented; CLIHarbor-owned login orchestration is not.

Potential deliverables, only when justified by real operator needs:

- safe auth-state detection;
- vendor-owned login launch;
- session refresh/status display;
- documented vendor logout;
- explicit profile/context visibility.

The preferred architecture remains vendor-owned credentials/session storage. Browser password/MFA forms and embedded PTY remain deferred because they materially expand the security boundary.

## Stage 5 — Additional useful read-only workflows

Expand from verified operator demand and authoritative CLI evidence.

Candidates include:

- additional non-secret Conjur inventory/search operations;
- other Idira CLI read-only operations;
- deployment-mode-specific read commands when environment detection can be deterministic;
- richer non-secret result renderers.

Do not expose commands merely because upstream source contains them. Every browser task must have a justified user workflow and safe execution/output classification.

## Stage 6 — Change/destructive workflows

**Deferred.**

Before enabling `change` or `destructive` risk classes, implement and qualify:

- backend-enforced confirmation bound to exact command/target/context;
- explicit tenant/profile visibility;
- idempotency/reconciliation where the vendor operation requires it;
- safe failure/timeout-after-success behavior;
- audit evidence that does not leak secrets;
- workflow-specific regression and managed-environment tests.

Frontend confirmation alone is not an authorization boundary.

## Stage 7 — Secret-bearing workflows

**Deferred.**

Secret retrieval/handling requires a separate reviewed contract for:

- reveal/copy UX;
- no persistence by default;
- redaction and diagnostics;
- clipboard/history behavior;
- output retention and crash handling;
- authorization/context clarity.

Until that contract exists, the planner/executor continue to reject secret-bearing browser tasks.

## Stage 8 — Distribution hardening

Potential deliverables:

- Windows code signing/publisher identity;
- SBOM/provenance/attestation;
- approved internal pack distribution;
- installer only if it improves deployment without introducing unnecessary privilege/persistence;
- rollback/version compatibility policy.

The current evaluation artifact is intentionally unsigned and portable; it must not be described as signed or independently attested.

## Stage 9 — Second real CLI

Add a materially different second tool only after real demand demonstrates value.

Selection criteria:

- recurring operator pain;
- stable documented CLI semantics;
- reasonable licensing/distribution;
- useful non-secret read workflows;
- enough difference from Conjur to validate the generic engine.

Exit condition: two real packs operate without vendor-specific branches in the generic planner/executor.

## Stage 10 — Pack authoring tooling

Potential features:

- `cliharbor pack init`;
- schema-aware editor/validation;
- help-tree capture;
- draft generation from authoritative help/source;
- fixture generation;
- `cliharbor pack test`;
- static security linter;
- compatibility matrix.

AI may help author **reviewable source artifacts**, but runtime execution must not depend on an LLM inventing security-sensitive commands.

## Optional later work

- embed CLIHarbor into an approved internal company CLI;
- Linux/macOS qualification;
- signed/public pack ecosystem if adoption justifies the trust infrastructure.

## Explicitly deferred

- cloud-hosted control plane;
- arbitrary remote execution;
- multi-user remote server;
- built-in credential vault;
- generic shell/terminal emulator;
- automatic trust of downloaded packs;
- “support every CLI automatically” runtime behavior;
- community marketplace before signature/publisher trust exists.

## Product validation loop

For each shipped workflow:

1. verify it against authoritative source/docs and the target installed version;
2. measure whether it replaces repeated manual CLI work;
3. capture confusing fields/errors and operational failures;
4. add regressions for defects;
5. generalize the pack/runtime model only when multiple real workflows require the same capability.
