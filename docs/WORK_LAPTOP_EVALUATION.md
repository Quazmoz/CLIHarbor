# Work-Laptop Evaluation

This procedure is for the first CLIHarbor evaluation on a normal company-managed Windows 10/11 laptop. It is deliberately read-only and does not require administrator rights, an installer, Node/npm/Vite, or Go on the target laptop.

The evaluation executable is **unsigned**. Do not disable or bypass Windows Defender, EDR, AppLocker, WDAC, SmartScreen, proxy policy, browser policy, or any other company security control to run it.

## 1. Obtain the qualified artifact

The CI workflow produces an artifact only after the repository's Windows/Linux quality jobs, dependency vulnerability scan, Go race detector, exact `.go-version` toolchain check, and deterministic two-build Windows evaluation qualification succeed.

Artifact name:

```text
cliharbor-windows-x64-evaluation-<commit-sha>
```

The artifact contains:

```text
EVALUATION_SHA256SUMS
bin/cliharbor-windows-x64-evaluation.exe
packs/phase0/idira-cyberark-inventory.yaml
```

`EVALUATION_SHA256SUMS` is the **only checksum manifest packaged in the Windows evaluation artifact**. It covers both files that define the evaluation execution boundary: the executable and the explicitly trusted Phase 0 pack. `bin/SHA256SUMS` remains a local-build compatibility checksum for `go-build`/`build`; it is deliberately invalidated by `windows-eval` and is not uploaded in the evaluation artifact.

The executable embeds the production React frontend. The work laptop does not need the source tree or frontend tooling.

To build the same Windows x64 evaluation executable from a repository checkout on a development machine, install the exact Go patch release in `.go-version` and run:

```text
go run ./tools/task windows-eval
```

To exercise the deterministic same-checkout rebuild gate locally before using that output:

```text
go run ./tools/task verify-windows-eval-repro
```

The reproduction task verifies the real evaluation candidate, stages two private temporary rebuild bundles, and requires all three authoritative manifests to match; it does not publish or replace the real evaluation artifact.

Expected executable location:

```text
bin/cliharbor-windows-x64-evaluation.exe
```

The build task emits only the root `EVALUATION_SHA256SUMS` for evaluation integrity and removes any stale generated `bin/SHA256SUMS` before building. Evaluation builds report `build: evaluation-unsigned`. Ordinary local `go-build`/`build` commands continue to emit `bin/SHA256SUMS` for local compatibility.

## 2. Copy to a user-writable directory

Use a directory allowed by company policy, for example a user-owned tools directory. Do not request elevation merely for CLIHarbor.

The examples below assume the artifact was extracted with its `bin` and `packs` directories intact.

PowerShell:

```powershell
cd <extracted-artifact-directory>
```

CMD:

```bat
cd /d <extracted-artifact-directory>
```

Paths containing spaces are supported. Quote the path when invoking the executable from another directory.

## 3. Verify the evaluation bundle SHA-256 before running

PowerShell:

```powershell
Get-Content .\EVALUATION_SHA256SUMS
Get-FileHash .\bin\cliharbor-windows-x64-evaluation.exe -Algorithm SHA256
Get-FileHash .\packs\phase0\idira-cyberark-inventory.yaml -Algorithm SHA256
```

CMD:

```bat
type .\EVALUATION_SHA256SUMS
certutil -hashfile .\bin\cliharbor-windows-x64-evaluation.exe SHA256
certutil -hashfile .\packs\phase0\idira-cyberark-inventory.yaml SHA256
```

The root `EVALUATION_SHA256SUMS` must contain exactly these two relative paths:

```text
bin/cliharbor-windows-x64-evaluation.exe
packs/phase0/idira-cyberark-inventory.yaml
```

The computed SHA-256 for **both** files must exactly match the corresponding manifest entry. No `bin/SHA256SUMS` should be present in the qualified evaluation artifact; if one is present, treat the bundle as not matching the qualified packaging contract and do not run it. The GitHub artifact ZIP digest, when retained separately, is distinct archive-level integrity evidence and must not be substituted for either privileged-file checksum.

