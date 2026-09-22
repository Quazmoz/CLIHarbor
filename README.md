# CLIHarbor

A Windows-first local browser UI for safely exposing curated workflows from official command-line tools.

**Status:** active hardening. The generic runtime, trusted-pack model, bounded read-only execution, browser UI, Phase 0 evidence flow, privacy-preserving diagnostics, Windows evaluation qualification, and the first real CyberArk/Idira Conjur 9.x read-only pack are implemented.

CLIHarbor has **no cloud backend**, does **not** execute arbitrary shell strings, and does **not** store vendor credentials.

> **Want to run it?** Start with [QUICKSTART.md](QUICKSTART.md). For a managed Windows work laptop, use the qualified CI artifact in a normal non-elevated user session — **no Windows administrator login, installation, Go, Node/npm, Git, or PowerShell is required**.

## What CLIHarbor is

CLIHarbor is a thin orchestration and presentation layer around installed official CLIs:

```text
Browser UI
    ↓
authenticated loopback API
    ↓
trusted declarative pack
    ↓
validated deterministic planner
    ↓
exact executable + argv[]
    ↓
official installed CLI
```

The installed CLI remains the operational authority. The browser never chooses an executable, executable path, subcommand, flag name, shell string, or raw argv.

## Current capabilities

| Area | Implemented |
| --- | --- |
| Local browser security | Ephemeral IPv4 loopback listener, one-time bootstrap, HttpOnly session, exact Host/Origin checks, CSRF protection, restrictive browser headers |
| Trusted packs | Versioned YAML, embedded JSON Schema, semantic/security validation, explicit trusted sources only, deterministic registry |
| Tool discovery | Windows-first executable discovery, backend-only absolute overrides, ambiguity detection, bounded semantic-version probes |
| Planning | Typed inputs, trusted literals/flags/switches/enum mappings, constrained positional values, deterministic argv |
| Execution | Direct executable launch, no ordinary shell, executable identity revalidation, bounded timeout/output/cancellation |
| Vendor sessions | Explicit `vendor-session` mode lets read-only commands reuse vendor-owned authentication without CLIHarbor accepting credentials |
| Windows lifecycle | Suspended launch, Job Object assignment before resume, descendant containment and teardown |
| Browser runs | Authenticated run APIs, bounded SSE streaming/replay, reconnect reconciliation, cancellation and bounded retention |
| Structured results | Strict bounded scalar JSON parsing, inert React rendering and raw-output fallback |
| Phase 0 evidence | Sanitized inventory, fixed trusted evidence probes, bounded no-clobber JSON export, SHA-256 and strict inspection |
| Diagnostics | Allowlisted non-secret support export; no command output, argv, paths, environment values, browser secrets or credentials |
| Windows qualification | Exact Go toolchain, controlled inputs, deterministic rebuild checks, `EVALUATION_SHA256SUMS`, self-test/evidence smoke and extracted-bundle preflight |
| Conjur integration | Version-gated Conjur CLI 9.x read-only workflows derived from official CyberArk source/release evidence |

Still intentionally gated:

- CLIHarbor-owned username/password/MFA forms or token persistence;
- secret-returning workflows;
- change/destructive browser execution;
- automatic execution of unreviewed generated commands;
- Windows code signing/publisher attestation;
- public pack distribution.

## Real Conjur 9.x integration

CLIHarbor now includes:

```text
packs/conjur/conjur-v9.yaml
```

The pack is derived from the official `cyberark/conjur-cli-go` **v9.3.1** release and commit:

```text
7207d6a4a2005130978e10d03d7f6b55ab0216d6
```

It requires:

```text
>=9.3.1 <10.0.0
```

so an older or future-major binary does not silently inherit command authority.

Implemented browser workflows:

- `whoami`
- list resources with approved filters
- resource exists / show / permitted roles
- role exists / show / members / memberships

The integration deliberately excludes secret retrieval, login/password/MFA handling, API-key rotation, policy mutations, issuer mutations, and deployment-specific commands that cannot be safely generalized.

See [Conjur CLI 9.x Integration](docs/CONJUR_INTEGRATION.md) for provenance, command mapping and qualification details.

### Run the Conjur pack from source

```bash
go run ./cmd/cliharbor doctor --pack-file packs/conjur/conjur-v9.yaml
go run ./cmd/cliharbor serve --pack-file packs/conjur/conjur-v9.yaml
```

If the approved `conjur` executable is outside `PATH`, configure it at the backend/operator boundary:

```text
--tool-path cyberark-conjur-v9/conjur=C:\path\to\conjur.exe
```

The browser cannot provide or change that path.

### Authentication behavior

Conjur read-only tasks declare:

```yaml
requirements:
  requiresAuth: true
  authMode: vendor-session
```

