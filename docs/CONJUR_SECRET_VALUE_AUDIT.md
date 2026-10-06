# Conjur Security Audit

CLIHarbor provides a read-only audit of Conjur secret values using a reference detector or operator-supplied text/pattern criteria. It applies to any configured Conjur backend and account, with no organization-specific scope. The standalone `tools/audit-conjur-secret-values.ps1` remains a reference-only operator audit.

A representative bad value is:

```text
team.app.database/password
```

The audit is intentionally separate from CLIHarbor's browser task authority. CLIHarbor continues to exclude secret-returning browser workflows.

## Run it from CLIHarbor (Windows and macOS)

When the trusted Conjur pack is loaded, open **Tools → Conjur → Security audit** (`/conjur/security-audit`). The previous `/secret-audit` link still works.

1. Sign in on **Authentication** first. The audit reuses the session that the Conjur CLI stored.
2. Enter or confirm the **CyberArk backend URL** and check the account shown. The URL must match your Conjur CLI configuration (a trailing slash is accepted). To use a different backend, configure and authenticate the official Conjur CLI for that backend/account first. CLIHarbor refuses a mismatch before creating a client; editing the audit URL never forwards an existing credential or token to another backend.
3. Choose a **Secret value scan**:
   - **Secret references and paths** preserves the existing detector and its likely/possible reporting threshold;
   - **Contains text** finds a case-sensitive substring;
   - **Exact text** matches the entire value, preserving spaces;
   - **Regular expression** matches a Go regex, for example `^team[./].*/password$` for a path pattern. Add `(?i)` for case-insensitive matching. Lookaround and backreferences are unsupported.
4. Confirm that you're authorized to read every visible variable, then select **Start read-only audit**. Editing the backend or scan criteria resets this acknowledgement. Progress is shown live and the audit can be cancelled. It keeps running if you switch pages.
5. Review matching variable IDs and reasons, copy IDs for a ticket, or download the redacted JSON report. A custom match identifies values meeting your criteria; it does not establish that a secret is insecure.

The browser version extends the Go port of this script ([ADR-028 and ADR-033](DECISIONS.md)). It retains the bounds, reference classifier, drift checks and fail-closed behavior. It reads values in batches through pinned `conjur-api-go`, so it is much faster than one process per variable. Secret values never leave the CLIHarbor backend: the page receives only variable IDs, reason codes and per-variable failure codes. Those codes are `no_value` (no value set), `forbidden` (no execute permission), `output_limit_exceeded`, `retrieval_failed`, and `unsupported_encoding` (not UTF-8 text, left unchecked). A failed or cancelled audit shows no partial results. The 50,000-variable bound is fixed in the browser version; use this script with `-MaxVariables` for larger reference audits.

Custom scan text is limited to 1,024 UTF-8 bytes and rejects control/format/bidi characters. It stays in request/backend memory for the audit, is cleared from the form after start, and never appears in snapshots, errors, logs or downloads. Regex matching uses Go's standard library; no scripts execute. The browser download is schema version 2, adds `scanType`, and uses `matchingVariables` in place of version 1's `suspiciousValues`. It excludes the scan text and secret values. The standalone script's report format is unchanged.

Neither version changes any variable. Fix flagged values through your organization's approved change process; where that allows it, the approval-gated **Set secret value** task stores the corrected value without echoing it (see [Conjur integration](CONJUR_INTEGRATION.md#secret-variable-management)).

## Safety properties

The script:

- uses the already authenticated official Conjur CLI;
- verifies the CLI session before auditing;
- counts visible variables first with `conjur list --kind variable --count --output json` and enforces `-MaxVariables` before enumeration or secret retrieval;
- enumerates only resource-ID strings in bounded pages using explicit `--limit` / `--offset`; it intentionally does not request `--inspect`, so annotations and other resource metadata do not enter the audit process;
- fails closed if paging returns duplicates/count inconsistencies, then re-counts and re-enumerates the complete visible ID set after all value reads so inventory drift does not silently yield a supposedly complete report;
- rejects control/format/bidirectional-spoofing resource-ID characters before rendering or report generation;
- retrieves values one at a time with `conjur variable get --id ... --output json`;
- requires the qualified `{ "value": <string> }` secret JSON shape, limits secret-bearing stdout passed into JSON parsing/classification, and records sanitized failures instead of coercing malformed output;
- performs no variable or policy mutation;
- never intentionally prints secret values;
- never writes secret values to its JSON report;
- reports only variable identifiers, confidence/reason codes, and sanitized retrieval failures;
- keeps secret-bearing command output only in process memory while classifying it.