## 4. Confirm build identity

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe version
```

Expected fields include:

```text
CLIHarbor 0.0.0-eval
commit: <40-character source commit>
build: evaluation-unsigned
go: <Go runtime version>
platform: windows/amd64
```

Record the commit SHA with the evidence returned from the laptop.

## 5. Run the vendor-free self-test

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe self-test
```

The self-test verifies, without touching a vendor CLI:

- user-writable temporary-directory access;
- embedded pack schema and registry loading;
- the bounded structured-output parser;
- the embedded frontend;
- an ephemeral IPv4 loopback listener;
- the one-time bootstrap/session path using an in-process HTTP client with proxy use disabled;
- direct child-process execution by invoking this same CLIHarbor executable's `version` command.

A successful run ends with:

```text
Self-test passed. No vendor CLI, credential store, or external network endpoint was accessed by CLIHarbor.
```

The self-test does not open a browser and does not require an internet connection.

## 6. Run Phase 0 vendor discovery

The supplied Phase 0 pack is intentionally **discovery-only**. It declares only the `idsec` and `conjur` executable basenames already recorded in CLIHarbor's product documentation. It declares no vendor command argv, no version probe, no help probe, no authentication operation, and no mutation.

Run:

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file .\packs\phase0\idira-cyberark-inventory.yaml
```

The sanitized inventory reports:

- Windows version and architecture;
- CLIHarbor version/build identity;
- each declared tool ID;
- status such as `ready`, `missing`, `ambiguous`, `incompatible`, or `probe-failed`;
- parsed version when a trusted version probe is actually declared;
- candidate count and sanitized remediation text.

It does **not** print discovered executable paths or candidate paths.

If discovery is ambiguous or the tool is not on PATH, use `doctor` locally to inspect exact operator-side paths:

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe doctor --pack-file .\packs\phase0\idira-cyberark-inventory.yaml
```

`doctor` is local troubleshooting output and may contain exact filesystem paths. Do not paste `doctor` output into ChatGPT or a ticket without reviewing/redacting it.

If an explicit path is required, the backend-only form is:

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file .\packs\phase0\idira-cyberark-inventory.yaml --tool-path 'idira-cyberark-phase0/idsec=<absolute-path-to-idsec.exe>'
```

The browser cannot supply or alter this path.

## 7. Export the initial sanitized evidence bundle

Even before approved help/version probes are known, export the discovery evidence:

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file .\packs\phase0\idira-cyberark-inventory.yaml --export .\phase0-evidence.json
```

CLIHarbor refuses to overwrite an existing export. Use a new filename for a second capture. On Windows, export stages the complete JSON in the destination directory and activates it with a no-replace move, so the evidence path does not depend on filesystem hard-link support.

The evidence schema is:

```text
cliharbor.phase0/v1
```

The bundle is typed and bounded. When an approved probe runs, its record includes the sanitized fixed argument vector from the trusted pack so the evidence is self-describing; it never includes the resolved executable path. Probes that did not run omit execution timestamps. The bundle intentionally excludes executable paths, candidate paths, raw process environment, PATH dumps, passwords, tokens, MFA values, cookies, browser bootstrap/session/CSRF secrets, vendor credential stores, and unrelated file enumeration.

## 8. Capture approved version/help evidence

Do not guess `--version`, `--help`, command names, or subcommands.

A probe can run only after its exact fixed argv has been added to an explicitly trusted pack. The relevant pack shape is:

```yaml
runtime:
  tools:
    idsec:
      executableNames: [idsec]
      versionProbe:
        args: [<exact-approved-version-argument>]
        parser: semver-text
        timeoutMillis: 3000
      helpProbes:
        root:
          args: [<exact-approved-help-argument>]
          timeoutMillis: 3000
commands: {}
```

The placeholders above are documentation only. Do not run a pack containing guessed placeholders. Populate them only from approved company/vendor documentation or other factual evidence from the exact installed CLI.

