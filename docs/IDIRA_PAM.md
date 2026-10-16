# Idira PAM — Reviewed read-only integration (candidate)

> **Status: implementation staged for qualification.** This page describes the
> `cyberark-idira-pam` first-party pack; it is not proof of corporate-tenant
> acceptance. Do not distribute a CLIHarbor binary from this branch until
> repository qualification has succeeded.

## Upstream contract and scope

Reviewed CyberArk `idsec-cli-golang` **v0.13.0** (release 2026-10-11,
commit `9ff4c786acd9d68c9c2e127e530f76d16ff9824c`) against
`idsec-sdk-golang` **v0.13.0**. Commands are executed only by CyberArk
`idsec`, not by a new PAM REST client.

Official sources:
- https://github.com/cyberark/idsec-cli-golang/releases/tag/v0.13.0
- https://github.com/cyberark/idsec-cli-golang/blob/v0.13.0/docs/commands/status.md
- https://github.com/cyberark/idsec-cli-golang/blob/v0.13.0/docs/commands/exec.md
- https://github.com/cyberark/idsec-cli-golang/blob/v0.13.0/docs/commands/login.md
- https://github.com/cyberark/idsec-cli-golang/blob/v0.13.0/docs/commands/configure.md
- https://github.com/cyberark/idsec-sdk-golang/blob/v0.13.0/pkg/services/pcloud/accounts/actions/idsec_pcloud_accounts_actions_schemas.go
- https://github.com/cyberark/idsec-sdk-golang/blob/v0.13.0/pkg/services/pcloud/safes/actions/idsec_pcloud_safes_actions_schemas.go

Supported reviewed CLI version range: `>=0.13.0-0 <0.14.0-0`.
The version probe is `idsec version --silent`. The initial pass only
discovers **approved existing** installations; no automatic Idsec download,
update, installation, or privileged installer is available. The upstream
Windows AMD64 release archive has SHA-256
`63acc91181651d50b2e4ec58d60ca0b2183bc40931c4f786efd5c266520ac9e0`;
that **archive** hash is not the extracted executable hash, publisher
validation, or your organization's approval.

### Enabled exact operations

| Task | Vendor invocation | Browser output |
| --- | --- | --- |
| Local version | `idsec version --silent` | local CLI semver |
| Local profile status | `idsec status --query '{profile: .profile, exists: .exists, authenticated: .authenticated}'` | only name and booleans |
| Safe inventory | `idsec pcloud safes list-by --limit N --offset O [--search Q] --query '[.[] \| {safe_id: .safe_id, safe_name: .safe_name}]'` | only Safe ID/name |
| Account inventory | `idsec pcloud accounts list-by --limit N --offset O [--search Q] [--safe-name S] --query '[.[] \| {account_id: .account_id, name: .name, safe_name: .safe_name, platform_id: (.platform_id // "")}]'` | only account ID/name, Safe name, platform ID |

`N` is 1–50; `O` is 0–100000. Browser values are validated typed
inputs and become fixed argv flags, never a shell string or jq program.
Optional filters are restricted to short, plain-text values. All list and
status requests rely on the vendor's existing session.

The CLI `--query` reduces source output, and a second backend-only guard
independently checks the **complete** result before any data event is
retained or sent to the browser. It rejects unknown fields, duplicates,
malformed/oversized JSON, unexpected types, control characters, malformed
escaped Unicode (including unpaired surrogates), missing fields, and more than
50 rows. Both raw stdout and raw stderr are
quarantined; a failed CLI process emits only result metadata, never raw
vendor errors or partial output. The backend does **not** expose account
properties, usernames, addresses, password values, credential retrieval,
Safe member details, approval tickets, or arbitrary raw output.

Explicit local packs may not reuse `cyberark-idira-pam` or any other
embedded first-party pack ID, including when built-in packs are disabled.
An operator-selected custom CLI must use its own unique ID.

No CLIHarbor password, MFA, or token entry exists in this integration.
Generic run history may retain only the allowlisted output and metadata.

## Windows work-laptop test (non-elevated, explicitly authorized)

