# Product Requirements Document

## 1. Product summary

CLIHarbor is a Windows-first local browser UI that turns approved command-line workflows into approachable, auditable graphical workflows without replacing the underlying vendor CLI.

The first production vertical is Palo Alto Networks Idira / CyberArk tooling, specifically the official Conjur CLI. The broader product is a generic trusted-pack runtime for additional CLIs.

CLIHarbor is not a terminal emulator, remote shell, credential manager, cloud service, REST API replacement, or generic package manager.

## 2. Problem

Enterprise CLIs often expose powerful workflows but impose avoidable friction:

- users must remember subcommands and flags;
- setup can require locating the correct binary and pack/configuration;
- poor vendor GUIs push users back to raw terminals;
- users need safer forms, validation, context and result presentation;
- company-managed laptops may not permit administrator installs;
- approval cycles make separate heavyweight GUIs undesirable.

For the Idira/CyberArk use case, CLIHarbor should make the approved CLI path easier without weakening enterprise security controls or taking ownership of vendor credentials.

## 3. Product thesis

The safest useful architecture is a thin local orchestration layer:

```text
trusted reviewed pack
+ approved installed or exact verified managed vendor executable
+ validated typed input
-> deterministic exact argv
-> bounded direct execution
-> guided local browser UX
```

The initial product remains intentionally narrow: solve real Conjur read workflows first, then generalize only from repeated evidence.

## 4. Goals

### G1 — One-download, one-command Windows launch

A packaged Windows user should need only the qualified CLIHarbor artifact.

After evaluation preflight, the normal product command is:

```text
cliharbor
```

or the packaged evaluation executable with no arguments.

The normal path must not require a separate pack download, `--pack-file`, administrator credentials, machine-wide PATH changes, Go, Node/npm, Git, PowerShell, or manual vendor installation when an exact reviewed current-user fallback is permitted.

### G2 — Prefer existing approved vendor installations

CLIHarbor must first discover the existing environment. If one compatible unambiguous Conjur executable is already available, use it rather than downloading another copy.

Automatic provisioning is a fallback for a genuinely missing dependency, not a mechanism for replacing ambiguous, incompatible, policy-managed, or explicitly selected installations.

### G3 — Safe current-user dependency bootstrap

When the embedded first-party Conjur pack is active and Conjur is exactly `missing`, default `serve` may provision the exact reviewed CyberArk Conjur Windows amd64 artifact into the current user's CLIHarbor cache.

The dependency must have a reviewed immutable version/source/size/digest contract and must pass ordinary CLIHarbor discovery/version/identity checks after installation.

The user must be able to disable automatic setup with `--no-auto-setup`.

### G4 — Thin execution layer

For ordinary tasks, CLIHarbor launches the exact target executable with an explicit argument vector. It does not invoke PowerShell/CMD merely because the user normally types the command there.

### G5 — Secure vendor-owned authentication

CLIHarbor must not persist or own vendor passwords, MFA values, API keys, or access/refresh tokens.

Supported authenticated read workflows use explicit `vendor-session` semantics and reuse the vendor CLI's approved session/configuration mechanisms.

### G6 — Better UX than raw CLI

Users should receive:

- discoverable workflows;
- validated fields and sensible defaults;
- environment/tool readiness;
- structured results where supported;
- progress and streaming logs;
- exact run status and exit state;
- safe remediation for setup/runtime failures;
- raw-output fallback.

### G7 — Generic architecture

Conjur-specific command syntax belongs in a reviewed pack. Generic planner/executor code must remain vendor-agnostic. A second CLI should normally require another pack and, only if justified, a narrowly scoped adapter or separately reviewed bootstrapper.

## 5. Non-goals for the current product stage

- Automatic support for every installed CLI.
- Arbitrary shell access from the browser.
- Generic package-manager behavior.
- Dynamic `latest` vendor executable selection.
- Automatic trust of remote packs.
- Remote multi-user access.
- Centralized credential storage.
- Cloud-hosted execution.
- Reimplementation of CyberArk REST APIs.
- Replacement of vendor authorization, MFA, keystore, or profile semantics.
- Secret-returning browser workflows.
- Change/destructive browser execution before dedicated confirmation/reconciliation design.
- Full embedded terminal/PTY unless a future verified workflow genuinely requires it.
- Cross-platform parity at launch. Windows is first.

