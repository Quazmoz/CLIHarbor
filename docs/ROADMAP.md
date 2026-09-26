# Roadmap

CLIHarbor's foundation, first real vendor read-only integration, and zero-config first-party startup path are implemented. The roadmap is therefore organized around managed-environment qualification and controlled capability expansion rather than generic infrastructure invention.

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
- trusted built-in and explicit local pack loading, including additive multi-pack composition for `serve`/`doctor`;
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

Preflight and the discovery-only Phase 0 path require no administrator rights, Go, Node/npm, Git, PowerShell or outbound internet access.

## Stage 3 — Conjur 9.x read-only vertical slice

**Status: implemented from authoritative upstream evidence; managed-laptop qualification pending.**

The repository includes `packs/conjur/conjur-v9.yaml`, derived from the official `cyberark/conjur-cli-go` v9.3.1 release and commit `7207d6a4a2005130978e10d03d7f6b55ab0216d6`. The same reviewed pack bytes are embedded in CLIHarbor for default `serve` and `doctor` startup.

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
- Conjur version constraint `>=9.3.1-0 <10.0.0-0`;
- fixed help probes for deployed-command comparison;
- embedded first-party pack so normal startup needs no `--pack-file`;
- current-user Conjur fallback provisioning only when discovery is exactly `missing`;
- exact CyberArk v9.3.1 Windows x64 URL/size/SHA pinning;
- cache re-verification, invalid-copy repair and no activation on integrity failure;
- `--no-auto-setup` for enterprise environments that prohibit application-managed downloads;
- explicit `--tool-path` remains authoritative and is never replaced automatically.

See [Conjur CLI 9.x Integration](CONJUR_INTEGRATION.md) and [ADR-025](ADR-025_ZERO_CONFIG_CONJUR_BOOTSTRAP.md).

### Exit condition

On the target company-managed Windows laptop:

1. CLIHarbor evaluation preflight succeeds;
2. `doctor` loads the embedded first-party pack and reports the local Conjur state without performing a download;
3. either an approved corporate Conjur binary qualifies unambiguously, or policy permits the exact verified current-user fallback;
4. the resulting executable satisfies `>=9.3.1-0 <10.0.0-0` and normal executable identity checks;
5. application/network policy permits the selected execution path without bypasses;
6. at least one non-secret read workflow succeeds using the approved vendor-owned session.

Online source/release evidence establishes the generic command and fallback-byte contracts; it cannot attest organization approval, account configuration, endpoint policy or session state on a specific laptop.

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
- approved enterprise software-distribution path for CLIHarbor and/or its pinned vendor fallback;
- optional installer only if it improves deployment without unnecessary privilege/persistence;
- managed dependency update/rollback policy;
- Windows arm64 qualification if demand exists.

The current evaluation artifact is intentionally unsigned and portable. The pinned Conjur SHA establishes exact reviewed bytes for the application-managed fallback; it is not independent publisher attestation.

## Stage 9 — Second real CLI

Add a materially different second tool only after real demand demonstrates value.

Selection criteria:

- recurring operator pain;
- stable documented CLI semantics;
- reasonable licensing/distribution;
- useful non-secret read workflows;
- enough difference from Conjur to validate the generic engine.

A second tool does **not** automatically inherit Conjur's bootstrap behavior. Any automatic dependency provisioning requires its own reviewed immutable version/source/digest/platform/install/opt-out contract.

Exit condition: two real packs operate without vendor-specific branches in the generic planner/executor.

## Stage 10 — Pack authoring tooling

**Status: first safe onboarding slice implemented.**

Implemented:

- `cliharbor pack init` discovery-only scaffolding for arbitrary approved executable basenames;
- `cliharbor pack validate` hardened schema/semantic/security validation without executable execution;
- multi-source validation with duplicate-pack conflict detection;
- additive explicit packs alongside embedded first-party packs;
- `--no-default-packs` for explicit custom-only `serve`/`doctor` qualification.

Remaining candidates:

- schema-aware editor;
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
- signed/public pack ecosystem if adoption justifies the trust infrastructure;
- asynchronous first-run setup UX if managed dependency download latency becomes materially confusing.

## Explicitly deferred

- cloud-hosted control plane;
- arbitrary remote execution;
- multi-user remote server;
- built-in credential vault;
- generic shell/terminal emulator;
- automatic trust of downloaded packs;
- generic arbitrary package-manager behavior;
- dynamic `latest` vendor executable selection;
- “support every CLI automatically” runtime behavior;
- community marketplace before signature/publisher trust exists.

## Product validation loop

For each shipped workflow or managed dependency:

1. verify it against authoritative source/docs/release evidence and the target installed version;
2. measure whether it removes repeated manual setup or CLI work;
3. capture confusing fields/errors and operational failures;
4. add regressions for defects;
5. generalize only when multiple real workflows require the same capability without weakening the security boundary.
