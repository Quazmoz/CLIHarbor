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
- download URL or expected hash;
- arbitrary executable/task path selection.

For a pack-declared portable install only, the browser may optionally provide an install **base directory**. That directory must be an absolute path under the current user's home, must not escape through an existing symlink, and does not determine the executable name or relative managed path. CLIHarbor appends its own `tools/<pack>/<tool>/<version>/<executable>` layout and verifies the exact pack-pinned bytes before the path can become execution authority.

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

CLIHarbor has no generic secret input type and does not persist vendor passwords, MFA values, API keys or access/refresh tokens.

Generic:

```yaml
requiresAuth: true
```

does not grant browser execution authority by itself.

The task execution auth mode remains:

```yaml
requiresAuth: true
authMode: vendor-session
```

This allows a non-secret-output command to use authentication already supplied by the vendor configuration/credential store. Task execution never receives login credentials on stdin or argv. The only stdin a task can receive is its pack-declared mutation payload (a rendered policy document, or one approved secret value for Conjur `variable set`), see SI-11.

The qualified Conjur integration additionally has one narrow in-process credential bridge. The browser may submit identity/password only to the authenticated, CSRF-protected loopback endpoint `POST /api/v1/auth/login`; that request is not a task/run and never becomes command argv, invocation preview, retained run input, stdout/stderr or diagnostics. The adapter is fixed to the qualified `cyberark-conjur-v9/conjur` identity, supports only password-style `authn`/LDAP configuration against an HTTPS appliance URL in a non-SaaS environment, admits one sign-in attempt at a time, bounds request/network duration, and returns only closed-set errors.

The adapter calls pinned `conjur-api-go v0.15.4` directly. The vendor library performs credential validation/exchange and writes the resulting API key using Conjur's configured credential-storage backend. CLIHarbor never persists the submitted password and clears the returned API-key byte buffer after the vendor library stores it.

For reviewed OIDC, JWT, and Idira SaaS/cloud configuration on Windows, CLIHarbor may instead expose `POST /api/v1/auth/interactive`. That endpoint accepts only the fixed pack/tool identity under the same authenticated loopback + exact Origin + CSRF boundary. The backend reloads vendor configuration, revalidates the exact discovered executable identity, and starts only that executable with fixed argv `["login"]`. OIDC/JWT use a no-console vendor process because their reviewed paths do not require CLI stdin; OIDC still owns browser/callback handling. SaaS/cloud uses a separate vendor-owned console because the upstream flow may require interactive secrets or MFA choices. No browser field can supply executable/argv/environment/working-directory/credential data, no shell is invoked, and CLIHarbor does not capture vendor credential interaction. Certificate/IAM/Azure/GCP/unknown modes and disabled/read-only credential storage remain fail-closed to the organization's external process.

The SaaS/cloud console host is a fixed private child-process entry point, not a shell or pack extension. It accepts only an absolute Conjur executable path plus discovery-time content fingerprint, verifies the fingerprint and file identity, and uses fixed `login` argv with native console device handles. Vendor credential I/O is never piped into CLIHarbor memory or HTTP responses. The host never reads console input, including buffered keystrokes after the vendor exits; its visible result has no application persistence. Invalid handoffs and immediate hidden-process failures use sanitized errors. See ADR-029.

Installing the pinned Conjur executable does not configure a Conjur account or create/authenticate vendor credentials.

### SI-6 — Secret-bearing browser execution remains disabled

Pack metadata may classify output as secret-bearing, but the current planner/executor reject those plans.

Secret retrieval, password/API-key rotation and comparable workflows are intentionally excluded from the Conjur browser pack.

The one exception that reads values is the Conjur security audit (ADR-028/ADR-033). It classifies references or bounded text/regex criteria in backend memory, returns only variable IDs and closed reason codes to the browser, and performs no mutation. The selected HTTPS backend URL must match vendor configuration before a client is created; browser input cannot redirect stored credentials or tokens. Scan text is ephemeral, validated, and excluded from snapshots, errors, logs and report exports. Non-UTF-8 values are reported as unchecked.

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

### SI-11 — Approved mutations and write-only secret input

`change`/`destructive` tasks execute only after the run manager consumes a short-lived, single-use backend approval whose fingerprint covers the exact argv, stdin, executable, impact target and Conjur account/endpoint context. Destructive tasks additionally require typed confirmation. A stale, replayed, retargeted or context-changed approval fails closed.