## 6. Primary personas

### Operator

Needs common vendor workflows without memorizing raw CLI syntax or performing unnecessary setup.

### Power user / engineer

Comfortable with CLI tools and wants faster repeatable workflows while retaining transparency and fail-closed behavior.

### Pack author

Adds reviewed command definitions, schemas, parsers and tests for another CLI or command family.

### Security / platform reviewer

Needs confidence that CLIHarbor remains local-only, credential-minimal, bounded, supply-chain aware, and compatible with enterprise policy.

## 7. Current Conjur experience

The first-party Conjur pack is reviewable at:

```text
packs/conjur/conjur-v9.yaml
```

The same reviewed bytes are embedded in CLIHarbor for zero-config `serve` and `doctor` startup.

Authoritative baseline:

```text
CyberArk conjur-cli-go v9.3.1
upstream commit: 7207d6a4a2005130978e10d03d7f6b55ab0216d6
supported version: >=9.3.1-0 <10.0.0-0
```

Current browser workflows:

- authenticated identity (`whoami`);
- list resources with approved filters;
- resource exists/show/permitted roles;
- role exists/show/members/memberships.

Current product explicitly excludes secret retrieval, login credential handling, password/API-key rotation, policy/issuer/host-factory mutations, and unqualified deployment-specific commands.

## 8. Functional requirements

### FR-1 Default pack loading

Normal `serve` and `doctor` shall load the compiled-in first-party Conjur pack through the same hardened built-in pack loader used for trusted pack bytes.

Explicit `--pack-file` or `--pack-dir` shall replace the default-pack selection for that process.

### FR-2 Tool discovery

The runtime shall locate pack-declared executables from approved Windows PATH locations and backend-only explicit overrides.

It shall expose readiness/version information and fail closed on missing, ambiguous, incompatible, probe-failed, invalid-override, identity-failed, or unsupported-platform states as appropriate.

### FR-3 Automatic dependency provisioning

Default `serve` may invoke a reviewed provisioner only when:

- the first-party embedded pack is active;
- automatic setup is enabled;
- the exact declared tool state is `missing`; and
- no explicit tool override exists.

The current provisioner is limited to CyberArk Conjur CLI v9.3.1 Windows amd64.

It shall:

- use the fixed official release URL;
- bound redirects and download size;
- restrict production redirect/final origins to approved GitHub origins;
- require the exact expected file size and SHA-256 before activation;
- verify the activated file again;
- reverify cached copies before reuse;
- remove invalid managed copies instead of executing them;
- use current-user storage only;
- rerun normal discovery/version/identity qualification before the tool becomes executable authority.

### FR-4 Enterprise opt-out and overrides

`--no-auto-setup` shall disable automatic dependency network activity for `serve` while retaining the embedded pack.

An explicit `--tool-path` shall remain authoritative and must never be silently replaced by the managed fallback.

CLIHarbor shall not bypass proxy, EDR, AppLocker, WDAC, SmartScreen, firewall, browser, or other company controls.

### FR-5 Command construction

A UI action shall resolve only from trusted pack declarations and validated user input into an immutable exact argument vector.

User input shall never become a shell command string or browser-selected executable/subcommand/flag structure.

Constrained positional input means one validated scalar becomes exactly one argv element.

### FR-6 Execution

The runtime shall:

- launch the approved process as the current user;
- capture stdout/stderr separately;
- stream bounded output to the UI;
- capture exit code and run status;
- support cancellation;
- enforce bounded execution time/output;
- contain descendant processes on Windows through the established process-control boundary;
- revalidate executable identity immediately before launch.

### FR-7 Authentication

CLIHarbor shall not save vendor passwords, MFA codes, API keys, or tokens.

Authenticated browser execution requires an explicit reviewed auth mode. Current Conjur read workflows use `vendor-session`; CLIHarbor supplies no credential stdin or credential argv.

Installing the Conjur executable and authenticating to Conjur are separate operations.

### FR-8 Output presentation

Raw stdout/stderr remain available as untrusted text.

Where a reviewed structured-output contract exists, CLIHarbor may render bounded typed results. Parser failure shall never create false process success or new execution authority.