CLIHarbor may therefore invoke the verified read-only command using the vendor CLI's existing session/configuration. It supplies no password, token, API key, MFA response, or interactive stdin. If no valid vendor session exists, authenticate through the approved vendor-owned flow and retry.

Generic `requiresAuth: true` commands without an approved auth mode remain blocked.

## Security model

The core invariants are:

- **Loopback only.** The server binds to `127.0.0.1`; CLIHarbor is not a remote multi-user service.
- **No browser execution authority.** Browser requests identify trusted tasks plus typed values only.
- **Packs are allowlists.** Validation does not create trust; packs must be explicitly loaded from trusted sources.
- **No arbitrary shell.** Normal tasks/probes execute an exact executable plus argument array directly.
- **Constrained positional values.** One validated scalar becomes exactly one argv element; no tokenization, templates or shell interpretation. Leading-dash values are rejected where they could become undeclared flags.
- **Fail closed.** Missing, ambiguous, incompatible, replaced or otherwise invalid tools do not execute.
- **No credential store.** Vendor credentials/session tokens remain outside CLIHarbor's persistence model.
- **Secret-bearing execution remains blocked.** Current browser execution is read-only and non-secret.
- **Bounds everywhere.** Process time/output, streams, replay, retained runs, probes, evidence and diagnostics are bounded.
- **Exact execution evidence.** Discovery-time executable identity is revalidated immediately before launch.
- **Enterprise controls win.** Do not disable or evade SmartScreen, Defender, EDR, AppLocker, WDAC, proxy, firewall or browser policy to run CLIHarbor.

See [Security](docs/SECURITY.md), [Authentication](docs/AUTHENTICATION.md), [Architecture](docs/ARCHITECTURE.md), and [Pack specification](docs/PACK_SPEC.md).

## Download and run

There are two intentionally different paths:

| Goal | Recommended path |
| --- | --- |
| Evaluate on a managed Windows laptop | Download the qualified Windows x64 CI artifact and run it as the currently signed-in user |
| Develop or run packs from source | Clone the repository and use the pinned Go/Node toolchain |

### Windows work-laptop evaluation — no admin login required

The evaluation distribution is a qualified GitHub Actions artifact, not an installer.

1. Open the repository's [CI workflow](https://github.com/Quazmoz/CLIHarbor/actions/workflows/ci.yml).
2. Choose a **successful** `main` run for the commit you intend to test.
3. Download `cliharbor-windows-x64-evaluation-<commit-sha>` from **Artifacts**.
4. Extract it into a new, otherwise empty, user-writable directory.
5. Open Command Prompt normally — **not** with **Run as administrator**.
6. From the extracted bundle root run:

```bat
bin\cliharbor-windows-x64-evaluation.exe evaluation preflight --bundle "."
```

Continue only if it ends with:

```text
READY FOR PHASE 0 INVENTORY
```

Then run the discovery-only packaged inventory:

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml"
```

The qualified evaluation bundle is intentionally immutable. Do **not** copy `conjur-v9.yaml` into it before preflight. To test the real Conjur pack after successful preflight, keep the pack outside the bundle and load it explicitly as documented in [Conjur CLI 9.x Integration](docs/CONJUR_INTEGRATION.md).

**User-context guarantee:** CLIHarbor has no privileged helper and must not silently elevate. If CLIHarbor itself unexpectedly requests UAC/admin credentials, cancel and investigate the launch or enterprise-policy path rather than supplying administrator credentials.

For the full managed-device process, use [Work-Laptop Evaluation](docs/WORK_LAPTOP_EVALUATION.md).

## Developer quickstart

Pinned toolchain:

- Go **1.27.1** from [`.go-version`](.go-version)
- Node **24.21.0** from [`.node-version`](.node-version)
- npm **>=11.6.0 <12** from `web/package.json`

```bash
git clone https://github.com/Quazmoz/CLIHarbor.git
cd CLIHarbor
npm ci --prefix web
go run ./tools/task check
go run ./cmd/cliharbor self-test
go run ./cmd/cliharbor serve
```

Synthetic pack discovery:

```bash
go run ./cmd/cliharbor doctor --pack-file packs/example/pack.yaml
go run ./cmd/cliharbor inventory --pack-file packs/example/pack.yaml
```

Conjur 9.x:

```bash
go run ./cmd/cliharbor doctor --pack-file packs/conjur/conjur-v9.yaml
go run ./cmd/cliharbor serve --pack-file packs/conjur/conjur-v9.yaml
```

### Frontend development

Use two terminals:

```bash
# Terminal 1
go run ./tools/task web-dev