Policy payloads come from a trusted pack template; user strings are rendered only as YAML double-quoted scalars, so they cannot add policy statements. The approval preview shows the exact policy document.

A `secret` input (Conjur `variable set`) is write-only: pack validation allows it only as stdin, never argv, so it is absent from the process list, invocation preview, approval preview, run history, diagnostics and browser retry/preference state. Command output (`Value added`) carries no secret material.

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

### T6 — Secret leakage through argv or retained browser state

There is no pack-level secret input primitive. Credential login is a separate fixed API path, never planner/executor input. Conjur passwords are never placed in process-list-visible argv, invocation preview, run history, retry state or CLIHarbor persistence. The browser clears password state after each attempt.

### T7 — PATH hijacking / ambiguity

Controls:

- discovery begins only after explicit pack trust;
- only absolute PATH entries are searched;
- empty/relative/cwd entries are ignored;
- only after PATH misses, a bounded non-recursive current-user fallback set is checked, including the default Go `~/go/bin`, Windows WinGet links and Scoop shims;
- candidates are normalized/de-duplicated;
- multiple matches within the selected discovery tier fail as ambiguous;
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

The pack-authoring `capture-help` command reuses this same boundary: it requires an explicitly supplied trusted pack, selects one existing `helpProbes` entry, accepts no arbitrary argv, performs no automatic tool provisioning, sanitizes bounded output, and writes only a new no-clobber authoring file. Captured text remains untrusted evidence and cannot itself grant pack, command, executable, or argv authority.

### T10 — Destructive command confusion

The current planner/executor reject every risk class except `read`.

Before `change`/`destructive` execution is enabled, backend confirmation must be bound to exact command, target and context. Frontend confirmation alone is insufficient.

### T11 — Authentication confused deputy

**Threat:** a browser action solicits credentials for an unintended tool/mode, leaks them into another execution surface, or treats login transport success as authorization.

**Controls:**

- generic auth-required tasks remain blocked;
- `vendor-session` must be explicitly declared in a trusted pack;
- the password credential endpoint accepts only bounded identity/password JSON under the existing local session + exact Origin + CSRF boundary;
- the vendor-login endpoint accepts only bounded pack/tool identity under that same boundary and supplies no browser-controlled argv;
- both adapters are hard-bound to the qualified Conjur pack/tool identity rather than browser-supplied executable authority;
- password login remains limited to HTTPS self-hosted authn/LDAP; vendor-terminal launch remains limited to reviewed OIDC/JWT/SaaS modes with writable vendor credential storage;
- certificate/IAM/Azure/GCP/unknown modes, plaintext self-hosted appliance URLs, and disabled/read-only credential storage fail closed;
- connection setup, password handoff, and vendor-login launch share one authentication single-flight gate;
- executable identity is revalidated immediately before vendor-login launch, which uses fixed `conjur login` argv without a shell or credential capture;
- submitted credentials never become process argv, task values, run history, diagnostics or logs;
- raw vendor authentication errors are collapsed to reviewed browser-safe codes;
- a successful password handoff or vendor-login launch is followed by the existing trusted `whoami` session check; transport/launch success alone is not authorization evidence;
- mutations show and bind the Conjur account/endpoint/authentication context in the approval before execution.

### T12 — Long-running/noisy process denial of service

Task execution has total deadlines, cancellation, per-stream output limits, WaitDelay protection, bounded active/retained runs/events and on Windows a Job Object so descendants cannot outlive the run. On macOS/Linux, commands and probes run in a dedicated process group; cancellation, timeout, and normal teardown kill descendants that remain in that group. Deliberate process-group/session escape is outside this boundary and requires a stronger OS sandbox.

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

It exposes reviewed non-secret read operations:

- authenticated identity;
- resource list/existence/metadata/permission relationships;
- role existence/metadata/members/memberships.

and approval-gated mutations (SI-11):

- create/delete a variable and grant/revoke a role's privileges on it through fixed `policy update` templates (no free-form policy text; templates never create users/hosts, so no API keys are returned);
- set a variable's value through `variable set --file -`;
- LDAP group/user mappings and issuer delete.

It intentionally excludes:

- variable secret retrieval;
- login/authenticate commands;
- password/API-key rotation;
- free-form policy load/replace;
- issuer create/update and host-factory mutations;
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
- exact CyberArk Conjur v9.3.1 Windows x64 URL, size and SHA-256 pin for the optional managed fallback;
- pinned `github.com/cyberark/conjur-api-go v0.15.4` for the reviewed in-process credential bridge, matching the qualified Conjur CLI dependency line.

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
- credential-login request bounds, duplicate/unknown-field rejection, secret non-echo, unsupported-auth/storage fail-closed behavior and post-login session verification;
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

