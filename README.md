# CLIHarbor

A Windows-first, local browser UI for safely exposing curated workflows from official command-line tools.

**Status:** active hardening. The generic local runtime, trusted-pack model, bounded read-only execution path, browser UI, Phase 0 evidence flow, privacy-preserving diagnostics, and Windows evaluation qualification are implemented. Real Idira/CyberArk command definitions remain intentionally gated on evidence from the actual company-managed Windows environment.

CLIHarbor has **no cloud backend**, does **not** run arbitrary shell strings, and does **not** store vendor credentials.

## What CLIHarbor is

CLIHarbor is a thin orchestration and presentation layer around installed CLIs. The browser never chooses an executable or constructs argv.

```text
Browser UI
    ↓
authenticated loopback API
    ↓
trusted declarative pack
    ↓
validated planner
    ↓
direct executable + argv
    ↓
official installed CLI
```

The installed CLI remains the operational authority. CLIHarbor owns only the local UI/runtime boundary: trusted pack loading, deterministic discovery, typed planning, bounded process execution, streaming, structured rendering, and support/evaluation tooling.

## Current capabilities

| Area | Implemented |
| --- | --- |
| Local browser security | Ephemeral IPv4 loopback listener, one-time bootstrap, in-memory HttpOnly session, exact Host/Origin checks, CSRF protection, restrictive browser headers |
| Trusted packs | Versioned YAML, embedded JSON Schema, semantic/security validation, explicit trusted sources only, deterministic registry |
| Tool discovery | Windows-first executable discovery, backend-only absolute overrides, ambiguity detection, fixed bounded semantic-version probes |
| Planning and execution | Typed inputs, server-owned executable + argv, no ordinary shell execution, exact executable identity revalidation, bounded timeout/output |
| Windows process lifecycle | Suspended launch, Job Object assignment before resume, descendant containment, cancellation/timeout teardown |
| Browser runs | Authenticated run APIs, bounded SSE streaming/replay, reconnect reconciliation, cancellation, bounded retained state |
| Structured results | Strict bounded scalar JSON parsing with inert React rendering and raw-output fallback |
| Phase 0 evidence | Sanitized inventory, fixed trusted evidence probes, bounded no-clobber JSON export, detached SHA-256, strict inspection |
| Support diagnostics | `cliharbor diagnostics export` emits only allowlisted non-secret metadata; no command output, argv, paths, environment values, browser secrets, or credential material |
| Evaluation qualification | Exact Go toolchain, controlled build inputs, isolated deterministic rebuilds, authoritative `EVALUATION_SHA256SUMS`, vendor-free self-test/evidence smoke |

Not yet implemented or intentionally gated:

- real Idira/CyberArk workflow argv and output schemas;
- vendor authentication orchestration;
- mutating/destructive or secret-bearing workflows;
- credential persistence;
- code signing/publisher attestation;
- public pack distribution.

The vendor-specific items are blocked by design until Phase 0 evidence establishes the exact installed CLI behavior. CLIHarbor does not guess enterprise command syntax.

## Security model

The important invariants are simple:

- **Loopback only.** The application server binds to `127.0.0.1`; there is no remote multi-user service.
- **The browser has no execution authority.** It submits pack/command IDs and typed values, never an executable path, shell command, flag name, or raw argv.
- **Trusted packs are allowlists.** Packs are explicitly loaded privileged configuration, not discovered from the current directory or downloaded dynamically.
- **No arbitrary shell.** Normal tasks and probes start the resolved executable directly with an argument array.
- **Fail closed.** Missing, ambiguous, incompatible, replaced, or otherwise invalid tools do not execute.
- **No credential store.** Vendor passwords, MFA values, cookies, tokens, and keystore contents are outside CLIHarbor's persistence model.
- **Outputs and state are bounded.** Run output, structured parsing, replay, retention, probes, evidence, and diagnostics have explicit resource limits.
- **Execution evidence is exact.** Discovery-time executable identity is revalidated immediately before launch.
- **Diagnostics are allowlisted, not scraped.** Support export is constructed from approved metadata fields rather than filesystem/log/environment collection or regex-only redaction.

See [Security](docs/SECURITY.md), [Architecture](docs/ARCHITECTURE.md), and [Authentication](docs/AUTHENTICATION.md) for the full threat model and trust boundaries.

## Getting started

### Prerequisites

The repository pins:

- Go **1.27.1** in [`.go-version`](.go-version)
- Node **24.21.0** in [`.node-version`](.node-version)
- npm **>=11.6.0 <12** in `web/package.json`

Install frontend dependencies:

```bash
npm ci --prefix web
```

Run the repository quality task:

```bash
go run ./tools/task check
```

Run the vendor-free local self-test:

```bash
go run ./cmd/cliharbor self-test
```

Start the production-style embedded application without a pack:

```bash
go run ./cmd/cliharbor serve
```

Load the synthetic example pack for discovery:

```bash
go run ./cmd/cliharbor doctor --pack-file packs/example/pack.yaml
go run ./cmd/cliharbor inventory --pack-file packs/example/pack.yaml
```

The example pack does not auto-trust or auto-execute anything; it normally reports its fixture tool as unavailable unless you deliberately provide a compatible executable.

### Privacy-preserving diagnostics

Export a support bundle without loading a vendor pack:

```bash
go run ./cmd/cliharbor diagnostics export ./cliharbor-diagnostics.json
```

Or include sanitized readiness metadata for an explicitly trusted pack:

