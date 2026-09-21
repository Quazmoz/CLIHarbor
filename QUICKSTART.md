# CLIHarbor Quickstart

This guide is the shortest supported path from download to a safe CLIHarbor run.

For the full managed-device procedure, evidence handling, and troubleshooting detail, see [Work-Laptop Evaluation](docs/WORK_LAPTOP_EVALUATION.md).

## Choose your path

| Goal | Use |
| --- | --- |
| Evaluate CLIHarbor on a Windows work laptop | Download the qualified Windows evaluation artifact; no build tools or Windows administrator credentials are required |
| Develop CLIHarbor from source | Clone the repository and use the pinned Go/Node toolchain |

## Work-laptop quickstart — no admin required

CLIHarbor is designed to run in the **currently signed-in Windows user's context**. The Phase 0 evaluation does not require an administrator account, elevation, a Windows service, machine-wide installation, registry changes, Go, Node/npm, Git, PowerShell, or outbound internet access.

Do **not** start CMD with **Run as administrator** just to use CLIHarbor. Do not enter separate Windows administrator credentials to make CLIHarbor run. If Windows application control blocks the unsigned evaluation binary, stop and use your organization's approved allowlisting or signing process instead of bypassing the control.

> Vendor authentication is separate from Windows elevation. A future approved vendor workflow may use authentication owned by the vendor CLI, but CLIHarbor itself must not silently elevate or become a Windows credential store.

### 1. Download the qualified Windows artifact

1. Open the repository's [CI workflow](https://github.com/Quazmoz/CLIHarbor/actions/workflows/ci.yml).
2. Select a **successful** run for the commit you intend to evaluate on `main`.
3. In **Artifacts**, download:
   `cliharbor-windows-x64-evaluation-<commit-sha>`
4. Record the commit SHA with your test notes.

The evaluation artifact is produced only after the repository's prerequisite quality/security/race jobs and the Windows qualification flow succeed. CI artifacts are retained for a limited period, so use the artifact attached to the qualified run rather than an old copied executable.

Do not download only the `.exe` from another source. The executable, trusted Phase 0 pack, and checksum manifest form one qualified bundle.

### 2. Extract it to a user-writable directory

Use Windows **Extract All** or another company-approved ZIP extractor.

A normal per-user location is appropriate, for example:

```text
%USERPROFILE%\Downloads\CLIHarbor-Eval
```

or another company-approved directory that the signed-in user can write without elevation.

Extract into a new, otherwise empty directory. The root should contain exactly:

```text
EVALUATION_SHA256SUMS
bin\
  cliharbor-windows-x64-evaluation.exe
packs\
  phase0\
    idira-cyberark-inventory.yaml
```

Do not run the executable from inside the ZIP viewer, copy the executable away from the bundle, or add unrelated files inside the extracted bundle before preflight.

### 3. Open a normal CMD window

Open **Command Prompt** normally — not **Run as administrator** — and change to the extracted bundle root:

```bat
cd /d "%USERPROFILE%\Downloads\CLIHarbor-Eval"
```

If you extracted elsewhere, substitute that path. Paths containing spaces are supported when quoted.

CLIHarbor does not need to be installed or added to `PATH`.

### 4. Run the self-contained preflight

```bat
bin\cliharbor-windows-x64-evaluation.exe evaluation preflight --bundle "."
```

Continue only if the final status is:

```text
READY FOR PHASE 0 INVENTORY
```

The preflight validates the qualified bundle and local runtime mechanics without invoking `idsec`, `conjur`, authenticating to vendor systems, changing Windows policy, or modifying machine configuration.

If it reports `NOT READY FOR PHASE 0 INVENTORY`, stop there and use the reported remediation.

