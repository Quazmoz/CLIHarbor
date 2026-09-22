# Work-Laptop Evaluation

This is the controlled first CLIHarbor run on a company-managed Windows 10/11 laptop.

The target laptop does **not** need Go, Node/npm, Git, PowerShell, administrator rights, a Windows service, or machine-wide installation. The evaluation executable is unsigned. Do not disable, bypass, or weaken Defender, EDR, AppLocker, WDAC, SmartScreen, proxy policy, browser policy, firewall policy, or another company security control to run it.

Run CLIHarbor from the **currently signed-in user's normal, non-elevated session**. Do not use **Run as administrator** or enter separate Windows administrator credentials merely to make CLIHarbor start or install its managed Conjur fallback.

## 1. Download one qualified artifact

Choose a successful `main` run in the repository CI workflow and download:

```text
cliharbor-windows-x64-evaluation-<commit-sha>
```

The ZIP contains exactly:

```text
EVALUATION_SHA256SUMS
bin/
  cliharbor-windows-x64-evaluation.exe
packs/
  phase0/
    idira-cyberark-inventory.yaml
```

The normal product path does **not** require a separate Conjur pack artifact. The reviewed first-party Conjur pack is compiled into the CLIHarbor executable.

Use Windows **Extract All** or another approved ZIP extractor. Extract into a new, otherwise empty, user-writable directory and preserve the tree exactly. Do not run the executable from inside the ZIP viewer.

## 2. Open normal CMD

Open Command Prompt normally — **not** as administrator:

```bat
cd /d "C:\path\to\extracted\artifact"
```

CLIHarbor does not need to be installed or added to `PATH`.

## 3. Run the self-contained preflight

```bat
bin\cliharbor-windows-x64-evaluation.exe evaluation preflight --bundle "."
```

Preflight is vendor-free and does **not** invoke `idsec` or `conjur`, authenticate, read credential stores, download anything, alter `PATH`, change Windows policy, or modify machine configuration.

It validates the qualified CLIHarbor build identity, exact bundle layout, authoritative checksums, running executable identity, Phase 0 discovery-only pack authority, temporary storage, embedded frontend, IPv4 loopback/session operation, direct child-process mechanics, and the bundle again after runtime checks.

Continue only when the final status is:

```text
READY FOR PHASE 0 INVENTORY
```

Do not continue after `NOT READY FOR PHASE 0 INVENTORY`.

## 4. If application control blocks CLIHarbor

Do **not** disable or evade the control. Retain the exact policy/error evidence and use the organization's approved allowlisting, exception, signing, or software-distribution process.

A policy block is an environmental prerequisite failure, not a reason to weaken CLIHarbor security controls.

## 5. Optional discovery-only Phase 0 inventory

After successful preflight:

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml"
```

This external Phase 0 pack is discovery-only. It contains no vendor command argv, version probe, help probe, authentication operation, or mutation authority. It can identify whether approved `idsec`/`conjur` basenames are absent/ambiguous but cannot execute them.

If an approved executable exists outside `PATH`, an explicit backend path remains available, for example:

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml" --tool-path "idira-cyberark-phase0/conjur=C:\Program Files\Approved Tool\conjur.exe"
```

The browser cannot provide or alter this path.

## 6. Zero-config Conjur readiness check

CLIHarbor's normal first-party pack is embedded. `doctor` loads it without downloading anything:

```bat
bin\cliharbor-windows-x64-evaluation.exe doctor
```

This checks the actual Conjur discovery/version state against the reviewed contract:

```text
>=9.3.1 <10.0.0
```

`doctor` may report exact local filesystem paths. Treat it as local troubleshooting output; do not share it blindly.

## 7. Start the real product path

Normal startup needs no pack arguments:

```bat
bin\cliharbor-windows-x64-evaluation.exe
```

Equivalent:

```bat
bin\cliharbor-windows-x64-evaluation.exe serve
```

CLIHarbor loads the embedded reviewed Conjur pack and runs ordinary tool discovery.

### If a compatible Conjur CLI already exists

CLIHarbor uses it. No vendor binary download is needed.

### If Conjur is genuinely missing

Default `serve` may download the exact reviewed official CyberArk Conjur CLI v9.3.1 Windows x64 binary into the current user's CLIHarbor cache.

Pinned contract:

```text
asset: conjur_windows_amd64.exe
size: 21,950,000 bytes
SHA-256: da2b31ca00b8faaefb8e1fe891563b5cc07c39460e776fb42e7f89b05d3ee4f6
```

The download is HTTPS/origin/size bounded, staged, SHA-256 verified before activation, then verified again. The managed copy is reverified before reuse and still must pass normal Conjur version/discovery/executable-identity checks.