Once the trusted pack declares an approved version probe:

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file .\packs\phase0\idira-cyberark-inventory.yaml --probe idira-cyberark-phase0/idsec/version --export .\phase0-idsec-version.json
```

Once it declares the named `root` help probe:

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe inventory --pack-file .\packs\phase0\idira-cyberark-inventory.yaml --probe idira-cyberark-phase0/idsec/root --export .\phase0-idsec-help.json
```

Multiple approved probes may be selected by repeating `--probe`.

Evidence probes:

- launch the already-discovered executable directly, never through PowerShell/CMD/a shell;
- use only pack-declared fixed argv;
- have no interactive stdin;
- run from a temporary neutral working directory;
- receive a minimal environment rather than the full parent environment and run from a neutral temporary working directory;
- use the same bounded platform lifecycle controller as normal execution; on Windows the process and descendants are owned by a Job Object;
- are strictly time/output bounded;
- preserve exit code and separate stdout/stderr;
- revalidate the discovery-time executable fingerprint immediately before launch;
- sanitize invalid UTF-8, unsafe control characters, common secret-bearing assignments, Authorization credentials, JWT-shaped data, the user-home/temp paths, and the resolved executable path before export.

Explicit evidence capture records a non-zero exit, timeout, cancellation, or truncation as evidence rather than rewriting it as success. Discovery-time semantic-version probing is stricter: non-zero exit, timeout, truncation, invalid UTF-8, ambiguous version text, or missing semantic-version text makes the tool fail closed as `probe-failed`.

## 9. Browser/runtime check

To validate the normal browser handoff without running a vendor task:

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe serve
```

CLIHarbor binds only to an ephemeral IPv4 loopback address. It requests the default browser and prints the local runtime URL.

If browser auto-launch is blocked by policy or unavailable, CLIHarbor prints a short-lived URL similar to:

```text
http://127.0.0.1:<port>/bootstrap?token=<one-time-token>
```

Open that exact URL manually in the browser. Treat the bootstrap URL as short-lived sensitive material; do not paste or share it.

Verify that the CLIHarbor UI loads and reports the local runtime. With no packs configured, no vendor task is runnable. Press `Ctrl+C` in the terminal to stop CLIHarbor cleanly.

## 10. What is safe to share

The intended artifact to return for the next integration pass is a reviewed `phase0-*.json` evidence bundle from `inventory --export`.

Before sharing, still inspect the JSON because no generic redactor can prove that arbitrary vendor-generated prose contains no organization-specific data.

Do not share without review:

- `doctor` output;
- the one-time browser bootstrap URL;
- raw terminal output from unrelated vendor login/auth commands;
- credentials, tokens, cookies, MFA values, keystore files, profile files, or environment dumps;
- unrelated corporate filesystem paths or configuration.

## 11. Troubleshooting

### Executable blocked by company policy

The evaluation binary is unsigned. AppLocker, WDAC, SmartScreen, EDR, antivirus, or another application-control policy may block it.

Do not disable or evade the control. Record the policy/error message and use the organization's approved exception, allowlisting, or code-signing process. A company-signed build is a separate release-engineering step and is not claimed by this evaluation artifact.

### PowerShell is restricted

CLIHarbor does not require PowerShell. Run the same executable commands from CMD if company policy permits normal executables. Do not change execution policy for CLIHarbor.

### Tool is missing

`inventory` reports `missing` when no matching declared basename is found across absolute PATH entries. Confirm the CLI is installed through the normal company process. If it is intentionally installed outside PATH, use the explicit CLI-side `--tool-path pack/tool=<absolute-path>` override.

### Tool is ambiguous

`inventory` reports `ambiguous` and a candidate count, but not candidate paths. Run `doctor` locally to see the exact candidates, then rerun `inventory` with one explicit `--tool-path`. CLIHarbor never silently chooses the first candidate.

### Tool version is incompatible or probe failed

Keep the evidence. `incompatible` means the detected semantic version does not satisfy the trusted pack constraint. `probe-failed` means the configured version probe did not produce usable version evidence. Do not loosen constraints or invent a different argv without evidence.

### Browser does not launch

Use the short-lived loopback bootstrap URL printed by CLIHarbor. If company browser policy blocks loopback HTTP entirely, record that as an environment prerequisite; do not weaken browser security controls.

### Loopback cannot bind

CLIHarbor uses `127.0.0.1` with an ephemeral port, so ordinary occupied ports are avoided automatically. If IPv4 loopback itself is disabled or blocked by policy, record the failure. Do not change host firewall/EDR policy merely for this evaluation.

### Corporate proxy or no internet

CLIHarbor's evaluation path is local. The self-test explicitly disables proxy use for its loopback HTTP client. The browser/runtime server is loopback-only. No external network is required by CLIHarbor itself for `version`, `self-test`, or discovery-only `inventory`.

A vendor CLI may have its own startup/network behavior. CLIHarbor does not log in automatically or invoke a vendor command unless an explicit trusted probe is selected.

## 12. Cleanup

1. Stop a running browser session with `Ctrl+C` in the CLIHarbor terminal.
2. Close the browser tab.
3. Delete any Phase 0 JSON bundle after it has been transferred/stored according to company policy.
4. Delete the extracted evaluation artifact directory if the evaluation is complete.

CLIHarbor installs no Windows service, driver, scheduled task, startup item, certificate, browser extension, registry persistence, or machine-wide configuration during this workflow.

## 13. Inspect returned evidence before promotion

After creating an evidence JSON file, retain the `Evidence SHA-256: ...` value printed by the export independently from the JSON. Then validate transfer integrity and review the file using that independently retained value:

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe evidence inspect --sha256 <64-hex-digest-from-export> .\phase0-evidence.json
```

