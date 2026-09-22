# CLIHarbor Quickstart

This is the shortest supported path from download to a safe CLIHarbor run. For full managed-device evidence and troubleshooting procedures, see [Work-Laptop Evaluation](docs/WORK_LAPTOP_EVALUATION.md).

## Choose your path

| Goal | Use |
| --- | --- |
| Evaluate CLIHarbor on a Windows work laptop | Qualified Windows evaluation artifact; no build tools or administrator credentials required |
| Run the real Conjur 9.x pack | Download the separately qualified Conjur pack artifact and load it explicitly after preflight |
| Develop CLIHarbor | Clone the repository and use the pinned Go/Node toolchain |

## Work-laptop quickstart — no admin required

CLIHarbor runs in the **currently signed-in Windows user's context**. The evaluation path does not require an administrator account, elevation, Windows service, machine-wide installation, registry changes, Go, Node/npm, Git, PowerShell or outbound internet access.

Do **not** use **Run as administrator** merely to launch CLIHarbor. If application control blocks the unsigned executable, use the organization's approved allowlisting/signing process rather than bypassing the control.

### 1. Download the qualified artifacts

1. Open the repository's [CI workflow](https://github.com/Quazmoz/CLIHarbor/actions/workflows/ci.yml).
2. Select a **successful `main` run** for the commit you intend to evaluate.
3. Download `cliharbor-windows-x64-evaluation-<commit-sha>` from **Artifacts**.
4. To use the real Conjur integration, also download `cliharbor-conjur-v9-pack-<commit-sha>` from the **same run**.
5. Record that commit SHA with your test notes.

Do not substitute a copied standalone EXE. The executable, Phase 0 pack and `EVALUATION_SHA256SUMS` form one qualified evaluation bundle. The real Conjur pack is intentionally distributed as a separate artifact so it cannot alter the immutable preflight layout.

### 2. Extract into user-writable directories

Use Windows **Extract All** or another approved ZIP extractor. A per-user evaluation path is appropriate, for example:

```text
%USERPROFILE%\Downloads\CLIHarbor-Eval
```

The evaluation root must remain otherwise empty and contain:

```text
EVALUATION_SHA256SUMS
bin\
  cliharbor-windows-x64-evaluation.exe
packs\
  phase0\
    idira-cyberark-inventory.yaml
```

Extract the separate Conjur pack artifact somewhere else, for example:

```text
%USERPROFILE%\Downloads\CLIHarbor-Conjur
  packs\conjur\conjur-v9.yaml
  docs\CONJUR_INTEGRATION.md
```

Do not run the executable directly from inside the ZIP and do not copy the real Conjur pack into the evaluation bundle before preflight.

### 3. Open normal Command Prompt

Open CMD normally — **not** as administrator:

```bat
cd /d "%USERPROFILE%\Downloads\CLIHarbor-Eval"
```

CLIHarbor does not need to be installed or added to `PATH`.

### 4. Run preflight

```bat
bin\cliharbor-windows-x64-evaluation.exe evaluation preflight --bundle "."
```

Continue only when the final status is:

```text
READY FOR PHASE 0 INVENTORY
```

Preflight verifies the qualified bundle and local runtime without authenticating to Conjur, executing vendor commands, changing Windows policy or modifying machine configuration.

### 5. Run discovery-only inventory

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml"
```

This packaged Phase 0 pack is discovery-only. It cannot execute vendor tasks or login flows.

### 6. Test the real Conjur 9.x pack

After preflight succeeds, inspect readiness using the separately extracted trusted pack:

```bat
bin\cliharbor-windows-x64-evaluation.exe doctor --pack-file "%USERPROFILE%\Downloads\CLIHarbor-Conjur\packs\conjur\conjur-v9.yaml"
```

If the discovered `conjur.exe` is compatible, start the browser UI:

```bat
bin\cliharbor-windows-x64-evaluation.exe serve --pack-file "%USERPROFILE%\Downloads\CLIHarbor-Conjur\packs\conjur\conjur-v9.yaml"
```

The trusted pack requires Conjur CLI `>=9.3.1 <10.0.0` and exposes only reviewed read-only, non-secret workflows. It uses the vendor CLI's existing session (`vendor-session`); CLIHarbor does not ask for or persist Conjur passwords, tokens or MFA values.

If no valid stored/vendor session exists, the Conjur client returns a login-required error. Authenticate through your organization's approved vendor-owned process, then retry the read-only workflow.

See [Conjur CLI 9.x Integration](docs/CONJUR_INTEGRATION.md) for exact command provenance and scope.

### 7. If Conjur is outside PATH

Do not alter machine-wide `PATH`. Pin the approved executable at the backend boundary:

```bat
bin\cliharbor-windows-x64-evaluation.exe doctor --pack-file "%USERPROFILE%\Downloads\CLIHarbor-Conjur\packs\conjur\conjur-v9.yaml" --tool-path "cyberark-conjur-v9/conjur=C:\Program Files\Approved Tool\conjur.exe"
```

Use the same reviewed `--tool-path` value when starting `serve`.

CLIHarbor fails closed on ambiguous discovery rather than choosing the first PATH match.

## What current-user execution means

CLIHarbor does not:

- require a separate Windows administrator login;
- install a service, driver, scheduled task, startup item, browser extension or certificate;
- add itself to machine `PATH`;
- write machine-wide configuration;
- disable or weaken Defender, EDR, AppLocker, WDAC, SmartScreen, firewall, proxy or browser policy;
- persist vendor passwords, MFA values, tokens or keystore contents.

If CLIHarbor itself unexpectedly triggers UAC/admin credentials, cancel the prompt and investigate the policy/launch path.

## Common outcomes

| Result | Action |
| --- | --- |
| Windows/EDR blocks unsigned EXE | Stop and use approved allowlisting/signing; do not bypass policy |
| Preflight reports `BLOCKED` | Follow remediation; do not continue to vendor execution |
| Vendor tool is `missing` | Confirm installation through the normal company software process |
| Vendor tool is `ambiguous` | Review local `doctor` output and pin the approved executable with `--tool-path` |
| Conjur version is incompatible | Do not bypass the constraint; qualify/version another pack if the installed CLI contract differs |
| Conjur command reports login required | Authenticate through the approved vendor-owned flow; CLIHarbor does not collect credentials |
| Browser launch fails | Use the printed short-lived loopback URL in an approved browser if company policy permits it |

## Developer quickstart

Pinned toolchain:

- Go **1.27.1**
- Node **24.21.0**
- npm **>=11.6.0 <12**

```bash
git clone https://github.com/Quazmoz/CLIHarbor.git
cd CLIHarbor
npm ci --prefix web
go run ./tools/task check
go run ./cmd/cliharbor self-test
```

Run without a pack:

```bash
go run ./cmd/cliharbor serve
```

Run the verified Conjur pack:

```bash
go run ./cmd/cliharbor doctor --pack-file packs/conjur/conjur-v9.yaml
go run ./cmd/cliharbor serve --pack-file packs/conjur/conjur-v9.yaml
```

Build/qualify locally:

```bash
go run ./tools/task go-build
go run ./tools/task windows-eval
go run ./tools/task verify-windows-eval
go run ./tools/task verify-windows-eval-repro
```

Continue with [README](README.md), [Conjur integration](docs/CONJUR_INTEGRATION.md), [Security](docs/SECURITY.md), and [Architecture](docs/ARCHITECTURE.md).
