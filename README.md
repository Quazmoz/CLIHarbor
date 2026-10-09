# CLIHarbor

A local browser UI for safely exposing curated workflows from official command-line tools on Windows and macOS.

**Status:** active hardening. The generic runtime, trusted-pack model, additive multi-pack loading, pack scaffold/validation/lint/contract-test tooling, bounded read-only execution, browser UI, Phase 0 evidence flow, privacy-preserving diagnostics, Windows evaluation qualification, and the first real CyberArk/Idira Conjur 9.x integration (read-only inventory, approved changes and an opt-in value scanner) are implemented.

> **Source/binary qualification:** The latest React source is not guaranteed to be present in a previously downloaded Windows evaluation executable. [Release blocker #59](https://github.com/Quazmoz/CLIHarbor/issues/59) tracks regeneration of `internal/webui/static/`, pinned-toolchain verification, and target-host validation after recent Conjur sign-in changes. Do not treat an older artifact as an acceptance test of those changes or publish it as the latest build. The GitHub Actions pipeline is manual-only and must not be dispatched without specific authorization.

CLIHarbor has **no cloud backend**, does **not** execute arbitrary shell strings, and does **not** store vendor credentials.

## Browser-managed CLI installation

CLIHarbor can install a CLI from the local browser UI **only when the loaded trusted pack declares an immutable portable artifact contract** for the current OS/architecture.

The browser supplies the pack/tool identity and may optionally choose an absolute install base directory inside the current user's home directory. Download URL, SHA-256, expected size, archive member, executable filename, approved redirect hosts, and version remain backend/pack controlled. CLIHarbor never turns this into a generic package manager: it does not execute MSI/PKG installers, package-manager commands, shell scripts, registry edits, services, or machine-wide PATH changes.

When a missing tool has a supported install contract, open **Add a CLI** and use the offered **Install <tool>** action. Leave **Install base directory** blank for CLIHarbor's default current-user cache, or enter an absolute directory under your user home. CLIHarbor downloads and byte-verifies the declared artifact, persists only the selected managed base directory, and immediately publishes the qualified tool and its tasks. On the next startup it re-verifies the managed copy without network access before selecting it as a backend-only tool override.

This path is designed for locked-down work laptops where user-context portable executables are permitted. It does not bypass application control or organizational policy. If the device blocks the artifact or the pack has no reviewed artifact for that platform, CLIHarbor fails closed and leaves the normal explicit `--tool-path` / vendor installation path available.

## Output inspection and copying

Completed runs provide a **Formatted** view for validated structured fields or bounded JSON stdout, with searchable individual values and copy buttons for resource IDs. Switch to **Raw** at any time to inspect the original stdout and stderr independently. No output is sent to an external service or treated as an executable command. An inline CLIHarbor favicon is embedded in the Windows/macOS local UI.

## Two product areas

CLIHarbor separates the **generic CLI workspace** from **dedicated CLI platforms**:

- **CLI workspace:** **Overview**, **Tasks**, **Runs**, **CLI sessions**, **Add a CLI**, **Diagnostics**, and the tool categories generated from reviewed packs. Additional CLIs can be loaded through explicit trusted packs (`--pack-file` / `--pack-dir`). **Add a CLI** provides both the reviewed install catalog and a guided, browser-only **Create a custom CLI pack** flow. The wizard downloads a discovery-only YAML scaffold but does not validate, trust, run, or activate it; approved pack loading still requires explicit operator action.
- **Dedicated CLIs:** a separate sidebar section with a platform picker and platform-specific home and workflows. **CyberArk Conjur** is the first built-in integration, with guided sign-in, grouped approved inventory/access/mutation tools and an inventory-first regex pattern explorer at `/dedicated/conjur`, `/dedicated/conjur/sign-in`, and `/dedicated/conjur/security-audit`. Its approved commands still use the shared `/tasks` runner rather than duplicating execution authority.

Future purpose-built integrations belong in the dedicated platform registry, not as vendor branches in the generic planner/executor. The separate sections are additive: when no dedicated platform is loaded, the generic workspace remains functional.

> **Fastest path:** download the qualified Windows artifact, run preflight, then run the CLIHarbor EXE with no pack arguments. The trusted Conjur pack is embedded, and if Conjur is genuinely missing CLIHarbor can install the exact reviewed CyberArk CLI into the current user's cache without administrator credentials. See [QUICKSTART.md](QUICKSTART.md).

## macOS startup

From a checkout with the pinned Go and Node/npm toolchains:

```bash
go run ./tools/task build  # Rebuild, validate, and embed the frontend before compiling CLIHarbor
./bin/cliharbor
```

Conjur, Docker, kubectl, and GitHub CLI packs load automatically. Open **Add a CLI** to install Conjur, kubectl, or GitHub CLI on supported platforms and immediately access their tasks. Existing vendor installations are discovered at startup. See [Windows and macOS setup](docs/CROSS_PLATFORM.md) and the [supported CLI catalog](docs/CLI_CATALOG.md).

## One-download Windows startup

For the normal managed-Windows user path:

1. Open the repository's [CI workflow](https://github.com/Quazmoz/CLIHarbor/actions/workflows/ci.yml).
2. Choose a **successful, explicitly authorized manually dispatched `main` workflow run** (workflows do not run automatically).
3. Download `cliharbor-windows-x64-evaluation-<commit-sha>` from **Artifacts**.
4. Extract it to a user-writable directory.
5. Open Command Prompt normally — **not** as administrator.
6. Run preflight:

```bat
bin\cliharbor-windows-x64-evaluation.exe evaluation preflight --bundle "."
```

Continue only when it ends with:

```text
READY FOR PHASE 0 INVENTORY
```

Then start CLIHarbor:

```bat
bin\cliharbor-windows-x64-evaluation.exe
```

No separate Conjur pack download and no `--pack-file` are required for the normal path.

The **Authentication** page provides guided Conjur sign-in without turning CLIHarbor into a credential store. Standard/LDAP password configurations use the narrow loopback credential bridge: on a new computer the UI first gathers only the HTTPS Conjur server/account/mode, delegates fixed reviewed `conjur init self-hosted` setup to the exact discovered CLI, and exposes the password field only after setup succeeds. OIDC, JWT, and Idira SaaS/cloud configurations use **Start official Conjur sign-in**, which launches the same identity-verified Conjur executable with fixed argv `["login"]`. OIDC/JWT run without an unnecessary console window; OIDC retains the vendor browser/callback flow. SaaS/cloud keeps a separate vendor-owned terminal when interactive challenges may require operator input. CLIHarbor does not capture that terminal/browser interaction or receive the resulting credentials. Certificate, IAM, Azure, GCP, and unknown modes remain outside the guided launcher and fail closed to the organization's approved vendor process.

### Discovery order

CLIHarbor discovery is deterministic and intentionally tiered:

1. explicit backend `--tool-path` override;
2. exact verified CLIHarbor-managed copy in the default user cache;
3. exact verified CLIHarbor-managed copy in the persisted custom user-home location;
4. exact pack-declared executable names on absolute `PATH` entries;
5. only when `PATH` has no match, common user-level CLI locations such as `~/go/bin`, `~/.local/bin`, `~/bin`, Windows WinGet links, and Scoop shims.

Fallback locations never override a valid `PATH` match and are not recursively scanned. Multiple candidates within the active discovery tier still fail closed as ambiguous.

### What automatic setup does

On default `serve`, CLIHarbor:

1. loads its embedded reviewed Conjur 9.x pack;
2. discovers existing `conjur.exe` candidates;
3. uses an already installed compatible candidate when discovery is unambiguous;
4. only if Conjur is genuinely **missing**, downloads the pinned official CyberArk Conjur CLI v9.3.1 Windows x64 executable;
5. verifies the exact expected size and SHA-256 before activation and again afterward;
6. stores the fallback only under the current user's CLIHarbor cache;
7. reruns normal version/discovery/identity qualification before any task becomes executable.

Pinned fallback:

```text
CyberArk conjur-cli-go v9.3.1
asset: conjur_windows_amd64.exe
size: 21,950,000 bytes
SHA-256: da2b31ca00b8faaefb8e1fe891563b5cc07c39460e776fb42e7f89b05d3ee4f6
```

CLIHarbor does **not** use a mutable `latest` download.

### No admin credentials

Automatic setup does not:

- write `Program Files`;
- modify machine `PATH`;
- install a Windows service, driver, scheduled task, browser extension, or certificate;
- write machine-wide registry/configuration;
- request elevation intentionally;
- disable SmartScreen, Defender, EDR, AppLocker, WDAC, firewall, proxy, or browser policy.

If policy blocks CLIHarbor or the vendor binary, use the organization's approved signing/allowlisting/software-distribution path. Do not bypass the control.

### Enterprise opt-out

Disable dependency download while retaining the embedded pack:

```bat
bin\cliharbor-windows-x64-evaluation.exe serve --no-auto-setup
```

Pin an approved existing Conjur binary without changing machine `PATH`:

```bat
bin\cliharbor-windows-x64-evaluation.exe serve --tool-path "cyberark-conjur-v9/conjur=C:\path\to\approved\conjur.exe"
```

An explicit override is authoritative; CLIHarbor will not silently replace it.

## What CLIHarbor is

```text
Browser UI
    ↓
authenticated loopback API
    ↓
trusted embedded/explicit pack
    ↓
validated deterministic planner
    ↓
exact executable + argv[]
    ↓
official installed or exact verified managed CLI
```

**Conjur Access & Permissions Explorer:** Open **Built-in CLIs → CyberArk Conjur → Access & permissions**. Search visible inventory by kind and text using bounded server-side pages, inspect individual resources and roles, follow Conjur-permitted roles and direct/expanded role relationships, copy full IDs, and export only whitelisted metadata. The explorer checks CLI and vendor identity/context before and after each read, and discards incomplete or stale results. Role relationships are not proof of effective access; the vendor's native authorization still applies. See [Conjur integration](docs/CONJUR_INTEGRATION.md#access--permissions-explorer).

**Conjur template gallery:** In the migration workbench, filter ready-made
starters for application secrets, database variables, service or developer
permissions, environment-scoped variables, rotation access, and LDAP group/user
mapping. Policy starters clear environment-specific identifiers and use only
reviewed variable/grant shapes. LDAP starters open the existing approved forms;
no template auto-executes or handles secret values.

**Conjur migration workbench:** Open **Built-in CLIs → CyberArk Conjur → Migration playbooks & templates** for guided inventory, LDAP/role comparison, destination preparation and cutover verification. Generate review-only variable/grant policy YAML without secret values, or open the existing approval-gated Conjur tasks with safe prefilled fields. These shortcuts do not execute a migration, transfer secrets, or skip the backend approval process.

**Conjur pattern explorer:** Open **Built-in CLIs → CyberArk Conjur → Security audit**. The default **Variable IDs · regex** mode uses metadata-only Conjur inventory searches, with credential-name, production, service-account and legacy-path presets plus custom Go/RE2 expressions. It never reads secret values. Select **Secret values · regex** only when an authorized value scan is necessary; it requires explicit acknowledgement and returns only variable IDs and match reasons, never values. The Conjur home also has read-only, paginated shortcuts for variables, policies, hosts and groups and links to reviewed access/change tasks. All commands still go through the shared task confirmation path.

The vendor CLI remains the operational authority. The browser never chooses an executable file, executable path used for task execution, subcommand, flag name, shell string, raw argv, dependency URL, or expected hash. For pack-declared portable installs only, the browser may choose a constrained base directory beneath the current user's home; CLIHarbor still derives the final executable path and verifies the exact reviewed bytes.

## Current capabilities

| Area | Implemented |
| --- | --- |
| Local browser security | Ephemeral IPv4 loopback listener, one-time bootstrap, HttpOnly session, exact Host/Origin checks, CSRF protection, restrictive browser headers |
| Trusted packs | Versioned YAML, embedded JSON Schema, semantic/security validation, additive built-in + explicit local sources, deterministic multi-pack registry, discovery-only `pack init`, trusted fixed-probe `pack capture-help`, non-authoritative `pack draft`, non-executing `pack validate`, static `pack compatibility`, deterministic `pack lint`, planner-backed `pack test`, and deterministic `pack generate-tests` fixture scaffolding |
| First-party startup | Embedded reviewed Conjur, Docker, kubectl, and GitHub CLI packs for zero-config `serve` and `doctor` |
| Tool discovery | Windows-first executable discovery, backend-only absolute overrides, ambiguity detection, bounded semantic-version probes |
| Managed dependency fallback | Pinned per-user Conjur v9.3.1 download with HTTPS/origin/size/SHA verification and enterprise opt-out |
| Planning | Typed inputs, trusted literals/flags/switches/enum mappings, constrained positional values, deterministic argv |
| Execution | Direct executable launch, no ordinary shell, executable identity revalidation, bounded timeout/output/cancellation |
| Vendor sessions | Explicit `vendor-session` mode, reviewed zero-input session checks, a Conjur-only ephemeral password bridge, and a Windows vendor-owned Conjur login launcher for reviewed OIDC/JWT/SaaS modes; credentials stay out of task argv/run history/logs and durable session material remains vendor-owned |
| Windows lifecycle | Suspended launch, Job Object assignment before resume, descendant containment and teardown |
| Browser runs | Authenticated run APIs, planner-backed sanitized invocation preview, bounded SSE streaming/replay, reconnect reconciliation, cancellation, in-memory retry-with-inputs, bounded retention and metadata-only Recent Runs history |
| Structured results | Strict bounded scalar JSON parsing, inert React rendering, client-side field filter/sort, explicit per-field copy, normalized JSON inspection, and raw-output fallback |
| Phase 0 evidence | Sanitized inventory, fixed trusted evidence probes, bounded no-clobber JSON export, SHA-256 and strict inspection |
| Diagnostics | Allowlisted non-secret support export; no command output, argv, paths, environment values, browser secrets or credentials |
| Windows qualification | Exact toolchain, deterministic rebuild checks, `EVALUATION_SHA256SUMS`, self-test/evidence smoke and extracted-bundle preflight |
| Conjur integration | Version-gated Conjur CLI 9.x identity, resource, relationship, and role workflows plus approval-gated secret variable create/delete, permission grant/revoke, and set-value, derived from official CyberArk source/release evidence |

Still intentionally gated:

- generic credential forms, embedded MFA/challenge handling, or CLIHarbor-owned token persistence beyond the reviewed Conjur adapters;
- secret-returning workflows;
- change/destructive browser execution beyond the reviewed, approval-gated Conjur tasks;
- automatic execution of unreviewed generated commands;
- generic arbitrary-package installation;
- Windows code signing/publisher attestation.

## Add another CLI without changing Go code

CLIHarbor's core runtime is not Conjur-specific. A separate CLI can be added as another reviewed declarative pack and loaded in the same browser session as the embedded Conjur pack.

To create a discovery-only scaffold without installing Go or Node on a managed workstation, open **Add a CLI → Create a custom CLI pack → Start authoring**. Enter the pack ID, display name, tool ID, executable basename (never an absolute path), and verified target operating systems. Review and download the YAML draft. The draft enables **no commands** and is not automatically loaded; an operator must review it, run the pack validator/linter and restart CLIHarbor with `--pack-file`. This is an offline authoring convenience, not a generic CLI importer.

Alternatively, create the same discovery-only scaffold from the CLI:

```bash
go run ./cmd/cliharbor pack init \
  --id acme-cli \
  --name "Acme CLI" \
  --tool acme \
  --executable acme \
  ./acme.yaml
```

The scaffold intentionally contains **zero commands, zero help probes, and zero version probes**. CLIHarbor does not guess vendor syntax or silently turn discovered executables into browser actions.

If authoritative vendor documentation establishes a safe fixed help invocation, add that argv explicitly under the tool's `helpProbes` metadata. CLIHarbor can then capture exactly that reviewed probe without accepting arbitrary argv:

```bash
go run ./cmd/cliharbor pack capture-help \
  --pack-file ./acme.yaml \
  --tool acme-cli/acme \
  --probe root \
  --tool-path acme-cli/acme=/absolute/path/to/acme \
  ./acme-root-help.txt
```

The capture is sanitized, bounded, no-clobber authoring evidence only. It does not become trusted runtime input and does not add executable commands. You may feed it into the existing discovery-only draft helper:

```bash
go run ./cmd/cliharbor pack draft \
  --id acme-cli-draft \
  --name "Acme CLI Draft" \
  --tool acme \
  --executable acme \
  --help-file ./acme-root-help.txt \
  ./acme-draft.yaml
```

Candidate subcommand names and short safe descriptions produced by `pack draft` remain comments only until a human reviews and authors deterministic command contracts. Control-bearing or oversized descriptions are omitted rather than echoed into the draft.

After adding only reviewed command definitions from authoritative documentation or captured evidence, validate the pack without executing the CLI:

```bash
go run ./cmd/cliharbor pack validate ./acme.yaml
```

Run deterministic authoring-quality/security linting over the already-valid pack:

```bash
go run ./cmd/cliharbor pack lint ./acme.yaml
```

Lint diagnostics have stable severity/code/source/object-path identities. Lint errors fail the command; warnings identify reviewable quality or coverage gaps without making valid future-gated pack metadata unusable. Lint never performs tool discovery, runs probes/tasks, reads authentication/session state, downloads dependencies, or uses an LLM. Ordinary shell metacharacters are not blanket-rejected merely for appearing inside trusted static argv because CLIHarbor executes the selected binary directly without a shell.

Inspect the pack's declared compatibility metadata without touching the current machine or vendor CLI:

```bash
go run ./cmd/cliharbor pack compatibility ./acme.yaml
```

The compatibility matrix is deterministic static authoring output. It reports pack/tool, declared OS, version constraint, managed-install version, and exact managed artifact keys when present. It does not discover executables, run version/help probes or tasks, access vendor sessions, perform network I/O, or install anything. A platform row with no managed artifact does **not** imply CPU-architecture support; it only means the pack expects an existing reviewed vendor CLI for that declared platform.

Generate a deterministic starter contract fixture from a validated pack without launching the declared CLI:

```bash
go run ./cmd/cliharbor pack generate-tests --output ./acme.packtest.json ./acme.yaml
```

Generation uses synthetic local discovery identity plus the production planner to emit exact `expectArgs` success cases and targeted planner-rejection cases for supported input boundaries. It is bounded, no-clobber, does not inspect vendor sessions, and fails closed when CLIHarbor cannot synthesize a safe deterministic input value. The generated fixture is a **reviewable source artifact**, not proof that the vendor command semantics are correct: compare the emitted argv with authoritative vendor documentation/source before accepting it as a contract.

Then run the bounded JSON contract cases through the exact production planner without launching the declared CLI:

```bash
go run ./cmd/cliharbor pack test --cases ./acme.packtest.json ./acme.yaml
```

A contract case either asserts the exact expected argv vector or an expected planner rejection code/path. The test runner creates only synthetic local discovery identity, never executes the CLI, and never runs version/help probes. See `packs/example/packtest.json` for the checked-in example.

When a fixture already exists, lint can correlate it explicitly without discovering nearby files:

```bash
go run ./cmd/cliharbor pack lint --cases ./acme.packtest.json ./acme.yaml
```

That adds coverage diagnostics for planner-runnable commands, consumed inputs, integer bounds, enum rejection, boolean-switch activation, constrained-positional leading-dash rejection, enum-map branches, and inconsistent fixture references. It still does not execute the planner or vendor CLI. In short: **validate** establishes structural/schema/semantic/security validity, **lint** reports deterministic static authoring-quality/security issues, and **test** verifies the production planner contract. None of the three proves the vendor CLI itself is correct.

Then inspect discovery and run it alongside the built-in Conjur integration:

```bash
go run ./cmd/cliharbor doctor --pack-file ./acme.yaml
go run ./cmd/cliharbor serve --pack-file ./acme.yaml
```

Explicit files and one explicit pack directory may be combined in the same process. For a custom-only runtime that omits all embedded first-party packs:

```bash
go run ./cmd/cliharbor doctor --no-default-packs --pack-file ./acme.yaml
go run ./cmd/cliharbor serve --no-default-packs --pack-dir ./my-packs
```

Duplicate pack IDs fail closed. Adding a custom pack never grants Conjur's pinned download behavior to that tool; automatic dependency provisioning remains explicitly limited to the reviewed built-in Conjur contract.

## Docker read-only integration

CLIHarbor also ships a small embedded `docker-cli` pack. It adds read-only workflows for the active Docker context, Docker version information, containers, images, networks, volumes, summary disk usage, and a one-shot running-container resource snapshot. `Show active Docker context` makes the selected Docker target visible without exposing endpoint configuration. The output templates intentionally omit container command lines, labels, environment/config inspection, network endpoint detail, volume mount paths, and verbose disk-usage object detail.

Docker is never downloaded or installed by CLIHarbor; normal executable discovery is used, and a missing Docker CLI simply leaves these tasks unavailable.

See [Docker CLI Integration](docs/DOCKER_INTEGRATION.md).

## kubectl read-only integration

CLIHarbor also ships an embedded `kubectl-cli` pack for active-context visibility plus metadata-only namespace, node, pod, deployment, StatefulSet, DaemonSet, and Job inventory. It also exposes node and cross-namespace pod CPU/memory snapshots through `kubectl top` when Metrics Server is available. Fixed custom-column projections avoid raw Kubernetes object bodies, and cluster-backed tasks reuse kubectl-owned authentication through the existing `vendor-session` contract.

CLIHarbor never downloads kubectl, changes kubeconfig/context, accepts Kubernetes credentials, or exposes Secrets, ConfigMaps, logs, exec/cp/attach, port-forward/proxy, impersonation, or mutation workflows.

See [kubectl Integration](docs/KUBECTL_INTEGRATION.md).

## GitHub CLI read-only integration

The embedded `github-cli` pack adds bounded metadata views for repositories, pull requests, issues, workflow runs, and workflows through the official `gh` CLI (reviewed baseline 2.95.0). Tasks require an explicit owner or repository and use fixed JSON fields. Authentication remains with `gh`; CLIHarbor does not install it or expose tokens, content, logs, or mutations.

Each executable has its own tool category, including in custom packs containing several tools. Missing optional CLIs leave ready tools usable.

See [GitHub CLI integration](docs/GITHUB_INTEGRATION.md).

## Real Conjur 9.x integration

The source pack remains reviewable at:

```text
packs/conjur/conjur-v9.yaml
```

The same bytes are embedded into CLIHarbor for normal startup.

Authoritative upstream baseline:

```text
repository: cyberark/conjur-cli-go
release: v9.3.1
commit: 7207d6a4a2005130978e10d03d7f6b55ab0216d6
supported version constraint: >=9.3.1-0 <10.0.0-0
```

Implemented browser workflows:

- `whoami`
- list resources with approved filters, including members-of/permitted-role relationship queries
- resource exists / show / permitted roles
- role exists / show / members / memberships

Secret retrieval, interactive login/password/MFA handling, API-key rotation, policy mutations, issuer mutations, host-factory mutations, and deployment-specific commands outside the reviewed cross-environment contract are excluded.

See [Conjur CLI 9.x Integration](docs/CONJUR_INTEGRATION.md).

### Authentication behavior

Conjur read tasks use:

```yaml
requirements:
  requiresAuth: true
  authMode: vendor-session
```

Ordinary task execution supplies no password, token, API key, MFA response, or interactive credential stdin. Authentication is a separate reviewed boundary: the qualified Conjur integration may expose the dedicated GUI password bridge or, for reviewed OIDC/JWT/SaaS modes on Windows, launch the exact verified vendor CLI with fixed `login` argv in a separate terminal. Other modes continue to use the approved vendor-owned process.

Installing the vendor executable and authenticating to the vendor are separate operations.

The pack contract supports one validated zero-input, read-only, non-secret `sessionCheck` per tool, and the backend tool API exposes whether a tool has browser-runnable `vendor-session` work plus any reviewed check metadata. The browser Authentication page at `/authentication` consumes that metadata generically and runs only the pack-declared check through the trusted execution path. For the exact qualified Conjur adapter it may also show the reviewed connection/sign-in form; other vendor-session tools do not gain a generic credential form. Conjur declares its reviewed `whoami` check; kubectl intentionally declares no generic session check.

The **Runs** page at `/runs` exposes bounded process-local history. Its list API is metadata-only; raw stdout/stderr and structured result data are fetched only when an operator opens one retained run. Restarting CLIHarbor clears the history.

The **Tasks** page at `/tasks` supports compact catalog search, favorites, and bounded recently used task navigation. Browser persistence contains only versioned `packId`/`commandId` identities; it never stores task values, credentials, run output, argv, or executable paths. Persisted identities are untrusted and are reconciled against the current backend-authorized catalog before they can be selected.

## Security model

Core invariants:

- **Loopback only.** CLIHarbor is not a remote multi-user service.
- **No browser execution authority.** Browser input identifies reviewed tasks plus typed values only.
- **Packs are allowlists.** Schema validation does not create trust.
- **No arbitrary shell.** Normal tasks/probes use exact executable + argv directly.
- **Constrained positionals.** One validated scalar becomes exactly one argv element.
- **Fail closed.** Ambiguous, incompatible, replaced or invalid tools do not execute.
- **Auto-setup only for absence.** CLIHarbor does not replace ambiguous/incompatible/explicit corporate installations.
- **Pinned downloads only.** The current managed fallback has a fixed version, URL, size, digest, platform, destination policy and opt-out.
- **No credential store.** Vendor auth remains vendor-owned.
- **Read-only/non-secret browser envelope.** Secret/change/destructive workflows remain blocked.
- **Enterprise controls win.** Application-control/network policy is never bypassed.

See [Security](docs/SECURITY.md), [Authentication](docs/AUTHENTICATION.md), [Architecture](docs/ARCHITECTURE.md), and [Pack specification](docs/PACK_SPEC.md).

## Zero-config diagnostics

The embedded first-party pack is also used by:

```bat
bin\cliharbor-windows-x64-evaluation.exe doctor
```

`doctor` does **not** auto-download Conjur. It reports the local discovery/version state so a locked-down operator can inspect the environment without causing dependency network activity.

Explicit source/operator packs can be added to the default runtime:

```bash
go run ./cmd/cliharbor doctor --pack-file ./my-cli.yaml
go run ./cmd/cliharbor serve --pack-file ./my-cli.yaml
```

Use `--no-default-packs` when intentionally testing only explicit packs. Custom packs do not inherit first-party automatic provisioning; the reviewed Conjur bootstrap remains scoped to the embedded Conjur pack/tool identity.

## Phase 0 evaluation

The external evaluation ZIP remains intentionally small and immutable:

```text
EVALUATION_SHA256SUMS
bin/
  cliharbor-windows-x64-evaluation.exe
packs/
  phase0/
    idira-cyberark-inventory.yaml
```

The real Conjur pack is inside the executable rather than copied into this extracted layout. Preflight therefore remains strict while the post-preflight product startup needs no second artifact.

Optional discovery-only inventory:

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml"
```

For the full managed-device procedure, see [Work-Laptop Evaluation](docs/WORK_LAPTOP_EVALUATION.md).

## Developer quickstart

Pinned toolchain:

- Go **1.27.1** from [`.go-version`](.go-version)
- Node **24.21.0** from [`.node-version`](.node-version)
- npm **>=11.6.0 <12**

```bash
git clone https://github.com/Quazmoz/CLIHarbor.git
cd CLIHarbor
npm ci --prefix web
go run ./tools/task check
go run ./cmd/cliharbor --help
go run ./cmd/cliharbor self-test
go run ./cmd/cliharbor serve
```

Use `go run ./cmd/cliharbor help <command>` (or `<command> --help`) for command-specific operator guidance; nested command help such as `help pack init` is also available.

### Reliable clean restart after code changes

CLIHarbor serves **generated Vite assets embedded into the Go executable** by default. Simply re-running `go run ./cmd/cliharbor serve` does **not** rebuild React, and re-opening an old browser tab may connect to an old or stopped loopback instance. The local HTTP server already sends `Cache-Control: no-store`; the common stale-UI cause is an old executable or unsynchronized embedded assets, not a browser cache you need to delete.

For ordinary development/testing, use the repo-owned helpers **from the repository root**. On Windows, the PowerShell helper runs `go run ./tools/task web-build` first (frontend dependency install, typecheck, lint, tests, Vite production build, embedded-asset replacement), **before stopping** any helper-owned process. Once frontend validation succeeds, it stops only its verified previous process and runs `go run ./tools/task go-build`, then starts the fresh executable on a new ephemeral loopback port. The bash helper still uses `go run ./tools/task build` for both phases. The helpers use `--no-auto-setup` to avoid an unexpected vendor dependency download during development. They do **not** dispatch GitHub Actions.

**macOS / Linux (bash):**

```bash
bash tools/dev-restart.sh --pull  # Optional: ff-only pull, then stop/build/start
bash tools/dev-restart.sh         # After local edits: stop/build/start, no pull
bash tools/dev-restart.sh --stop  # Stop only this helper's instance
```

**Windows PowerShell (development machine with approved Go/Node toolchains):**

```powershell
.\tools\dev-restart.ps1 -Pull     # Optional: ff-only pull, then stop/build/start
.\tools\dev-restart.ps1           # After local edits: stop/build/start
.\tools\dev-restart.ps1 -Stop     # Stop only this helper's instance
```

**First migration from manual starts:** Stop previously launched `go run ./cmd/cliharbor serve`, `bin/cliharbor serve`, or Vite development terminals yourself (usually **Ctrl+C**). The helpers deliberately do not `pkill` arbitrary processes, stop unrelated listeners, purge browser profiles, or delete cached vendor credentials/Conjur sessions. On Windows, stopping a *helper-owned* process uses Windows process termination; only use it when no CLI task, Conjur login or approval-gated mutation is in flight.

For Windows, invoke the **file** (for example `& .\tools\dev-restart.ps1 -Pull`) instead of pasting individual lines into PowerShell. If the prompt is `>>`, PowerShell is waiting for the rest of an incomplete command; press **Ctrl+C** before invoking the file. The `-Pull` form performs a fast-forward pull and then **re-invokes the updated file** without `-Pull`; it does not continue executing the pre-update script. Inline/script-block evaluation also works from the CLIHarbor repository root; if the script cannot identify that checkout, it fails with a location error rather than passing a null path to `Join-Path`. The helper accepts invocation from other working directories when launched as a file.

Run the appropriate restart helper **even on the first launch**: with no helper-managed process or PID marker, it builds and starts CLIHarbor; with a stale marker for an exited process, it cleans up the marker and starts a fresh instance. `--stop` / `-Stop` is the only stop-only mode. The helpers do not control separately launched CLIHarbor or Vite processes.

The helper's PID and private startup log live under ignored `bin/`. If a PID belongs to another process, it **refuses to kill it**. On Windows the frontend checks **and staged Go compilation both finish before** the helper stops its verified previous instance, so an ordinary build failure leaves that instance running. After a successful staged build, the helper retains a temporary previous-executable backup until the replacement confirms startup. If a replacement fails before startup and is no longer running, the helper restores the previous executable but **does not silently relaunch it**; if the replacement process might still be running, it leaves the backup for manual recovery. Review private `bin/` startup logs for any unconfirmed launch. Never run the helper during an active vendor command or interactive sign-in. For precise diagnostics, run `go run ./tools/task web-build` or `go run ./tools/task go-build` directly and capture the first `task:` error. If a restart reports a build/test failure, resolve it rather than running an old executable. Use the **new browser tab**; old tabs point to old per-process ports. If the browser does not open automatically, consult the private log for its one-time bootstrap URL and do not share that URL.

**Important:** The local helper produces freshly built assets **in your working tree**. If `internal/webui/static/` changes, commit those generated assets along with source changes before merging/releasing. The helper is not a substitute for repository quality gates or real enterprise/Windows acceptance. Do not reset/clean away unsaved code to make `--pull` work; resolve local changes first. If corporate PowerShell execution policy blocks the helper, use the approved manual build/start procedure rather than changing security policy.

Frontend development:

```bash
# Terminal 1
go run ./tools/task web-dev

# Terminal 2
go run ./cmd/cliharbor serve --web-dev-url http://127.0.0.1:5173
```

Production assets are generated from `web/` and embedded under `internal/webui/static`. Do not edit generated assets manually.

## Verification commands

Repository-owned gate:

```bash
go run ./tools/task check
```

Individual gates include:

```bash
go fmt ./...
go vet ./...
go test -timeout 2m ./...
go test -race -timeout 2m ./...
go run ./tools/task verify-web-sync
go run ./tools/task go-build
go run ./tools/task fixture-build
go run ./tools/task windows-eval
go run ./tools/task verify-windows-eval
go run ./tools/task verify-windows-eval-repro
```

CI additionally runs frontend checks, module verification, dependency/vulnerability scans, production browser E2E, Windows/macOS/Linux quality jobs, race detection and Windows evaluation smoke/preflight qualification.

## Privacy-preserving diagnostics

```bash
go run ./cmd/cliharbor diagnostics export ./cliharbor-diagnostics.json
```

Diagnostics are allowlisted metadata and exclude command stdout/stderr, argv, executable/candidate paths, environment values, pack source paths, browser secrets and credential data. CLIHarbor performs no automatic upload.

## Repository layout

```text
cmd/cliharbor/             CLI entry point and operator commands
internal/app/              lifecycle, default-pack and setup wiring
internal/server/           loopback HTTP/session/origin/CSRF boundary
internal/packs/            pack model, loader, schema and validation
internal/discovery/        executable discovery, version probes and identity
internal/toolbootstrap/    pinned reviewed current-user vendor bootstrap
internal/planner/          typed input -> immutable execution plan
internal/executor/         direct bounded process execution
internal/processcontrol/   platform process-lifecycle ownership
internal/runs/             bounded run state, events and replay
internal/structured/       bounded structured-result parsing
internal/evidence/         Phase 0 evidence export/import/integrity
internal/diagnostics/      allowlisted support export
internal/webui/            embedded production frontend assets
web/                       React + TypeScript + Vite source
packs/embed.go             first-party pack embedding
packs/example/             synthetic fixtures
packs/phase0/              discovery/evidence-only vendor pack
packs/conjur/              reviewed Conjur pack source
schemas/                   embedded pack JSON Schema
tools/task/                build/verification/evaluation tasks
docs/                      product, architecture, security and operations docs
```

## Documentation

| Document | Purpose |
| --- | --- |
| [Quickstart](QUICKSTART.md) | shortest one-download/non-admin startup path |
| [Conjur integration](docs/CONJUR_INTEGRATION.md) | upstream provenance, managed fallback and command scope |
| [PRD](docs/PRD.md) | product scope and acceptance |
| [Architecture](docs/ARCHITECTURE.md) | component, setup and execution boundaries |
| [Security](docs/SECURITY.md) | threat model, download controls and trust boundaries |
| [Authentication](docs/AUTHENTICATION.md) | vendor-owned session model |
| [Pack specification](docs/PACK_SPEC.md) | declarative pack safety contract |
| [UX](docs/UX.md) | browser/operator model |
| [Decisions](docs/DECISIONS.md) | architecture/security decisions |
| [Test strategy](docs/TEST_STRATEGY.md) | verification contract |
| [Roadmap](docs/ROADMAP.md) | product stages and next gates |
| [Work-laptop evaluation](docs/WORK_LAPTOP_EVALUATION.md) | managed-Windows procedure |

## Design position

CLIHarbor is intentionally narrower than a terminal emulator, shell wrapper, remote execution service, credential manager, generic package manager, or automatic runtime CLI scraper.

Its value comes from making **known, reviewed CLI workflows** easy to use while retaining a small inspectable authority boundary. A new automatic dependency is accepted only when its exact source/version/hash/platform/install policy is reviewed and the installed bytes still pass normal CLIHarbor discovery/version/identity checks.

## Mutation audit trail and undo safety

Reviewed change and destructive operations are now synchronously journaled to a private, append-only local audit file before execution. Open **Runs → Mutation audit trail** to see approvals, outcomes and targets after restart; this is separate from temporary raw run history. The journal never persists passwords, stdin, stdout/stderr or argv. Failed/unavailable audit storage blocks new mutations. **No automated undo is enabled** until inverse operations are independently qualified with remote pre-state and drift checks. See [Mutation audit and recovery](docs/MUTATION_AUDIT.md).

## Configure the Conjur API backend (SaaS)

In **Dedicated CLIs → CyberArk Conjur → Sign in**, open **Conjur API connection**. The page now reads the **effective configuration owned by the official Conjur CLI** (the actual API endpoint and account), rather than collecting an unrelated Identity-portal bookmark.

For Idira Secrets Manager SaaS, enter your organization's **API service URL**, e.g. `https://companyname.secretsmgr.cyberark.cloud`, **not** `https://companyname.cyberark.cloud` (the separate Identity website). CLIHarbor validates a direct single-tenant HTTPS Secrets Manager hostname, delegates to the exact discovered vendor CLI with reviewed `conjur init saas --url <url>` arguments, and reads the resulting vendor configuration back. The CLI normalizes the saved endpoint to `/api`. The existing self-hosted account/password onboarding wizard remains available.

When an existing eligible SaaS endpoint is configured, **Change API endpoint** requires explicit acknowledgement of replacing that configuration and sends the expected previous endpoint to the backend. The server rechecks the current authoritative SaaS configuration, refuses stale, unsupported, externally overridden, or read-only configurations, then invokes the vendor's `--force` overwrite *only* for an exact approved SaaS-to-SaaS change. It does not manually modify `.conjurrc`, adjust TLS trust, skip validation, or change OS/vendor-stored credentials. A different enterprise mode must still be configured through the official CLI.

After changing the API endpoint, **sign in again and Check session** before running tasks. An earlier session against another tenant is not evidence for the new endpoint. The connection is stored by Conjur, not CLIHarbor browser local storage. This feature is limited to the reviewed SaaS setup/replacement and existing self-hosted first-run wizard; it is not a generic config editor.
