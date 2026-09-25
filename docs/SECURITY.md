# Security Model and Threat Model

## 1. Security posture

CLIHarbor is a local browser UI over explicitly approved command-line workflows. It is security-sensitive because it discovers and launches powerful local CLIs while accepting browser input and rendering CLI output.

`localhost` alone is not a security boundary. Browser requests, packs, PATH, executables, process output, filesystem state, network downloads, environment/configuration and user input all cross trust boundaries.

The current runtime intentionally supports only a narrow browser execution envelope:

- explicitly trusted packs;
- discovered and identity-verified executables;
- version compatibility when declared;
- typed validated input;
- deterministic exact argv construction;
- `read` risk only;
- non-secret output only;
- generic unauthenticated tasks, or explicit `vendor-session` authenticated tasks;
- bounded direct process execution.

The real Conjur 9.x pack and optional first-party Conjur bootstrap stay inside this envelope.

## 2. Assets to protect

- Vendor passwords, MFA challenges, API keys, tokens and CLI-owned session material.
- Secrets returned by wrapped CLIs.
- Tenant/account/profile/context identifiers.
- Current-user filesystem and process authority.
- Integrity of pack/tool/task definitions.
- Integrity of executable selection and argv construction.
- Integrity of any application-managed vendor executable download.
- Browser session/bootstrap/CSRF material.
- Diagnostic/run/evidence metadata.

## 3. Trust boundaries

### Trusted with constraints

- The qualified CLIHarbor runtime.
- Built-in pack bytes deliberately compiled into trusted application code.
- Explicitly approved local pack files/directories.
- A discovered executable only after it satisfies basename/path/version policy and executable-identity checks.
- A CLIHarbor-managed first-party vendor executable only after exact pinned source, size and SHA-256 verification and subsequent normal discovery/version qualification.

A discovered path/version is **not** proof of publisher identity. A pinned hash identifies exact reviewed bytes but is also not equivalent to Authenticode publisher validation, organization approval or build attestation. Code signing or enterprise publisher verification remains a separate distribution control.

### Untrusted or potentially hostile

- Browser input and browser request context.
- CLI stdout/stderr/error text.
- User-entered strings, integers, enums and booleans.
- Environment variables and vendor configuration.
- PATH contents/order and binaries found through PATH.
- Network responses before pinned artifact verification.
- Existing files in CLIHarbor's current-user managed-tool directory until reverified.
- Repository/cwd files merely because CLIHarbor runs nearby.
- Development Vite responses.
- Third-party/unapproved packs.
- Web content open in the browser.

## 4. Core invariants

### SI-1 — No arbitrary shell execution

Normal execution is:

```text
trusted pack task + validated typed values + ready discovery state
  -> immutable plan
  -> exact executable path + argv[]
```

CLIHarbor does not concatenate browser values into a shell command and does not invoke CMD, PowerShell, POSIX shells or general-purpose interpreters merely to execute normal tasks.

The v1 pack model rejects common shells/interpreters/script launchers as tool executables.

### SI-2 — Browser cannot choose executable or command syntax

The browser supplies only a trusted pack/command identity and typed input values.

It cannot supply:

- executable name/path;
- subcommand name;
- flag name;
- shell program;
- arbitrary argv array;
- environment-variable name;
- working directory;
- download URL, expected hash or managed-tool destination.

Backend-only `--tool-path` overrides must reference an already declared pack/tool and an approved matching executable basename.

### SI-3 — Positional input remains one argv element

Verified CLIs such as Conjur require forms such as:

```text
conjur resource show <resource-id>
```

The v1 constrained positional primitive therefore has these security semantics:

- one validated scalar becomes exactly one argv element;
- no whitespace/token splitting;
- no templates or substitution;
- no shell interpretation;
- only string/integer/enum values;
- optional positionals must omit atomically;
- string/enum positional values must reject leading `-`;
- enum positional values beginning with `-` are invalid.

A positional value cannot create another argv boundary. Its location in the command tree is fixed by the trusted pack.

### SI-4 — Loopback only

The browser server binds to IPv4 loopback. CLIHarbor is not a remote multi-user execution service.

### SI-5 — Credentials remain vendor-owned

CLIHarbor has no secret input type and does not persist vendor passwords, MFA values, API keys or access/refresh tokens.

Generic:

```yaml
requiresAuth: true
```

does not grant browser execution authority by itself.

The only implemented auth execution mode is:

```yaml
requiresAuth: true
authMode: vendor-session
```

This allows a **read-only, non-secret** command to use authentication already supplied by the vendor CLI/environment/OS credential storage. CLIHarbor does not provide credential stdin or credential argv.