### 5. Run discovery-only inventory

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml"
```

The packaged Phase 0 pack is intentionally discovery-only. It can locate approved executable basenames but does not contain vendor command argv, login operations, version/help probes, or mutation authority.

A missing vendor CLI is not a reason to install software outside your organization's normal process.

### 6. Optional: open the local browser UI

After preflight succeeds, you may validate the normal local UI:

```bat
bin\cliharbor-windows-x64-evaluation.exe serve
```

CLIHarbor binds to an ephemeral IPv4 loopback address on `127.0.0.1`. It is not a remote service.

If the default browser cannot be opened, CLIHarbor prints a short-lived local bootstrap URL. Open it only in a company-approved browser and do not share it.

Press `Ctrl+C` in the CMD window to stop CLIHarbor.

### 7. If a vendor CLI is installed outside PATH

Do not alter machine-wide `PATH` just for CLIHarbor. Use an explicit backend-only tool path instead:

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml" --tool-path "idira-cyberark-phase0/idsec=C:\Program Files\Approved Tool\idsec.exe"
```

For Conjur:

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml" --tool-path "idira-cyberark-phase0/conjur=C:\Program Files\Approved Tool\conjur.exe"
```

CLIHarbor fails closed on ambiguous executable discovery rather than choosing an arbitrary PATH hit.

## What “runs as the current user” means

CLIHarbor has no privileged helper and does not intentionally request elevation. The local process runs under the Windows account that launched it, and the browser UI talks only to the loopback runtime started by that user.

For the current work-laptop evaluation, CLIHarbor does not:

- require a separate Windows administrator login;
- install a Windows service, driver, scheduled task, startup item, browser extension, or certificate;
- add itself to machine `PATH`;
- write machine-wide configuration;
- disable or weaken Defender, EDR, AppLocker, WDAC, SmartScreen, firewall, proxy, or browser policy;
- persist vendor passwords, MFA values, tokens, cookies, or keystore contents.

If an underlying future vendor command genuinely requires elevation, CLIHarbor should surface that as an explicit environmental/command requirement; it must not silently elevate. Do not solve such a requirement by sharing or embedding administrator credentials.

## Common work-laptop outcomes

| Result | What to do |
| --- | --- |
| Windows/EDR blocks the unsigned EXE | Stop. Record the policy/error and use the approved allowlisting or signing process. Do not bypass the control. |
| Preflight says `BLOCKED` | Follow the reported remediation and do not run inventory yet. |
| Inventory says tool `missing` | Confirm installation through the normal company software process. |
| Inventory says tool `ambiguous` | Use local `doctor` output to identify the approved binary, then rerun with `--tool-path`. Do not share unredacted `doctor` output casually. |
| Browser launch fails | Use the printed short-lived loopback bootstrap URL in an approved browser, if company policy permits loopback HTTP. |
| A UAC/admin credential prompt appears unexpectedly for CLIHarbor itself | Cancel it and investigate the policy/launch path; CLIHarbor's evaluation path is intended to run without elevation. |

## Developer quickstart

The source-development path is separate from the work-laptop artifact path.

Pinned toolchain:

- Go **1.27.1** from [`.go-version`](.go-version)
- Node **24.21.0** from [`.node-version`](.node-version)
- npm **>=11.6.0 <12** from `web/package.json`

Clone and validate:

```bash
git clone https://github.com/Quazmoz/CLIHarbor.git
cd CLIHarbor
npm ci --prefix web
go run ./tools/task check
go run ./cmd/cliharbor self-test
```

Start the embedded application:

```bash
go run ./cmd/cliharbor serve
```

Build a local embedded executable:

```bash
go run ./tools/task go-build
```

Create and verify the Windows x64 evaluation candidate:

```bash
go run ./tools/task windows-eval
go run ./tools/task verify-windows-eval
go run ./tools/task verify-windows-eval-repro
```

For repository architecture, security invariants, and development workflow, continue with [README](README.md), [Architecture](docs/ARCHITECTURE.md), [Security](docs/SECURITY.md), and [Contributing](CONTRIBUTING.md).