CLIHarbor does not modify machine `PATH`, write `Program Files`, install services/drivers, write machine registry state, or request elevation intentionally.

### If company policy prohibits automatic downloads

Run:

```bat
bin\cliharbor-windows-x64-evaluation.exe serve --no-auto-setup
```

The embedded pack remains active, but a missing Conjur CLI remains unavailable.

Use an approved company installation or explicit path instead of bypassing network/application-control policy.

### If discovery is ambiguous or incompatible

CLIHarbor does **not** auto-replace the corporate state. Review `doctor` and, if appropriate, pin the approved executable:

```bat
bin\cliharbor-windows-x64-evaluation.exe serve --tool-path "cyberark-conjur-v9/conjur=C:\path\to\approved\conjur.exe"
```

An explicit override is authoritative.

## 8. Authentication remains vendor-owned

The real Conjur browser tasks are read-only/non-secret and use `vendor-session`.

CLIHarbor does not ask for or persist:

- passwords;
- MFA values;
- API keys;
- access/refresh tokens;
- Conjur keystore contents.

If a workflow reports that login is required, authenticate through the organization's approved CyberArk/Conjur process, then retry the read operation.

Installing the executable and authenticating to the vendor are separate operations.

## 9. Optional Phase 0 evidence export

Write evidence **outside** the qualified bundle so preflight can be rerun against an unchanged extraction:

```bat
mkdir "..\cliharbor-phase0-evidence"
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml" --export "..\cliharbor-phase0-evidence\phase0-inventory.json"
```

CLIHarbor refuses to overwrite an existing evidence file and prints:

```text
Evidence SHA-256: <64-lowercase-hex-digest>
```

Retain that digest independently if transfer-integrity checking is needed. SHA-256 is not a signature, publisher identity, or host attestation.

Inspect before sharing:

```bat
bin\cliharbor-windows-x64-evaluation.exe evidence inspect --sha256 <retained-digest> "..\cliharbor-phase0-evidence\phase0-inventory.json"
```

Do not routinely share `doctor` output, credentials, environment dumps, browser bootstrap URLs, unrelated company paths, or vendor keystore/profile files.

## 10. Browser/runtime behavior

`serve` binds only to an ephemeral IPv4 loopback address and opens the default browser.

If browser launch fails, CLIHarbor prints a short-lived local bootstrap URL. Open that exact `http://127.0.0.1:<port>/bootstrap?...` URL only in an approved browser and do not share it.

If browser policy blocks loopback HTTP, record that restriction. Do not weaken browser, firewall, proxy, or EDR policy.

Press `Ctrl+C` to stop CLIHarbor cleanly.

## 11. Network behavior

The following require **no external internet from CLIHarbor**:

- `evaluation preflight`;
- Phase 0 discovery-only `inventory`;
- `doctor` against the embedded pack;
- `serve --no-auto-setup` until a vendor command itself needs its normal vendor service.

Default `serve` requires outbound HTTPS to the pinned official GitHub/CyberArk release path **only when Conjur is genuinely missing and automatic setup is enabled**.

A real Conjur read command may also use the network according to the vendor CLI's normal approved configuration.

## 12. Privacy-preserving support diagnostics

For CLIHarbor support metadata:

```bat
bin\cliharbor-windows-x64-evaluation.exe diagnostics export "..\cliharbor-phase0-evidence\cliharbor-diagnostics.json"
```

`cliharbor.diagnostics/v1` is allowlisted metadata. It excludes command output, argv, environment values, executable/candidate paths, pack source paths, browser secrets, credential material and raw managed-download errors. Nothing is uploaded automatically.

## 13. Cleanup

After evaluation:

1. stop CLIHarbor with `Ctrl+C`;
2. close the browser tab;
3. retain/delete evidence according to company policy;
4. delete the extracted evaluation bundle when no longer needed.

If CLIHarbor provisioned its managed Conjur fallback, it may remain under the current user's CLIHarbor cache for reuse. It is not a Windows service or machine-wide installation and is reverified before reuse. Remove it only if company/user policy requires cleanup.

## 14. Scope boundary

The current real Conjur pack is already based on authoritative CyberArk source/release evidence and exposes only reviewed read-only, non-secret workflows.

Managed-device evidence is now primarily a **compatibility and policy qualification** step: confirm the actual endpoint can run CLIHarbor, resolve/execute an approved Conjur binary, reach the vendor service, and reuse an approved vendor session. A mismatch should drive a versioned pack/bootstrap change or enterprise deployment decision—not relaxed validation or guessed commands.