# Terminal 2
go run ./cmd/cliharbor serve --web-dev-url http://127.0.0.1:5173
```

Production assets are generated from `web/` and embedded under `internal/webui/static`. Do not edit generated assets manually.

## Verification commands

Use the repository-owned workflow where possible:

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

CI additionally runs frontend typecheck/lint/tests/build, generated-asset drift checks, module verification, dependency vulnerability scans, production browser E2E, Windows/Linux quality jobs, race detection and the Windows evaluation smoke/preflight flow.

## Privacy-preserving diagnostics

Without a pack:

```bash
go run ./cmd/cliharbor diagnostics export ./cliharbor-diagnostics.json
```

With an explicitly trusted pack:

```bash
go run ./cmd/cliharbor diagnostics export \
  --pack-file packs/conjur/conjur-v9.yaml \
  ./cliharbor-diagnostics.json
```

Diagnostics are allowlisted metadata and exclude command stdout/stderr, argv, executable/candidate paths, environment values, pack source paths, browser secrets and credential data. CLIHarbor performs no automatic upload.

## Windows evaluation flow

```text
windows-eval
    ↓
EVALUATION_SHA256SUMS
    ↓
verify-windows-eval
    ↓
verify-windows-eval-repro
    ↓
self-test / packaged evidence smoke
    ↓
clean extracted-bundle evaluation preflight
    ↓
final bundle verification / artifact upload
```

`EVALUATION_SHA256SUMS` covers the evaluation executable and trusted Phase 0 pack. Checksum equality proves byte integrity/determinism under that qualification contract; it is **not** publisher identity, code signing, host attestation or independent supply-chain provenance.

## Repository layout

```text
cmd/cliharbor/             CLI entry point and operator commands
internal/app/              application lifecycle and command wiring
internal/server/           loopback HTTP/session/origin/CSRF boundary
internal/packs/            pack model, loader, schema and validation
internal/discovery/        executable discovery, version probes and identity
internal/planner/          typed input -> immutable execution plan
internal/executor/         direct bounded process execution
internal/processcontrol/   platform process-lifecycle ownership
internal/runs/             bounded run state, events and replay
internal/structured/       bounded structured-result parsing
internal/evidence/         Phase 0 evidence export/import/integrity
internal/diagnostics/      allowlisted support export
internal/webui/            embedded production frontend assets
web/                       React + TypeScript + Vite source
packs/example/             synthetic fixtures
packs/phase0/              discovery/evidence-only vendor pack
packs/conjur/              real version-gated Conjur pack
schemas/                   embedded pack JSON Schema
tools/task/                build/verification/evaluation tasks
docs/                      product, architecture, security and operations docs
```

## Current vendor qualification boundary

The generic Conjur 9.x command contract is now implemented from authoritative online CyberArk source/release evidence. What online evidence cannot prove is the exact binary, version, enterprise configuration, authentication state and policy installed on a specific managed work laptop.

Therefore the remaining managed-device gate is **qualification**, not command invention:

1. run the qualified CLIHarbor preflight;
2. identify the intended corporate `conjur.exe` unambiguously;
3. require a compatible version;
4. compare fixed help probes where needed;
5. execute a non-secret read workflow using the approved existing vendor session.

A mismatch should produce a revised/versioned pack, not relaxed validation.

## Documentation

| Document | Purpose |
| --- | --- |
| [Quickstart](QUICKSTART.md) | shortest download/run path, including non-admin work-laptop startup |
| [Conjur integration](docs/CONJUR_INTEGRATION.md) | official upstream provenance, implemented workflows and qualification boundary |
| [PRD](docs/PRD.md) | product scope, goals, non-goals and acceptance |
| [Architecture](docs/ARCHITECTURE.md) | component boundaries, state, execution and evaluation model |
| [Security](docs/SECURITY.md) | threat model, controls and trust boundaries |
| [Authentication](docs/AUTHENTICATION.md) | vendor-owned session/authentication model |
| [Pack specification](docs/PACK_SPEC.md) | declarative pack contract and safety constraints |
| [UX](docs/UX.md) | browser/operator interaction model |
| [Decisions](docs/DECISIONS.md) | architecture/security decisions |
| [Development plan](docs/DEVELOPMENT_PLAN.md) | implementation phases and acceptance gates |
| [Test strategy](docs/TEST_STRATEGY.md) | risk-based verification contract |
| [Roadmap](docs/ROADMAP.md) | current product stages and next gates |
| [Work-laptop evaluation](docs/WORK_LAPTOP_EVALUATION.md) | controlled managed-Windows evaluation procedure |
| [Contributing](CONTRIBUTING.md) | repository development workflow |

## Design position

CLIHarbor is intentionally narrower than a terminal emulator, shell wrapper, remote execution service, credential manager, or automatic CLI scraper at runtime.

Its value comes from making **known, reviewed CLI workflows** easier to use while retaining a small inspectable authority boundary. If a workflow cannot be represented safely as trusted configuration plus validated typed input and exact argv, it does not belong in the generic execution path.
