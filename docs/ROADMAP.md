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

**Current state:** generic read-only `vendor-session` readiness plus the reviewed Conjur sign-in adapters are implemented; broader vendor auth remains demand-driven.

Implemented:

- pack-declared, zero-input read-only/non-secret session checks validated against the declaring tool;
- browser-safe metadata identifying which tools require vendor sessions and any reviewed session check;
- a multi-tool Authentication page driven by generic tool/session metadata rather than hard-coded task execution;
- conservative signed-out classification only from optional reviewed pack evidence;
- bounded output, cancellation/reconciliation, stale-completion protection, and allowlisted inert identity rendering;
- explicit **Session check unavailable** behavior for vendor-session tools such as kubectl that do not have a reliable generic auth probe;
- Conjur password-style `authn`/LDAP handoff through the pinned vendor API without password argv/history/persistence;
- first-run Conjur connection setup using exact reviewed `init self-hosted` argv;
- Windows vendor-owned Conjur login launch for reviewed OIDC, JWT, and SaaS/cloud modes using the identity-verified executable plus fixed `login` argv: OIDC/JWT avoid an unnecessary console, while SaaS/cloud retains a vendor terminal for genuinely interactive challenges; no shell or credential capture;
- the existing Conjur `whoami` check remains authoritative after either sign-in path.

Potential deliverables, only when justified by real operator needs:

- broader vendor-specific auth-state detection where authoritative evidence exists;
- session refresh/status display;
- documented vendor logout;
- explicit profile/context visibility;
- additional vendor-owned login launchers after their exact authentication contracts are reviewed.

The preferred architecture remains vendor-owned credentials/session storage. Generic browser password/MFA forms and embedded PTY remain deferred because they materially expand the security boundary.

## Stage 5 — Additional useful read-only workflows

**Status: implemented for the current first-party packs; real Docker/Kubernetes host qualification remains external.**

Implemented:

- Conjur resource inventory uses an explicit bounded page-size contract for kind/search/offset/role/inspect listing; count, role-membership, and permitted-role queries use dedicated read-only tasks so list pagination cannot be bypassed;
- Windows evaluation CI still qualifies the exact pinned CyberArk Conjur CLI v9.3.1 `list --help` surface, including legacy relationship flags as vendor-contract evidence, even though CLIHarbor routes those relationship operations through dedicated browser tasks;
- Docker adds non-verbose `system df` summary output and a one-shot `container stats --no-stream` resource snapshot with a fixed cross-platform field projection;
- kubectl adds metadata-only StatefulSet, DaemonSet, and Job status inventory using fixed custom columns;
- kubectl adds one-shot node and cross-namespace pod CPU/memory usage through `kubectl top`, with Metrics API availability treated as an external runtime dependency;
- exact production-planner regression cases bind every new workflow to its reviewed argv and assert the read-only/non-secret execution envelope;
- first-party pack versions were advanced for the expanded contracts.

Still deliberately excluded:

- Docker `inspect`, `info`, event streams, logs, environment/config output, verbose disk-usage object detail, and mutation commands;
- Kubernetes Secrets, ConfigMaps, raw manifests/object bodies, describe/event text, logs, exec/attach/cp/debug, forwarding/proxy, impersonation, context mutation, and all change/destructive operations;
- additional Conjur commands that are secret-bearing, mutating, interactive, deprecated, or deployment-conditional without deterministic environment detection.

Future read-only expansion remains demand-driven and requires authoritative command/output evidence plus an explicit non-secret output review.

## Stage 6 — Change/destructive workflows

**Implemented for Conjur** (secret variable create/delete, permission grant/revoke, LDAP mappings, issuer delete); real-appliance qualification pending. Each item below is implemented as backend-bound single-use approval (ADR-030):

- backend-enforced confirmation bound to exact command/target/context;
- explicit tenant/profile visibility;
- idempotency/reconciliation where the vendor operation requires it;
- safe failure/timeout-after-success behavior;
- audit evidence that does not leak secrets;
- workflow-specific regression and managed-environment tests.

Frontend confirmation alone is not an authorization boundary.

## Stage 7 — Secret-bearing workflows

**Write-only secret input implemented** for Conjur `variable set` (stdin only, never echoed or retained; ADR-030). Secret **retrieval** remains deferred and requires a separate reviewed contract for:

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

## Stage 9 — Additional real CLIs

**Status: Docker, kubectl, and GitHub CLI read-only packs implemented; real-host qualification pending.**

