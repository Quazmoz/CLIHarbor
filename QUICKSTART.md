# CLIHarbor Quickstart

The normal Windows path is intentionally simple: **download CLIHarbor once, extract it, run preflight, then start CLIHarbor with no pack or Conjur install arguments.** CLIHarbor carries its reviewed Conjur pack inside the executable and can provision the pinned official Conjur CLI for the current user when Conjur is genuinely missing.

For full managed-device evidence and troubleshooting procedures, see [Work-Laptop Evaluation](docs/WORK_LAPTOP_EVALUATION.md).

## Work-laptop quickstart — no admin required

CLIHarbor runs in the **currently signed-in Windows user's context**. It does not require an administrator account, elevation, Windows service, machine-wide installation, registry changes, Go, Node/npm, Git, or PowerShell.

Do **not** use **Run as administrator** merely to launch CLIHarbor. If application control blocks CLIHarbor or a vendor executable, use the organization's approved allowlisting/signing process rather than bypassing the control.

### 1. Download one qualified artifact

1. Open the repository's [CI workflow](https://github.com/Quazmoz/CLIHarbor/actions/workflows/ci.yml).
2. Select a **successful `main` run** for the commit you intend to evaluate.
3. Download `cliharbor-windows-x64-evaluation-<commit-sha>` from **Artifacts**.
4. Record that commit SHA with your test notes.

You do **not** need to download a separate Conjur pack for the normal path. The reviewed first-party Conjur v9 pack is embedded in the CLIHarbor executable.

Do not substitute a copied standalone EXE. The executable, Phase 0 pack, and `EVALUATION_SHA256SUMS` form one qualified evaluation bundle.

### 2. Extract into a user-writable directory

Use Windows **Extract All** or another approved ZIP extractor. A per-user path is appropriate, for example:

```text
%USERPROFILE%\Downloads\CLIHarbor-Eval
```

The extracted root must remain otherwise empty and contain:

```text
EVALUATION_SHA256SUMS
bin\
  cliharbor-windows-x64-evaluation.exe
packs\
  phase0\
    idira-cyberark-inventory.yaml
```

Do not run directly from inside the ZIP and do not add files to this evaluation bundle before preflight.

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

Preflight verifies the qualified CLIHarbor bundle and local runtime. It does not authenticate to Conjur, execute vendor commands, download Conjur, change Windows policy, or modify machine configuration.

