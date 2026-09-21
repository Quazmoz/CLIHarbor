# Work-Laptop Evaluation

This is the controlled first CLIHarbor run on a company-managed Windows 10/11 laptop. It is intentionally read-only and vendor-free until the explicit Phase 0 `inventory` step.

The target laptop does **not** need Go, Node/npm, Git, PowerShell, administrator rights, or external internet access. The evaluation executable is unsigned. Do not disable, bypass, or weaken Windows Defender, EDR, AppLocker, WDAC, SmartScreen, proxy policy, browser policy, firewall policy, or any other company security control to run it.

Run CLIHarbor from the **currently signed-in user's normal, non-elevated session**. Do not use **Run as administrator** or enter separate Windows administrator credentials just to make CLIHarbor start. CLIHarbor has no privileged helper and must not silently elevate. If CLIHarbor itself unexpectedly triggers a UAC/admin-credential prompt, cancel it and investigate the launch or enterprise-policy path instead of supplying administrator credentials.

## 1. Obtain and extract the exact qualified artifact

GitHub Actions uploads one artifact only after the repository quality, security, race, deterministic rebuild, evaluation-integrity, vendor-free runtime, Phase 0 evidence, and evaluation-preflight gates succeed.

Artifact name:

```text
cliharbor-windows-x64-evaluation-<commit-sha>
```

The ZIP contains exactly this evaluated layout:

```text
EVALUATION_SHA256SUMS
bin/
  cliharbor-windows-x64-evaluation.exe
packs/
  phase0/
    idira-cyberark-inventory.yaml
```

`EVALUATION_SHA256SUMS` is the only checksum manifest in the qualified evaluation bundle. It covers the executable and the Phase 0 pack. A GitHub artifact ZIP digest, if retained separately, is archive-level evidence and does not replace the internal manifest.

Use Windows **Extract All** or another company-approved ZIP extractor. Do not run the executable from inside a ZIP viewer. Extract into a new, otherwise empty, user-writable directory and preserve the directory tree exactly. The built-in preflight deliberately rejects missing, unexpected, case-conflicting, symlink/reparse-point, or otherwise non-canonical bundle entries.

If the chosen extraction path contains spaces, that is supported.

## 2. Open a normal, non-elevated CMD in the extracted bundle root

PowerShell is not required. Open Command Prompt normally — **not** with **Run as administrator**. These instructions use CMD so they also work where PowerShell is restricted.

```bat
cd /d "C:\path\to\extracted\artifact"
```

The current directory must contain `EVALUATION_SHA256SUMS`, `bin`, and `packs` as shown above. CLIHarbor does not need to be added to `PATH`; invoke the exact packaged executable by relative path.

## 3. Run the self-contained evaluation preflight

From the extracted bundle root:

```bat
bin\cliharbor-windows-x64-evaluation.exe evaluation preflight --bundle "."
```

The preflight is the primary laptop-readiness gate. It does **not** invoke `idsec`, `conjur`, or any other discovered vendor executable. It does not authenticate, read credential stores, enumerate secrets, change `PATH`, alter Windows policy, invoke PowerShell/CMD as a child shell, download anything, or modify machine configuration.

It validates:

- CLIHarbor version, full source commit, evaluation build mode, Windows OS, and amd64 architecture;
- the exact extracted bundle layout;
- the authoritative `EVALUATION_SHA256SUMS` manifest and its exact two permitted entries;
- SHA-256 of the packaged executable and Phase 0 pack;
- that the running process is the executable covered by this bundle;
- the packaged Phase 0 pack ID/version and discovery-only authority;
- exactly the declared `idsec` and `conjur` executable basenames;
- zero vendor commands, version probes, help probes, or version constraints;
- writable temporary storage;
- embedded frontend initialization and IPv4 loopback/session operation;
- direct child-process mechanics by invoking CLIHarbor's own `version` command;
- the bundle again after runtime checks, so an observed mid-preflight replacement fails closed.

Output uses deterministic status labels:

```text
[PASS]
[WARNING]
[BLOCKED]
```

A successful run ends with:

```text
READY FOR PHASE 0 INVENTORY
```

A blocked run ends with:

```text
NOT READY FOR PHASE 0 INVENTORY
```

Do not continue to Phase 0 inventory after a blocked preflight.

The normal successful preflight includes a warning that a default-browser launch was not attempted. The embedded production frontend and loopback session are tested without opening a browser; default-browser policy is checked separately only if you later run `serve`.

### Running preflight from another working directory

Prefer working from the bundle root. If that is not practical, quote the absolute bundle path and invoke the executable by its exact absolute path, for example:

