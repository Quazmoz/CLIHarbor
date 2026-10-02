# Conjur Secret-Value Reference Audit

`tools/audit-conjur-secret-values.ps1` is a **read-only operator audit** for finding Conjur variables whose stored value looks like a secret path/reference instead of the actual secret material.

A representative bad value is:

```text
RH.value.value.value/password
```

The audit is intentionally separate from CLIHarbor's browser task authority. CLIHarbor continues to exclude secret-returning browser workflows.

## Safety properties

The script:

- uses the already authenticated official Conjur CLI;
- verifies the CLI session before auditing;
- enumerates all variables visible to the authenticated identity with `conjur list --kind variable --limit=-1 --output json`;
- retrieves values one at a time with `conjur variable get --id ... --output json`;
- performs no variable or policy mutation;
- never intentionally prints secret values;
- never writes secret values to its JSON report;
- reports only variable identifiers, confidence/reason codes, and sanitized retrieval failures;
- keeps secret-bearing command output only in process memory while classifying it.

Managed runtimes cannot guarantee immediate erasure of process memory. Run the script only on an approved workstation, and do not enable PowerShell transcription, command tracing, or debugging around the audit.

Variable identifiers are operational metadata and may themselves be sensitive. Protect the optional redacted report accordingly.

## Requirements

- Windows PowerShell 5.1+ or PowerShell 7+.
- CyberArk/Idira Conjur CLI 9.x.
- An already authenticated Conjur session.
- Permission to list and retrieve the variables being audited.

The audit covers **all variables visible to the authenticated identity**. It refuses to retrieve values when the visible inventory exceeds the default safety bound of 50,000 variables; increase `-MaxVariables` deliberately if a larger full audit is required. Conjur authorization may intentionally hide variables from that identity; those cannot be audited by this session.

The script fails closed on a non-9.x CLI unless `-AllowUnsupportedVersion` is supplied after reviewing CLI compatibility.

## Classifier self-test

This does not contact Conjur:

```powershell
.\tools\audit-conjur-secret-values.ps1 -SelfTest
```

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
- the value becomes a known variable path after normalizing common dot/slash notation;
- the value is an explicit `conjur://`, `cyberark://`, or `idira://` secret-reference URI.

Medium-confidence findings:

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
| 1 | Fatal setup/session/listing/report failure |
| 2 | Audit completed; suspicious values found |
| 3 | Audit completed, but one or more variables could not be retrieved or parsed |

Exit code 3 takes precedence over 2 because an incomplete audit must not look fully successful.