The process helper drains stdout/stderr asynchronously to avoid child-process pipe deadlocks, so `-MaxSecretOutputChars` is a bound on output retained and processed by the audit after process completion, not a claim that the .NET runtime can prevent every transient allocation while draining the child pipe. Managed runtimes also cannot guarantee immediate erasure of process memory. Run the script only on an approved workstation, and do not enable PowerShell transcription, command tracing, or debugging around the audit.

Variable identifiers are operational metadata and may themselves be sensitive. Protect the optional redacted report accordingly.

## Requirements

- Windows PowerShell 5.1+ or PowerShell 7+.
- CyberArk/Idira Conjur CLI 9.x.
- An already authenticated Conjur session.
- Permission to list and retrieve the variables being audited.

The audit covers **all variables visible to the authenticated identity**. It refuses to enumerate/retrieve values when the pre-count exceeds the default safety bound of 50,000 variables; increase `-MaxVariables` deliberately if a larger full audit is required. Conjur authorization may intentionally hide variables from that identity; those cannot be audited by this session. The script verifies that the visible variable-ID set is unchanged at the end of the run, but Conjur does not provide this client-side audit with transaction/snapshot isolation: an existing variable's value can still change between its individual read and the final inventory check. Run the audit during a stable window or rerun if concurrent secret rotation is expected.

The default inventory page size is 500 (`-ListPageSize`). The default maximum retained stdout for any one secret retrieval is 1 MiB (`-MaxSecretOutputChars`). Both are operator-tunable within explicit bounds.

The script fails closed on a non-9.x CLI unless `-AllowUnsupportedVersion` is supplied after reviewing CLI compatibility.

## Classifier self-test

This does not contact Conjur:

```powershell
.\tools\audit-conjur-secret-values.ps1 -SelfTest
```

The self-test exercises positive/negative classifier cases, resource-ID control/spoof-character rejection, exact count/secret JSON contracts, the Windows PowerShell process-launch path, and retained-output limit behavior.

## Audit all visible variables

When `conjur.exe` is already on `PATH`:

```powershell
.\tools\audit-conjur-secret-values.ps1
```

With an explicit current-user Conjur install:

```powershell
.\tools\audit-conjur-secret-values.ps1 `
  -ConjurPath "$env:USERPROFILE\go\bin\conjur.exe"
```

Do not bypass organizational PowerShell or application-control policy to run this script. If execution is blocked, use the organization's approved script-signing or software-distribution path.

## Write a redacted JSON report

```powershell
.\tools\audit-conjur-secret-values.ps1 `
  -OutputPath .\conjur-secret-value-audit.json
```

The report contains no secret values. By default an existing report is not replaced; use `-Force` only when replacement is intentional.

## Detection model

High-confidence findings:

- the value exactly equals a known Conjur variable resource ID/path;
- slash/backslash notation normalizes to a known variable path;
- normalized dot notation ends in an explicitly credential-like field such as `password` or `token`;
- the value is an explicit `conjur://`, `cyberark://`, or `idira://` secret-reference URI.

Medium-confidence findings:

- a dot-only value normalizes to a known variable path but remains ambiguous with hostname/domain-like data;
- multi-segment dot notation such as `team.app.database/password`;
- path-shaped values ending in fields such as `password`, `token`, `api_key`, or `client_secret`;
- deeply hierarchical path-only values.

The default is `-MinimumConfidence Medium`. Use `-MinimumConfidence High` to report only strong reference matches.

The classifier deliberately ignores common non-reference shapes such as prose/whitespace-bearing values, PEM blocks, JSON-like values, ordinary URLs, connection strings containing `=`, IPv4 addresses, semantic versions, JWT-shaped tokens, and plain hostnames.

These are heuristics, not proof that a secret is wrong. Review every finding in context before changing any Conjur value.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Audit completed; no suspicious values |
| 1 | Fatal setup/session/inventory/report failure |
| 2 | Audit completed; suspicious values found |
| 3 | Audit completed, but one or more variables could not be retrieved, parsed, or safely retained within the output bound |

Exit code 3 takes precedence over 2 because an incomplete audit must not look fully successful.