For the qualified Conjur 9.3.1 contract, the pinned upstream `conjur-api-go v0.15.4` path loads environment/stored credentials and returns an error when no valid credentials are present. CLIHarbor therefore does not need to start a password/MFA flow merely to execute one of these read tasks.

Installing the pinned Conjur executable does not configure a Conjur account or create/authenticate vendor credentials.

### SI-6 — Secret-bearing browser execution remains disabled

Pack metadata may classify output as secret-bearing, but the current planner/executor reject those plans.

Secret retrieval, password/API-key rotation and comparable workflows are intentionally excluded from the Conjur browser pack.

### SI-7 — Structured output is data, never authority

Structured parsing occurs only after the authoritative process execution completes.

Current structured JSON contracts are deliberately narrow:

- one top-level object;
- bounded input/string sizes;
- only declared scalar string/integer/boolean fields;
- duplicate/unknown fields rejected;
- nested arrays/objects rejected as structured field values;
- sensitive structured fields rejected;
- parser failure cannot create a new execution request.

Raw process state/stdout/stderr remain authoritative evidence.

### SI-8 — Pack trust is explicit

Schema validation does not make a pack trusted.

CLIHarbor does not implicitly scan cwd, auto-trust repository `packs/`, load remote pack URLs, auto-download packs or execute pack/plugin code. Supported pack sources are deliberate built-in bytes or explicitly named local files/directories.

The first-party Conjur pack is compiled into CLIHarbor and still passes the hardened built-in pack loader. This does not create remote pack authority.

### SI-9 — Fail closed on executable ambiguity/change

CLIHarbor rejects missing, ambiguous, incompatible, invalid-override, identity-failed or replaced executables.

Discovery captures executable identity/content evidence and execution revalidates it immediately before launch.

Automatic dependency provisioning is attempted only when the first-party Conjur tool's authoritative discovery status is exactly `missing`. Ambiguous, incompatible, probe-failed, identity-failed and explicit override states are never auto-replaced.

### SI-10 — Managed vendor downloads are immutable and current-user scoped

CLIHarbor's only current automatic vendor executable is the explicitly reviewed CyberArk Conjur CLI v9.3.1 Windows amd64 asset.

The runtime pins:

```text
version: 9.3.1
asset: conjur_windows_amd64.exe
size: 21,950,000 bytes
SHA-256: da2b31ca00b8faaefb8e1fe891563b5cc07c39460e776fb42e7f89b05d3ee4f6
```

Controls:

- no mutable `latest` URL;
- HTTPS only in production;
- redirect count bounded and final/redirect origins restricted to GitHub/GitHubusercontent;
- response/body size bounded;
- download writes to a same-directory staging file;
- exact size and SHA-256 required before activation;
- file synced before activation;
- activated target verified again;
- pre-existing managed file is reused only if the exact pinned bytes still match;
- corrupt/altered managed copies are removed rather than executed;
- current-user cache only;
- no Program Files, machine PATH, registry, service, driver, scheduled task or elevation;
- explicit `--no-auto-setup` opt-out;
- normal discovery/version/executable-identity controls still apply after provisioning.

## 5. Threats and mitigations

### T1 — Shell / argv injection

**Threat:** user-controlled text changes command structure or escapes into a shell.

**Controls:**

- no ordinary shell execution;
- executable/subcommands/flags come only from trusted pack declarations;
- exact runtime JSON type validation;
- bounded strings and numeric values;
- NUL rejection;
- leading-dash rejection for user strings/enums used as flag values or positional values;
- optional flag/value and positional elements omit atomically;
- enum-to-literal mappings are complete allowlists;
- one positional input creates exactly one argv element.

### T2 — Malicious web page attacks localhost

Controls include unpredictable bootstrap/session material, host-only HttpOnly session cookie, exact Host validation, rejection of foreign non-empty Origin, exact same-origin plus CSRF for mutations, restrictive CORS and an unpredictable ephemeral loopback port.

### T3 — DNS rebinding / Host abuse

Only the exact bound loopback Host is accepted. Host headers are not treated as authority.

### T4 — XSS through CLI output

CLI output is untrusted data. Production UI uses React escaping and a restrictive CSP; raw HTML execution is not a supported output renderer.

### T5 — Secret leakage through output

The current browser executor rejects secret-bearing plans. Future secret workflows require a separate reveal/copy/redaction/persistence design.

### T6 — Secret leakage through argv

There is no secret input primitive. Credentials should remain in vendor-owned session mechanisms rather than process-list-visible argv.