## Browser-managed portable CLI installation

The local UI may request installation only for a tool whose already-trusted pack declares a validated immutable artifact contract. The request carries pack/tool IDs and may carry one optional constrained install base directory. It cannot provide or override a URL, digest, size, archive member, executable name, redirect host, command line, package-manager instruction, or elevation behavior. A custom base directory must remain beneath the current user's home and cannot escape that boundary through an existing symlink.

The portable provisioner:

- uses HTTPS except in isolated tests;
- bounds redirects, response size, ZIP entry count, and extracted executable size;
- validates expected SHA-256 and exact byte count before activation;
- rejects symlink/non-regular managed targets and unsafe cache path segments;
- extracts only one exact declared archive member;
- writes beneath the current user's CLIHarbor cache;
- never executes downloaded installers/scripts during installation;
- never modifies machine PATH, registry, services, Program Files, or privileged locations;
- re-verifies managed bytes before a later startup adopts the executable.

Installation can activate only an authoritatively missing tool after ordinary discovery/version/identity qualification and comparison of the captured executable hash with the pinned artifact hash. Other tools and existing plans/approvals/runs remain unchanged. The task/tool catalog is refreshed under a lock and the browser fetches its updated metadata. Managed artifacts are still reverified on restart. Direct install requests for non-missing states are refused. See [ADR-031](DECISIONS.md#adr-031--supported-cli-catalog-and-additive-live-activation).

This is a convenience path, not an application-control bypass. Endpoint protection, allowlisting, vendor policy, or OS execution restrictions may still refuse the managed binary, in which case CLIHarbor fails closed.

## macOS executable discovery

After PATH has no match, macOS checks the bounded current-user Go/local/bin and Docker CLI directories, plus the standard `/opt/homebrew/bin` and `/usr/local/bin` locations. The same executable permission, resolved basename, ambiguity, version, and identity checks apply. These directories never supersede PATH or explicit overrides. No recursive scan, shell invocation, or inferred vendor command is added. The automatic Conjur download remains Windows amd64 only.

## Durable approved-mutation audit (current implementation)

The run manager requires a writable local mutation journal for all approved `change`/`destructive` commands. A metadata-only start record is fsynced before the vendor process can execute; an outcome record follows after the process terminates. An incomplete record is not success evidence. Journal failure blocks new mutations. The journal is current-user local and hash-chained, not remotely attested or tamper-proof. It intentionally excludes raw process output, argv, credentials and stdin, but targets/IDs are potentially sensitive operational metadata. See [Mutation audit and recovery](MUTATION_AUDIT.md). Automatic undo is not yet authorized.

### Conjur Access Explorer read-only boundary

The dedicated access view only starts backend-advertised Conjur pack tasks marked `risk: read` from an internal finite command allowlist. It cannot run secret-value retrieval, construct arbitrary shell commands, or invoke mutations. It caps inventory pages, role relationship arrays, payload lengths, total page offset, and per-operation polling; failed, forbidden, incomplete and inconsistent vendor responses produce **no access verdict**. Only a validated `id` and `kind` derived from the ID may be rendered/exported as resource metadata; `resource-show` and `role-show` are intentionally not invoked by the explorer because generic run history retains raw approved task output. The existing generic run history still records ordinary approved read-task output; it must never admit secret-bearing tasks through this explorer.

A pre/post endpoint/account/version/identity comparison rejects detected session drift, but it is not an atomic vendor snapshot, and it does not prove effective permission. Conjur's own privilege checks remain authoritative. No credentials or secret values belong in this interface.

### Conjur pattern explorer boundary

Default `id-regex` matching only reads the authenticated variable inventory and **never invokes** `RetrieveSecret` or `RetrieveBatchSecretsSafe`; it verifies the visible inventory has not drifted before publishing a result. Value regex is an explicit opt-in preserving backend equality validation, privilege checks, bounded value handling, and closed reason codes. Expressions are validated server-side as bounded RE2 and are excluded from snapshots, browser reports, logs and execution history. Matching a name or value does not imply a vulnerability. Conjur inventory shortcuts use fixed approved `list --kind` argument vectors and mandatory pagination, not shell execution.