1. **Before testing:** get employer approval for the CLIHarbor evaluation
   executable, the `idsec.exe` you intend to invoke, and read-only tenant
   access. Use your already provisioned Windows user identity. Do not
   disable EDR, Application Control, TLS validation, certificates or proxy.
2. Obtain a separately qualified CLIHarbor evaluation bundle built from the
   exact commit being tested; verify its published manifest/checksums using
   `docs/WORK_LAPTOP_EVALUATION.md`. Do **not** treat a random branch build
   as a production binary.
3. Open normal non-administrator CMD. Confirm that the organization-approved
   `idsec.exe` is the one you expect:
   `where idsec` and `idsec version --silent`. Multiple paths require
   resolving ambiguity rather than using whichever happens to be first.
4. Configure Idsec in the **vendor terminal** if not configured:
   `idsec configure`. The current workspace uses the Idsec **default**
   profile (`idsec`). For this milestone, explicitly select/configure
   that default profile; do not assume CLIHarbor switches profiles.
5. Check local status, without printing tokens:
   `idsec status --quiet`. Return codes: 0 authenticated; 2 missing
   profile; 3 no authenticators; 4 no session; 5 expired session.
6. If needed, perform vendor-owned interactive sign-in in that CMD using
   `idsec login`. Handle MFA only in the official vendor flow. **Never**
   use `--show-tokens`, `--query` on `login`, secret flags, or credential
   exports. Re-run `idsec status --quiet` after sign-in.
7. From the **qualified** extracted CLIHarbor bundle, launch normal user
   CMD: `bin\cliharbor-windows-x64-evaluation.exe serve --no-auto-setup`.
   The exact executable name may differ by verified distribution. If
   discovery cannot select one exact approved `idsec.exe`, restart with
   `--tool-path "cyberark-idira-pam/idsec=C:\Approved\Path\idsec.exe"`,
   using the real authorized absolute path.
8. In **Built-in CLIs → Idira PAM**, review discovery, then choose
   **Browse approved tasks** and open **Check PAM session**. Only a
   successful explicit result with `authenticated: true` establishes
   vendor-session readiness. Executable discovery alone is not proof of authentication.
9. From the shared **Tasks** workspace, open **Browse Safes**, enter
   `limit=25`, `offset=0`, review the exact preview, then run. Confirm that
   only Safe IDs/names appear. Repeat with `offset=25` if authorized.
10. Open **Browse accounts (metadata only)** in the shared task browser,
    supply `limit=25` and `offset=0`, optionally restrict by Safe, then
    preview and run. Check that only account ID/name, Safe name and platform
    ID appear. Compare an authorized subset with the vendor console.
    No credential retrieval is required or approved.
11. Test the expected error states: missing Idsec, incompatible version,
    expired session, missing authorization, unreachable corporate proxy,
    and a cancelled inventory read. CLIHarbor must show safe status or
    failure metadata without vendor stderr or token material.
12. For diagnostics, use CLIHarbor's sanitized diagnostics export described
    in `docs/WORK_LAPTOP_EVALUATION.md`. Share only the reviewed export;
    never share `idsec login` output, full profile files, terminal transcript,
    browser bootstrap URL, `doctor` raw paths, or credential caches.
13. Close the local CLIHarbor browser tab and stop its CMD process normally.
    No CLIHarbor-owned vendor sessions or authentication tokens should
    need cleanup.

## Remaining live acceptance gates

This milestone can be unit-/fixture-tested without a CyberArk tenant, but
those results do not validate actual tenant permissions, CLI stdout
compatibility, Idsec profile selection under enterprise policy, TLS proxy
trust, token expiry during a read, or device/application-control approval.
For these, record the CLI version, sanitized pass/fail, and whether the
result matched the explicitly expected non-secret schema. Unknown upstream
responses must fail closed and trigger a reviewed pack/guard update, not a
relaxed parser or unsafe raw-output override.

## Next capability milestone

After native Windows and actual Privilege Cloud acceptance, assess
metadata-only Safe/account detail and platform inventory. Mutating Safe and
account lifecycle tasks require separate versioned upstream contracts,
precise context binding and approval/audit analysis. Secret retrieval and
unauthorized privilege elevation remain out of scope.