```bat
"C:\CLI Harbor Eval\bin\cliharbor-windows-x64-evaluation.exe" evaluation preflight --bundle "C:\CLI Harbor Eval"
```

Do not copy only the `.exe` elsewhere and run preflight from the copy. The running executable must be the one covered by the bundle manifest.

## 4. If Windows application control blocks the executable

The evaluation executable is unsigned. SmartScreen, AppLocker, WDAC, EDR, antivirus, or another enterprise control may prevent it from starting or may block its self-process check.

Do **not** disable or evade the control. Stop the evaluation, retain the exact policy/error message, and use the organization's approved allowlisting, exception, or code-signing process. A company-signed build is a separate release-engineering step and is not claimed by this artifact.

A policy block is an environmental prerequisite failure, not a reason to loosen CLIHarbor security controls.

## 5. Run the discovery-only Phase 0 inventory

Only after preflight reports `READY FOR PHASE 0 INVENTORY`, run:

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml"
```

The supplied pack is intentionally discovery-only. It contains no vendor command argv, version probe, help probe, authentication operation, or mutation authority. The inventory step may discover executable candidates by their approved basenames, but it does not execute a vendor CLI because the packaged Phase 0 pack grants no probe or task authority.

The sanitized inventory reports build/host identity, each tool ID, discovery state, candidate count, and safe remediation. Exact executable/candidate paths are intentionally omitted from shareable inventory output.

Expected discovery states include `ready`, `missing`, `ambiguous`, `incompatible`, and `probe-failed`. With the current packaged pack, no version probe is configured, so no vendor version command is guessed or launched.

## 6. Missing, ambiguous, or out-of-PATH vendor CLIs

### Tool is missing

If `inventory` reports `missing`, confirm the vendor CLI is installed through the normal company process. Do not download or install a vendor CLI merely to satisfy CLIHarbor unless that is already approved.

If the approved executable exists outside `PATH`, provide an explicit backend-only path. Quote the complete `pack/tool=path` argument when the path may contain spaces:

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml" --tool-path "idira-cyberark-phase0/idsec=C:\Program Files\Approved Tool\idsec.exe"
```

For `conjur`, use the corresponding tool identity:

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml" --tool-path "idira-cyberark-phase0/conjur=C:\Program Files\Approved Tool\conjur.exe"
```

The browser cannot provide or alter these paths.

### Tool is ambiguous

CLIHarbor fails closed when multiple candidates match. It never silently selects the first `PATH` hit. If local troubleshooting is necessary, run:

```bat
bin\cliharbor-windows-x64-evaluation.exe doctor --pack-file "packs\phase0\idira-cyberark-inventory.yaml"
```

`doctor` may contain exact local filesystem paths. Review it locally and do not paste it into ChatGPT, a ticket, or another system without appropriate redaction. After identifying the approved executable, rerun `inventory` with the explicit `--tool-path` form above.

## 7. Export Phase 0 evidence outside the qualified bundle

The preflight treats the extracted bundle as immutable qualified input. Therefore, write evidence **outside** the bundle directory. Do not create evidence, diagnostics, notes, screenshots, or other files inside the extracted artifact if you expect to rerun preflight on the same extraction.

Create a sibling evidence directory:

```bat
mkdir "..\cliharbor-phase0-evidence"
```

Then export discovery evidence:

```bat
bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file "packs\phase0\idira-cyberark-inventory.yaml" --export "..\cliharbor-phase0-evidence\phase0-inventory.json"
```

If you needed an explicit tool path, include the same reviewed `--tool-path` argument on the export command.

CLIHarbor refuses to overwrite an existing evidence file. If `phase0-inventory.json` already exists, choose a new filename rather than deleting or replacing it as part of the same capture, for example:

```text
phase0-inventory-2.json
```

The export prints:

```text
Evidence SHA-256: <64-lowercase-hex-digest>
```

Retain that digest independently from the JSON in an approved note, ticket field, password-manager note, or other company-approved location. The digest proves byte equality when later compared; it is not a signature, publisher identity, or host attestation.

## 8. Inspect evidence before sharing it

Use the independently retained digest:

```bat
bin\cliharbor-windows-x64-evaluation.exe evidence inspect --sha256 <retained-64-hex-digest> "..\cliharbor-phase0-evidence\phase0-inventory.json"
```

Inspection is read-only. It does not load a pack, discover or launch a vendor executable, open a browser, or convert evidence text into executable command authority.

For troubleshooting only, this command computes the digest of the currently received file:

```bat
bin\cliharbor-windows-x64-evaluation.exe evidence checksum "..\cliharbor-phase0-evidence\phase0-inventory.json"
```

Do not treat a digest calculated only after receipt as independent transfer evidence; compare against the value retained separately at export time.

Even after successful inspection, review the JSON before sharing. No generic redactor can prove that arbitrary future vendor-generated prose is free of organization-specific information.

## 9. Exactly what to return for engineering review

For the initial discovery-only Phase 0 run, return:

1. the reviewed `phase0-inventory.json` file; and
2. the independently retained `Evidence SHA-256` value through the approved communication channel.

Also record the evaluation artifact name/commit SHA used. The JSON already includes CLIHarbor build/host identity, but retaining the CI artifact identity separately makes the handoff easier to audit.

Do **not** routinely return:

- `doctor` output;
- the evaluation executable or trusted pack;
- the one-time browser bootstrap URL;
- vendor credential/profile/keystore files;
- passwords, tokens, cookies, MFA values, environment dumps, or unrelated company paths;
- raw output from unrelated vendor commands.

If CLIHarbor itself needs troubleshooting, engineering may request the privacy-preserving diagnostics bundle described below. Do not substitute broad filesystem/log collection.

## 10. Optional browser/runtime check

Preflight already verifies the embedded frontend and loopback session without opening a browser. If you also want to validate the normal browser handoff, run:

```bat
bin\cliharbor-windows-x64-evaluation.exe serve
```

CLIHarbor binds only to an ephemeral IPv4 loopback address.

If the default browser launch is blocked or unavailable, CLIHarbor prints a short-lived `http://127.0.0.1:<port>/bootstrap?...` URL. Open that exact local URL manually only in a company-approved browser. Treat the bootstrap URL as short-lived sensitive material; do not paste or share it.