### 5. Optional: collect discovery-only Phase 0 inventory

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml"
```

This packaged Phase 0 pack is discovery-only. It cannot execute vendor tasks or login flows.

### 6. Start CLIHarbor

For the normal user path, no pack flags are required:

```bat
bin\cliharbor-windows-x64-evaluation.exe
```

Equivalent explicit form:

```bat
bin\cliharbor-windows-x64-evaluation.exe serve
```

CLIHarbor then:

1. loads its embedded, reviewed Conjur 9.x pack;
2. checks for an already installed compatible `conjur.exe`;
3. uses that existing compatible installation when exactly one valid candidate is available;
4. if Conjur is genuinely missing, downloads the exact reviewed CyberArk Conjur CLI **9.3.1 Windows x64** executable over HTTPS;
5. verifies the pinned byte size and SHA-256 before activation and verifies the activated file again;
6. stores that fallback executable only in the current user's CLIHarbor cache;
7. re-runs normal executable discovery/version validation and opens the local browser UI.

The managed fallback path is under the current user's cache, not `Program Files`, and CLIHarbor does not add it to machine `PATH`.

Pinned upstream fallback:

```text
CyberArk conjur-cli-go v9.3.1
asset: conjur_windows_amd64.exe
SHA-256: da2b31ca00b8faaefb8e1fe891563b5cc07c39460e776fb42e7f89b05d3ee4f6
```

Automatic setup requires outbound HTTPS access to the official GitHub/CyberArk release path **only when a compatible Conjur executable is not already available**.

### 7. Vendor authentication

The Conjur pack exposes reviewed read-only, non-secret workflows and uses `vendor-session` authentication. CLIHarbor does not ask for or persist Conjur passwords, tokens, API keys, or MFA values.

If no valid vendor session exists, authenticate through your organization's approved Conjur/CyberArk process, then retry the workflow in CLIHarbor.

## Locked-down enterprise options

### Disable automatic dependency download

If company policy prohibits application-managed vendor downloads:

```bat
bin\cliharbor-windows-x64-evaluation.exe serve --no-auto-setup
```

CLIHarbor still loads the embedded trusted pack but does not download a missing Conjur executable.

### Pin an approved existing Conjur executable

If Conjur is installed outside normal `PATH`, do not modify machine-wide `PATH`. Use an explicit backend override:

```bat
bin\cliharbor-windows-x64-evaluation.exe serve --tool-path "cyberark-conjur-v9/conjur=C:\Program Files\Approved Tool\conjur.exe"
```

An explicit operator override is authoritative. CLIHarbor will not replace it with the managed fallback.

## What automatic setup never does

CLIHarbor does not:

- request a separate Windows administrator login;
- trigger elevation intentionally;
- install a Windows service, driver, scheduled task, startup item, browser extension, or certificate;
- write `Program Files`;
- add itself or Conjur to machine `PATH`;
- write machine-wide registry/configuration;
- silently replace an ambiguous or incompatible corporate Conjur installation;
- disable or weaken Defender, EDR, AppLocker, WDAC, SmartScreen, firewall, proxy, or browser policy;
- persist vendor passwords, MFA values, tokens, or keystore contents;
- download arbitrary executables or follow an unpinned latest-version URL.

If CLIHarbor itself unexpectedly triggers UAC/admin credentials, cancel the prompt and investigate the policy/launch path.

## Common outcomes

| Result | Action |
| --- | --- |
| Windows/EDR blocks unsigned CLIHarbor | Stop and use approved allowlisting/signing; do not bypass policy |
| Preflight reports `BLOCKED` | Follow remediation; do not continue to vendor execution |
| Compatible Conjur already installed | CLIHarbor uses it; no vendor download is needed |
| Conjur genuinely missing | Default `serve` downloads and verifies the pinned current-user fallback automatically |
| GitHub/vendor download blocked | Use the approved corporate Conjur installation path or rerun with `--no-auto-setup`; do not bypass controls |
| Vendor tool is `ambiguous` | Review local evidence and pin the approved executable with `--tool-path`; CLIHarbor will not guess or auto-replace it |
| Conjur version is incompatible | Do not bypass the version constraint; use/qualify a compatible approved version |
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

Normal product startup uses the embedded first-party pack:

```bash
go run ./cmd/cliharbor serve
```

Add or test another CLI through an explicit declarative pack:

```bash
go run ./cmd/cliharbor pack init --id acme-cli --name "Acme CLI" --tool acme --executable acme ./acme.yaml
go run ./cmd/cliharbor pack validate ./acme.yaml
# Edit only reviewed command/probe/version contracts into acme.yaml.
go run ./cmd/cliharbor doctor --pack-file ./acme.yaml
go run ./cmd/cliharbor serve --pack-file ./acme.yaml
```

Explicit custom packs are additive to the embedded first-party packs. Use `--no-default-packs` for a custom-only runtime:

```bash
go run ./cmd/cliharbor doctor --no-default-packs --pack-file ./acme.yaml
go run ./cmd/cliharbor serve --no-default-packs --pack-dir ./my-packs
```

The generated scaffold is discovery-only: it contains no executable browser commands and no guessed version/help probes.

Build/qualify locally:

```bash
go run ./tools/task go-build
go run ./tools/task windows-eval
go run ./tools/task verify-windows-eval
go run ./tools/task verify-windows-eval-repro
```

Continue with [README](README.md), [Conjur integration](docs/CONJUR_INTEGRATION.md), [Security](docs/SECURITY.md), and [Architecture](docs/ARCHITECTURE.md).