### FR-9 Risk policy

Every command has a risk classification. Current normal browser execution permits only `read`, non-secret workflows.

Change/destructive and secret-bearing workflows remain fail-closed until their own reviewed contracts exist.

### FR-10 Browser lifecycle

The local server shall use an ephemeral loopback port, one-time bootstrap material, authenticated local session, exact Host/Origin checks, CSRF protection for mutations, and restrictive browser headers.

### FR-11 Clean shutdown

Closing CLIHarbor shall stop accepting new work, terminate/cancel owned work according to policy, release browser/session state and release the local listener.

### FR-12 Diagnostics and evidence

CLIHarbor shall provide privacy-preserving allowlisted diagnostics and Phase 0 evidence workflows without turning captured text into execution authority.

`doctor` may provide richer local-only path evidence and shall not automatically download dependencies.

## 9. Security and privacy requirements

See `SECURITY.md` for the threat model. Product-level requirements include:

- loopback-only browser service by default;
- no arbitrary executable/path/argv/browser authority;
- no arbitrary shell;
- no CLIHarbor-owned credential store;
- pack validation separate from pack trust;
- pinned immutable automatic dependency artifacts only;
- no generic remote pack/package installation;
- exact digest verification before managed executable activation;
- managed cached executable re-verification before reuse;
- current-user scope with no intentional elevation or machine-wide changes;
- enterprise policy remains authoritative;
- browser-visible output rendered inertly;
- no telemetry/upload by default;
- passwords/tokens/browser secrets excluded from URLs, diagnostics and normal logs.

## 10. UX requirements

The UI should feel like an operator console rather than a terminal skin.

The first-run experience should minimize decisions:

1. user runs the qualified CLIHarbor executable;
2. CLIHarbor discovers readiness automatically;
3. if Conjur is missing and policy permits, CLIHarbor immediately reports setup progress and installs the pinned current-user fallback;
4. browser opens to the local UI after runtime preparation;
5. tool/task state clearly explains any remaining login, policy, compatibility or network prerequisite.

The UI must remain keyboard-accessible and usable at common enterprise laptop widths.

## 11. Packaging and adoption

Current Windows distribution target:

- one primary qualified CLIHarbor evaluation artifact;
- embedded production frontend;
- embedded first-party Conjur pack;
- external discovery-only Phase 0 pack retained only for immutable evaluation/evidence workflow;
- conditional pinned Conjur vendor download when genuinely absent;
- no installer or administrator credential requirement for the normal evaluation path.

The architecture must continue to support company-managed preinstallation/signing/allowlisting and future embedding into a larger internal CLI.

## 12. Success criteria

The current milestone is successful when a Windows user can:

1. download one qualified CLIHarbor artifact;
2. extract it in a normal user-writable location;
3. pass `evaluation preflight` without admin rights or developer tooling;
4. start CLIHarbor with no pack/install arguments;
5. automatically use one approved compatible existing Conjur executable, or install and verify the exact reviewed per-user fallback when Conjur is absent and policy permits it;
6. see a clear fail-closed state rather than silent replacement when corporate tool state is ambiguous/incompatible or policy blocks setup;
7. authenticate only through approved vendor-owned mechanisms;
8. execute at least one real non-secret read workflow in the browser;
9. view structured or faithful raw output and authoritative run status;
10. complete the workflow without CLIHarbor persisting vendor credentials or requiring administrator credentials.

A later second-tool milestone succeeds when a materially different CLI pack operates without vendor-specific branches in the generic planner/executor. Any automatic dependency bootstrap for that second tool requires its own reviewed immutable supply-chain contract.

## 13. Open questions

- Which company-managed Idira/CyberArk environment/version/policy combination is authoritative for final enterprise qualification?
- Will the organization require Authenticode publisher verification or signed provenance in addition to the current SHA pin for managed vendor bytes?
- Should zero-config dependency setup remain synchronous, or should future UI work move slow first-run downloads behind an explicit browser setup state?
- Which additional Idira/CyberArk read workflows provide the highest value?
- Is explicit auth-state detection/login launch useful enough to justify a vendor-specific auth adapter?
- What local non-secret run-history retention is acceptable?
- Is Windows arm64 support needed?