If browser policy blocks loopback HTTP, record that environmental restriction and stop the browser check. Do not weaken browser, firewall, proxy, or EDR policy.

Press `Ctrl+C` in the terminal to stop CLIHarbor cleanly.

## 11. No-internet and proxy environments

The evaluation preflight and discovery-only Phase 0 flow require no external network access from CLIHarbor. The loopback self-test explicitly disables proxy use for its in-process HTTP client. No downloads occur.

A future approved vendor command may have its own network behavior. The current packaged Phase 0 pack does not grant that execution authority.

## 12. Optional privacy-preserving support diagnostics

For CLIHarbor runtime/discovery troubleshooting, export diagnostics outside the qualified bundle:

```bat
bin\cliharbor-windows-x64-evaluation.exe diagnostics export --pack-file "packs\phase0\idira-cyberark-inventory.yaml" "..\cliharbor-phase0-evidence\cliharbor-diagnostics.json"
```

`cliharbor.diagnostics/v1` is allowlisted metadata. It intentionally excludes command output, argv, environment values, executable/candidate paths, pack source paths, browser secrets, and credential material. It is no-clobber and is not uploaded automatically.

Share this only when engineering requests it.

## 13. Manual checksum commands are troubleshooting aids, not the primary gate

The built-in preflight already parses the authoritative manifest and hashes both privileged files. If you need an independent local troubleshooting view and company policy permits the tools, CMD can use:

```bat
type EVALUATION_SHA256SUMS
certutil -hashfile bin\cliharbor-windows-x64-evaluation.exe SHA256
certutil -hashfile packs\phase0\idira-cyberark-inventory.yaml SHA256
```

PowerShell equivalents are optional:

```powershell
Get-Content .\EVALUATION_SHA256SUMS
Get-FileHash .\bin\cliharbor-windows-x64-evaluation.exe -Algorithm SHA256
Get-FileHash .\packs\phase0\idira-cyberark-inventory.yaml -Algorithm SHA256
```

Do not substitute the ZIP digest for `EVALUATION_SHA256SUMS`, and do not treat either checksum surface as code signing or publisher attestation.

## 14. Cleanup

After the approved evaluation and evidence transfer are complete:

1. stop any running CLIHarbor browser session with `Ctrl+C`;
2. close the browser tab;
3. retain or delete Phase 0 JSON evidence according to company policy;
4. delete the extracted evaluation bundle when no longer needed.

CLIHarbor installs no Windows service, driver, scheduled task, startup item, certificate, browser extension, registry persistence, or machine-wide configuration during this workflow.

## 15. Scope boundary after Phase 0

Do not add or infer real Idira/CyberArk commands from filenames, discovery state, captured prose, memory, or guesses.

The next engineering milestone begins only after the genuine company-managed Windows evidence has been returned, checksum-verified, inspected, and human-reviewed. Only facts supported by that evidence or approved vendor/company documentation may be promoted into a real trusted pack.