### T7 — PATH hijacking / ambiguity

Controls:

- discovery begins only after explicit pack trust;
- only absolute PATH entries are searched;
- empty/relative/cwd entries are ignored;
- candidates are normalized/de-duplicated;
- multiple matches fail as ambiguous;
- operator may explicitly pin one absolute matching path;
- invalid override never silently falls back to PATH;
- version probes/constraints may block incompatible binaries;
- executable identity is revalidated before execution.

Residual risk: name/path/version/content identity does not establish vendor publisher identity.

### T8 — Malicious pack / parser abuse

Pack loading enforces bounded size, UTF-8, one YAML document, no aliases/anchors/merge/custom tags, duplicate/non-string-key rejection, depth/node bounds, strict schema/unknown-field rejection, semantic cross references, safe executable basenames, deterministic loading, no pack symlinks and no plugin code.

Packs remain privileged configuration even after validation.

### T9 — Malicious discovery/evidence probe

Only fixed pack-authored version/help probe argv is supported. Probes are shell-free, time/output bounded, lifecycle-contained and executable-identity checked. Raw version-probe text is not retained in normal discovery state.

### T10 — Destructive command confusion

The current planner/executor reject every risk class except `read`.

Before `change`/`destructive` execution is enabled, backend confirmation must be bound to exact command, target and context. Frontend confirmation alone is insufficient.

### T11 — Authentication confused deputy

**Threat:** clicking a read workflow causes CLIHarbor to solicit or expose credentials, or executes under an unintended authentication context.

**Controls:**

- generic auth-required tasks remain blocked;
- `vendor-session` must be explicitly declared in a trusted pack;
- CLIHarbor supplies no interactive credential stdin;
- CLIHarbor supplies no credential argv;
- current Conjur pack is version-gated to the upstream contract used for authentication analysis;
- missing/expired stored credentials produce vendor failure/remediation rather than becoming CLIHarbor credential input;
- future mutations must make profile/account/tenant context explicit before execution.

### T12 — Long-running/noisy process denial of service

Task execution has total deadlines, cancellation, per-stream output limits, WaitDelay protection, bounded active/retained runs/events and on Windows a Job Object so descendants cannot outlive the run.

SSE handlers/replay/reconnect are separately bounded.

### T13 — Browser bootstrap exposure

The bootstrap token is short-lived and single-use, exchanged for a session, then removed from browser history by redirect. It is printed only for explicit local recovery when automatic browser launch fails.

### T14 — Local privilege confusion

CLIHarbor runs as the current user and must not silently elevate. A managed-laptop user should not enter separate administrator credentials merely to start CLIHarbor or provision the managed Conjur fallback.

Application-control blocks must be handled through approved allowlisting/signing, not policy bypass.

### T15 — Development frontend receives session authority

The dev proxy is restricted to explicit IPv4 loopback, strips Cookie/Authorization/Proxy-Authorization/CSRF before forwarding, drops Set-Cookie and does not own `/bootstrap` or `/api/*` routes.

### T16 — Vendor download substitution / downgrade / cache poisoning

**Threat:** a network response, redirect, mutable release reference or pre-existing local file substitutes a different executable for the reviewed Conjur binary.

**Controls:**

- version/URL/size/SHA are compile-time reviewed constants;
- no latest-version discovery;
- production HTTPS and restricted redirect origins;
- bounded redirect count and payload size;
- staged file never becomes executable authority before size/hash validation;
- the activated target is rehashed;
- cached files are reverified on reuse;
- invalid cached targets are removed;
- normal Conjur version probing and executable identity checks run after bootstrap;
- only an authoritative `missing` state may invoke this fallback;
- explicit operator overrides are never superseded;
- `--no-auto-setup` disables the network behavior.

Residual risk: SHA-256 pinning proves exact bytes against a reviewed digest; it does not independently prove CyberArk publisher identity or that GitHub's upstream release process was uncompromised when the digest was reviewed.

## 6. Conjur-specific security boundary

The real pack at `packs/conjur/conjur-v9.yaml` is derived from the official `cyberark/conjur-cli-go` v9.3.1 release/commit and requires:

```text
>=9.3.1 <10.0.0
```

The same pack is embedded in the normal CLIHarbor executable for the default user path.

It exposes only reviewed non-secret read operations:

- authenticated identity;
- resource list/existence/metadata/permission relationships;
- role existence/metadata/members/memberships.

It intentionally excludes:

- variable secret retrieval;
- login/authenticate commands;
- password/API-key rotation;
- policy mutations;
- issuer mutations;
- host-factory mutations;
- deployment-specific commands that cannot be safely generalized.

Online upstream evidence establishes the generic CLI contract and the pinned release bytes but does not establish organization approval, endpoint configuration or account/session state on a particular laptop.

See [Conjur CLI 9.x Integration](CONJUR_INTEGRATION.md).

## 7. Logging, diagnostics and evidence

Never place in normal logs/diagnostics/evidence:

- passwords/MFA;
- access/refresh tokens/API keys;
- browser session/CSRF material;
- secret values;
- full environment dumps;
- secret-bearing CLI output;
- unrelated credential/profile/keystore files.

Support diagnostics are constructed from approved allowlisted metadata rather than filesystem/log scraping.

`doctor` is local troubleshooting output and may contain executable paths; it should not be shared blindly.

Managed-tool bootstrap errors shown during normal startup use reviewed sanitized operator text. Raw network/path errors are not copied into the browser-facing diagnostic contract.

## 8. Local configuration and managed state

Current operator configuration remains process-local through explicit `--pack-file`, `--pack-dir` and `--tool-path` flags. Repository/cwd contents do not become trusted configuration by implication.

Normal `serve` startup additionally loads the compiled-in first-party Conjur pack. If automatic setup is enabled and the tool is truly missing, CLIHarbor may persist only the exact verified Conjur executable under its current-user cache. This is managed runtime content, not credential/configuration storage.

`--no-auto-setup` preserves embedded-pack startup while prohibiting the automatic vendor download.

## 9. Dependency / supply-chain controls

Relevant controls include:

- pinned Go/Node versions;
- module/lock integrity checks;
- pinned GitHub Action commit SHAs;
- frontend dependency audit;
- pinned `govulncheck` invocation;
- generated frontend drift detection;
- deterministic Windows evaluation rebuild comparison;
- authoritative `EVALUATION_SHA256SUMS` for the immutable Phase 0 evaluation bundle;
- re-verification before upload;
- embedded first-party Conjur pack bytes compiled into the qualified executable;
- exact CyberArk Conjur v9.3.1 Windows x64 URL, size and SHA-256 pin for the optional managed fallback.

The Conjur integration records its upstream source/release commit and compatibility boundary. The pinned binary digest strengthens exact-byte identity for the managed fallback; it is not Windows publisher attestation.

Code signing, SBOM/provenance attestation and enterprise publisher verification remain separate future release-hardening work.

## 10. Security verification

The repository test/CI contract covers, among other things:

- pack schema/semantic/trust/resource bounds;
- embedded first-party pack loading;
- executable discovery ambiguity and override behavior;
- version compatibility/probe failures;
- executable replacement/identity checks;
- exact argv planning and malformed typed inputs;
- hostile leading-dash positional values;
- read/auth/output policy gating;
- direct process execution, timeouts, cancellation and output exhaustion;
- Windows descendant cleanup;
- browser Host/Origin/session/CSRF/request validation;
- bounded run/SSE/replay state;
- inert CLI-output rendering;
- structured-output parser bounds;
- Phase 0 evidence/integrity behavior;
- deterministic Windows evaluation/preflight flow;
- Conjur pack parsing, exact documented argv construction and vendor-session execution policy;
- managed Conjur download digest validation, cache reuse, corrupt-cache repair, no-activation-on-mismatch and unsupported-platform/tool no-op behavior.

A successful CI run proves the repository-controlled contract under CI environments. It does not prove a private company endpoint has the expected account configuration, network reachability, permissions, application-control policy or live vendor session.


## Browser task-preference persistence

Task discovery introduces one deliberately narrow browser-local persistence surface:

- storage key: `cliharbor.task-preferences.v1`;
- favorites: bounded task identities containing only `packId` and `commandId`;
- recent tasks: at most eight deduplicated task identities, newest first.

This preference state is **untrusted navigation state, never authorization or execution state**. On every runtime catalog load, stored identities are strictly parsed, bounded, and reconciled against tasks returned by the authenticated backend. An identity absent from the current catalog is removed and cannot be selected or executed. Invalid JSON, wrong types, oversized payloads, excessive entry counts, invalid identifier lengths, and unavailable/throwing browser storage all fail closed to empty preferences.

CLIHarbor does not persist task form values, credentials, authentication state, CSRF/session material, stdout/stderr, structured results, failure text, argv, or executable paths in this preference store. The browser still supplies only the selected current-catalog `packId`/`commandId` and typed task values to the existing run API; planner, policy, tool identity, exact argv, and process execution remain backend-owned.