Inspection is read-only and does not load a pack, discover or launch a vendor executable, open a browser, or convert evidence text into command definitions. It prints the artifact/host identity, tool and probe states, bounded quoted output previews, actionable evidence gaps, and explicit PROVES / UNKNOWN / BLOCKED sections.

A successful SHA-256 check proves only that the reviewed bytes match the independently supplied digest. Inspection validates the evidence contract; neither mechanism authenticates who produced the file or attests that the claimed build/host produced it. Keep the artifact in an approved trusted transfer/storage path and retain the CI artifact/build identity alongside it.

To calculate the digest of the currently received file for troubleshooting:

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe evidence checksum .\phase0-evidence.json
```

Do not treat that calculation alone as an independent transfer check; compare against the value retained separately at export time.

Treat the generated timestamp as a point-in-time claim. If the installed CLI or managed laptop changed after capture, collect new evidence rather than treating an older artifact as current. Promotion of a real vendor workflow remains a human-reviewed repository change.


## 14. Export a privacy-preserving support diagnostic bundle

For CLIHarbor-runtime troubleshooting that does **not** require vendor output, create the dedicated support artifact:

```powershell
.\bin\cliharbor-windows-x64-evaluation.exe diagnostics export --pack-file .\packs\phase0\idira-cyberark-inventory.yaml .\cliharbor-diagnostics.json
```

The file uses schema `cliharbor.diagnostics/v1` and is deterministic for the same approved runtime/discovery state. It contains build/host identity, sanitized pack/tool identity and readiness metadata, configuration counts, and aggregate health counts.

It intentionally does **not** contain executable or candidate paths, pack source paths, PATH/environment values, command argv, command stdout/stderr, discovery prose, usernames/home-directory paths, browser bootstrap/session/CSRF material, internal URLs, or vendor credentials. CLIHarbor does not upload the bundle or send telemetry.

The export refuses to overwrite an existing path and prints SHA-256 for the exact JSON bytes. That digest is useful for byte comparison only; it is not code signing, evidence authenticity, or host attestation.

Use this bundle for generic CLIHarbor support before sharing `doctor` output. `doctor` remains operator-local because it can expose exact filesystem paths.