```bash
go run ./cmd/cliharbor diagnostics export \
  --pack-file packs/example/pack.yaml \
  ./cliharbor-diagnostics.json
```

The destination is explicit and no-clobber. The `cliharbor.diagnostics/v1` document is deterministic for the same runtime state and excludes command stdout/stderr, argv, executable/candidate paths, PATH/environment values, pack source paths, usernames/home paths, browser bootstrap/session/CSRF material, and credential data. CLIHarbor performs no upload or telemetry step.

### Frontend development

Use two terminals:

```bash
# Terminal 1: Vite on loopback
go run ./tools/task web-dev

# Terminal 2: authenticated Go origin proxying to Vite
go run ./cmd/cliharbor serve --web-dev-url http://127.0.0.1:5173
```

Production assets are generated from `web/` and embedded under `internal/webui/static`; do not hand-edit generated assets.

## Build and verification commands

```bash
# Go formatting/static/tests
go fmt ./...
go vet ./...
go test -timeout 2m ./...
go test -race -timeout 2m ./...

# Repository-owned quality workflow
go run ./tools/task check

# Embedded local build
go run ./tools/task go-build

# Windows x64 evaluation candidate
go run ./tools/task windows-eval

# Verify the authoritative evaluation bundle
go run ./tools/task verify-windows-eval

# Rebuild twice in isolated controlled inputs and compare manifests
go run ./tools/task verify-windows-eval-repro
```

CI additionally runs frontend typecheck/lint/tests/build, generated-asset drift checks, module verification, dependency vulnerability scans, the production embedded-browser E2E test, Windows/Linux quality jobs, and the Windows evaluation smoke flow.

## Windows evaluation flow

The evaluation path is intentionally unsigned and evidence-oriented:

```text
windows-eval
    ↓
EVALUATION_SHA256SUMS
    ↓
verify-windows-eval
    ↓
verify-windows-eval-repro
    ↓
self-test / evidence smoke
    ↓
artifact upload
```

`EVALUATION_SHA256SUMS` covers the evaluation executable and trusted Phase 0 pack. The deterministic rebuild gate requires the candidate and two isolated rebuilds to produce the same authoritative manifest under the pinned toolchain and controlled build inputs.

Checksum equality proves byte integrity/determinism under that qualification contract. It is **not** code signing, publisher identity, host attestation, or independent supply-chain provenance.

For the exact managed-laptop procedure, use [Work-Laptop Evaluation](docs/WORK_LAPTOP_EVALUATION.md).

## Repository layout

```text
cmd/cliharbor/             CLI entry point and operator commands
internal/app/              application lifecycle and command wiring
internal/server/           loopback HTTP/session/origin/CSRF boundary
internal/packs/            pack model, loader, schema and semantic validation
internal/discovery/        executable discovery, version probes and identity
internal/planner/          typed input → immutable execution plan
internal/executor/         direct bounded process execution
internal/processcontrol/   platform process-lifecycle ownership
internal/runs/             bounded run state, events and replay
internal/structured/       bounded structured-result parsing
internal/evidence/         Phase 0 evidence export/import/integrity
internal/diagnostics/      allowlisted privacy-preserving support export
internal/webui/            embedded production frontend assets
web/                       React + TypeScript + Vite source
packs/                     synthetic/example and Phase 0 trusted pack sources
schemas/                   embedded pack JSON Schema
tools/task/                repository build/verification/evaluation tasks
test/                      browser E2E support
docs/                      product, architecture, security and operations docs
```

## Current vendor integration gate

The major blocker is factual, not architectural:

> **Real Idira/CyberArk workflow definitions require genuine company-managed Windows Phase 0 evidence.**

The repository already has the safe collection/review boundary. The next vendor milestone is to run the qualified evaluation artifact on the managed laptop, collect reviewed inventory/help/version evidence using only approved fixed probes, then encode the first verified read-only workflow. Until that evidence exists, adding guessed vendor argv would weaken the security model.

## Documentation

| Document | Purpose |
| --- | --- |
| [PRD](docs/PRD.md) | product scope, goals, non-goals, acceptance |
| [Architecture](docs/ARCHITECTURE.md) | component boundaries, state, execution and evaluation model |
| [Security](docs/SECURITY.md) | threat model, controls and explicit trust boundaries |
| [Authentication](docs/AUTHENTICATION.md) | vendor-owned authentication model |
| [Pack specification](docs/PACK_SPEC.md) | declarative pack contract and safety constraints |
| [UX](docs/UX.md) | browser/operator interaction model |
| [Decisions / ADRs](docs/DECISIONS.md) | accepted architecture and security decisions |
| [Development plan](docs/DEVELOPMENT_PLAN.md) | implementation phases and acceptance gates |
| [Test strategy](docs/TEST_STRATEGY.md) | risk-based verification contract |
| [Roadmap](docs/ROADMAP.md) | product stages and current evidence gate |
| [Work-laptop evaluation](docs/WORK_LAPTOP_EVALUATION.md) | exact safe Windows evaluation procedure |
| [Contributing](CONTRIBUTING.md) | repository development workflow |

## Design position

CLIHarbor is intentionally narrower than a terminal emulator, shell wrapper, remote execution service, or credential manager. Its value comes from making known CLI workflows easier to use while preserving a small, inspectable authority boundary.

If a workflow cannot be represented safely as a trusted executable plus validated argv, it does not belong in the generic execution path.