CLIHarbor now ships embedded `docker-cli`, `kubectl-cli`, and `github-cli` packs alongside Conjur. All exercise the generic discovery/planner/executor path without vendor-specific backend branches. GitHub CLI adds bounded metadata inventories for repositories, pull requests, issues, workflow runs, and workflows, using explicit targets and the existing vendor session; see [GitHub CLI integration](GITHUB_INTEGRATION.md).

Docker provides active-context visibility, narrow container/image/network/volume inventory, summary disk usage, and one-shot container resource statistics. kubectl provides active-context visibility, client version, metadata-only namespace/node/pod/deployment/StatefulSet/DaemonSet/Job inventory, and optional Metrics API CPU/memory snapshots. Neither tool is auto-provisioned.

The kubectl pack deliberately excludes kubeconfig contents, Secrets, ConfigMaps, raw object manifests, logs, exec/attach/cp, port-forward/proxy, impersonation, context mutation, and all change/destructive operations. Cluster-backed commands reuse the vendor-owned session boundary; CLIHarbor does not accept Kubernetes credentials.

Public CI validates built-in loading, linting, exact planner argv, and the no-auto-provisioning boundary without requiring Docker or Kubernetes daemons/clusters. Real runtime qualification remains external.

Selection criteria for future expansion remain:

- recurring operator pain;
- stable documented CLI semantics;
- reasonable licensing/distribution;
- useful non-secret read workflows;
- enough difference from existing packs to exercise generic engine behavior.

No additional tool inherits Conjur's bootstrap behavior. Any automatic dependency provisioning requires its own reviewed immutable version/source/digest/platform/install/opt-out contract.

Exit condition: Conjur, Docker, kubectl, and GitHub CLI execute approved read-only workflows on qualified hosts without vendor-specific branches in the generic planner/executor.

## Stage 10 — Pack authoring tooling

**Status: safe onboarding, static linting, declared compatibility reporting, planner-contract testing, and deterministic fixture generation implemented.**

Implemented:

- `cliharbor pack init` discovery-only scaffolding for arbitrary approved executable basenames;
- `cliharbor pack capture-help` for bounded sanitized capture of one explicitly trusted, pack-declared fixed help probe with no arbitrary argv or runtime-authority generation;
- `cliharbor pack draft` for discovery-only candidate extraction from captured help, including bounded control-free short descriptions; all candidates remain YAML comments and are never runnable until reviewed command contracts are authored;
- `cliharbor pack validate` hardened schema/semantic/security validation without executable execution;
- `cliharbor pack lint` deterministic static security/quality diagnostics, with optional explicit contract-fixture coverage analysis and no executable/probe/session access;
- `cliharbor pack compatibility` deterministic declared platform/version/managed-artifact reporting with no host discovery, probes, network, install, task, or vendor-session access and no inferred CPU support;
- `cliharbor pack test` bounded declarative contract cases through the production planner without executable/probe execution;
- `cliharbor pack generate-tests` bounded, no-clobber planner-contract fixture scaffolding with production-planner self-verification and no executable/probe/session access;
- multi-source validation with duplicate-pack conflict detection;
- additive explicit packs alongside embedded first-party packs;
- `--no-default-packs` for explicit custom-only `serve`/`doctor` qualification.

Remaining candidates:

- schema-aware editor;
- multi-level help-tree traversal/capture beyond individually reviewed fixed probes;

AI may help author **reviewable source artifacts**, but runtime execution must not depend on an LLM inventing security-sensitive commands.

## Optional later work

- embed CLIHarbor into an approved internal company CLI;
- broader Linux runtime and managed-macOS vendor qualification;
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

## Windows and macOS runtime

The macOS runtime, Conjur pack platform declaration, process-group cleanup, native build path, local testing CLI/demo, and macOS quality/browser jobs are implemented. Windows remains the first enterprise evaluation target with its existing artifact/preflight contract. Broader macOS vendor/install/sign-in parity is not implied; see [Windows and macOS setup](CROSS_PLATFORM.md).

## Explicit supported-tool installation

The supported CLI catalog and live activation are implemented; native target-host
qualification remains distinct. Pinned kubectl and GitHub CLI artifacts reuse the
pack-declared portable installer only on explicit user request. This does not
expand Conjur's automatic bootstrap to other tools. See
[Supported CLI catalog](CLI_CATALOG.md) for versions, platforms, and acceptance.
