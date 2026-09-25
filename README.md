# CLIHarbor

A Windows-first local browser UI for safely exposing curated workflows from official command-line tools.

**Status:** active hardening. The generic runtime, trusted-pack model, bounded read-only execution, browser UI, Phase 0 evidence flow, privacy-preserving diagnostics, Windows evaluation qualification, and the first real CyberArk/Idira Conjur 9.x read-only integration are implemented.

CLIHarbor has **no cloud backend**, does **not** execute arbitrary shell strings, and does **not** store vendor credentials.

> **Fastest path:** download the qualified Windows artifact, run preflight, then run the CLIHarbor EXE with no pack arguments. The trusted Conjur pack is embedded, and if Conjur is genuinely missing CLIHarbor can install the exact reviewed CyberArk CLI into the current user's cache without administrator credentials. See [QUICKSTART.md](QUICKSTART.md).

## One-download Windows startup

For the normal managed-Windows user path:

1. Open the repository's [CI workflow](https://github.com/Quazmoz/CLIHarbor/actions/workflows/ci.yml).
2. Choose a **successful `main` run**.
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

The vendor CLI remains the operational authority. The browser never chooses an executable, executable path, subcommand, flag name, shell string, raw argv, dependency URL, expected hash, or installation destination.

## Current capabilities

| Area | Implemented |
| --- | --- |
| Local browser security | Ephemeral IPv4 loopback listener, one-time bootstrap, HttpOnly session, exact Host/Origin checks, CSRF protection, restrictive browser headers |
| Trusted packs | Versioned YAML, embedded JSON Schema, semantic/security validation, built-in and explicit local trusted sources, deterministic registry |
| First-party startup | Embedded reviewed Conjur pack for zero-config `serve` and `doctor` |
| Tool discovery | Windows-first executable discovery, backend-only absolute overrides, ambiguity detection, bounded semantic-version probes |
| Managed dependency fallback | Pinned per-user Conjur v9.3.1 download with HTTPS/origin/size/SHA verification and enterprise opt-out |
| Planning | Typed inputs, trusted literals/flags/switches/enum mappings, constrained positional values, deterministic argv |
| Execution | Direct executable launch, no ordinary shell, executable identity revalidation, bounded timeout/output/cancellation |
| Vendor sessions | Explicit `vendor-session` mode plus a first-class Authentication readiness page that verifies the reviewed `whoami` workflow without CLIHarbor credentials |
| Windows lifecycle | Suspended launch, Job Object assignment before resume, descendant containment and teardown |
| Browser runs | Authenticated run APIs, bounded SSE streaming/replay, reconnect reconciliation, cancellation and bounded retention |
| Structured results | Strict bounded scalar JSON parsing, inert React rendering and raw-output fallback |
| Phase 0 evidence | Sanitized inventory, fixed trusted evidence probes, bounded no-clobber JSON export, SHA-256 and strict inspection |
| Diagnostics | Allowlisted non-secret support export; no command output, argv, paths, environment values, browser secrets or credentials |
| Windows qualification | Exact toolchain, deterministic rebuild checks, `EVALUATION_SHA256SUMS`, self-test/evidence smoke and extracted-bundle preflight |
| Conjur integration | Version-gated Conjur CLI 9.x read-only workflows derived from official CyberArk source/release evidence |

Still intentionally gated:

- CLIHarbor-owned username/password/MFA forms or token persistence;
- secret-returning workflows;
- change/destructive browser execution;
- automatic execution of unreviewed generated commands;
- generic arbitrary-package installation;
- Windows code signing/publisher attestation.

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
- list resources with approved filters
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

CLIHarbor supplies no password, token, API key, MFA response, or interactive credential stdin. If no valid vendor session exists, authenticate through the approved vendor-owned process and retry.

Installing the vendor executable and authenticating to the vendor are separate operations.

The browser Authentication page at `/authentication` reports both states separately. It never presents credential inputs or a fake login button. **Check session** runs the reviewed `whoami` task through CLIHarbor's existing trusted execution path; successful execution is session evidence, while unknown/non-reviewed vendor failures remain unknown rather than being mislabeled as signed out.

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

Explicit source/operator pack testing remains available:

```bash
go run ./cmd/cliharbor doctor --pack-file packs/conjur/conjur-v9.yaml
go run ./cmd/cliharbor serve --pack-file packs/conjur/conjur-v9.yaml --no-auto-setup
```

Explicit pack selection replaces the default-pack path and does not silently enable first-party auto-provisioning.

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
go run ./cmd/cliharbor self-test
go run ./cmd/cliharbor serve
```

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
go run ./tools/task windows-eval
go run ./tools/task verify-windows-eval
go run ./tools/task verify-windows-eval-repro
```

CI additionally runs frontend checks, module verification, dependency/vulnerability scans, production browser E2E, Windows/Linux quality jobs, race detection and Windows evaluation smoke/preflight qualification.

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
