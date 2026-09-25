# Conjur CLI 9.x Integration

## Status

CLIHarbor includes a real, version-gated read-only integration for the official CyberArk / Idira Secrets Manager Conjur CLI.

The reviewed source pack remains in the repository at:

```text
packs/conjur/conjur-v9.yaml
```

For normal `serve` startup, the same trusted pack bytes are **embedded in the CLIHarbor executable**. Users do not need to download, copy, or select a separate pack.

The implementation is derived from the official upstream `cyberark/conjur-cli-go` v9.3.1 release and source, not from remembered or guessed CLI syntax.

**Upstream qualification baseline:**

- repository: `cyberark/conjur-cli-go`
- release: `v9.3.1`
- upstream commit: `7207d6a4a2005130978e10d03d7f6b55ab0216d6`
- CLIHarbor compatibility constraint: `>=9.3.1-0 <10.0.0-0`

CyberArk release binaries render the reviewed release as `9.3.1-<commit>`. That commit suffix is syntactically a SemVer prerelease identifier even though it identifies the released binary, so the constraint uses `-0` bounds to admit those official 9.x release strings while still excluding 10.x.

## Zero-config startup

Normal Windows startup is:

```bat
cliharbor-windows-x64-evaluation.exe
```

or explicitly:

```bat
cliharbor-windows-x64-evaluation.exe serve
```

With no `--pack-file` or `--pack-dir`, CLIHarbor:

1. loads the embedded first-party Conjur pack through the same hardened pack loader used for other trusted sources;
2. performs normal executable discovery and version qualification;
3. uses an already installed compatible Conjur executable when one unambiguous candidate exists;
4. only when the trusted Conjur tool state is exactly `missing`, attempts current-user bootstrap of the reviewed official Conjur binary;
5. re-runs normal discovery/version probing against the provisioned executable before any browser task can use it.

Automatic setup does **not** run for ambiguous, incompatible, probe-failed, identity-failed, unsupported-platform, or explicit-invalid-override states. Those conditions remain fail-closed and require operator review.

Supplying an explicit local pack also retains the advanced/operator behavior and does not trigger first-party default-pack provisioning.

## Pinned Windows fallback binary

CyberArk's official v9.3.1 GitHub release publishes a standalone Windows amd64 executable suitable for a non-admin per-user fallback:

```text
asset: conjur_windows_amd64.exe
size: 21,950,000 bytes
SHA-256: da2b31ca00b8faaefb8e1fe891563b5cc07c39460e776fb42e7f89b05d3ee4f6
```

CLIHarbor does not use a mutable `latest` URL. The release version, URL, expected size, and digest are compiled into the reviewed bootstrap implementation.

When needed, the binary is downloaded over HTTPS into a staging file, bounded before activation, verified by SHA-256, synced, then activated under the current user's CLIHarbor cache. The activated file is verified again before CLIHarbor returns it to normal discovery as a backend-only tool override.

The normal Windows location is equivalent to:

```text
%LOCALAPPDATA%\CLIHarbor\tools\conjur\9.3.1\conjur.exe
```

(the exact root is resolved with the operating system's current-user cache directory API).

CLIHarbor does not add this path to machine `PATH` and does not write `Program Files`, Windows services, drivers, certificates, scheduled tasks, startup entries, or machine-wide registry/configuration.

### Enterprise opt-out

If application-managed dependency downloads are prohibited:

```bat
cliharbor-windows-x64-evaluation.exe serve --no-auto-setup
```

The embedded pack is still loaded; a missing vendor tool simply remains unavailable.

An approved existing installation can always be pinned explicitly:

```text
--tool-path cyberark-conjur-v9/conjur=C:\path\to\approved\conjur.exe
```

Explicit operator selection remains authoritative and is never silently replaced by the managed fallback.

## Authoritative upstream evidence

The pack was derived from these official upstream surfaces:

- [`cyberark/conjur-cli-go`](https://github.com/cyberark/conjur-cli-go) — certified Conjur/Idira CLI source repository;
- [`v9.3.1`](https://github.com/cyberark/conjur-cli-go/releases/tag/v9.3.1) — release tied to the qualified upstream commit and containing the pinned Windows executable/digest;
- `pkg/cmd/list.go` — list filters and output behavior;
- `pkg/cmd/resource.go` — resource exists/show/permitted-roles commands;
- `pkg/cmd/role.go` — role exists/show/members/memberships commands;
- `pkg/cmd/whoami.go` — authenticated identity query;
- `pkg/clients/clients.go` — vendor-owned authentication/config/session behavior;
- checked-in `vhs/golden/*` command captures — root and command help/output behavior.

The trusted pack records fixed `--help` evidence probes for the root, `list`, `resource`, `role`, and `whoami` surfaces so an operator can capture exact deployed help text without granting arbitrary probe argv.

## Implemented browser workflows

The current pack exposes only commands that are both documented and inside CLIHarbor's current read-only/non-secret execution envelope:

| CLIHarbor command | Conjur argv shape | Notes |
| --- | --- | --- |
| `whoami` | `conjur whoami --output json` | Current authenticated identity |
| `list-resources` | `conjur list [approved flags] --output json` | Kind/search/limit/offset/role/inspect/count filters |
| `resource-exists` | `conjur resource exists <resource-id> --output json` | Structured boolean card |
| `resource-show` | `conjur resource show <resource-id> --output json` | Resource metadata |
| `resource-permitted-roles` | `conjur resource permitted-roles <resource-id> <privilege> --output json` | Permission relationship query |
| `role-exists` | `conjur role exists <role-id> --output json` | Structured boolean card |
| `role-show` | `conjur role show <role-id> --output json` | Role metadata |
| `role-members` | `conjur role members <role-id> [--verbose] --output json` | Member list/details |
| `role-memberships` | `conjur role memberships <role-id> --output json` | Parent-role memberships |

All user-controlled positional identifiers are represented by CLIHarbor's constrained positional primitive: one validated scalar becomes exactly one argv element. CLIHarbor does not split it, template it, reinterpret it as a shell command, or allow a leading `-` that could become an undeclared flag.

## Authentication model

These commands require a Conjur session, but CLIHarbor does **not** collect Conjur credentials.

The pack declares:

```yaml
requirements:
  requiresAuth: true
  authMode: vendor-session
```

`vendor-session` means:

- execution may use the vendor CLI's existing config/session/keystore behavior;
- CLIHarbor supplies no password, token, API key, MFA response, or interactive stdin;
- if the vendor CLI cannot use an existing session, the command fails and the operator authenticates through the approved vendor-owned flow;
- generic `requiresAuth: true` commands without this explicit mode remain blocked and are not surfaced in the browser.

Downloading the Conjur executable does not configure a Conjur appliance/account, authenticate a user, or create vendor credentials.

## Commands intentionally not exposed

The upstream CLI contains more functionality than CLIHarbor currently grants browser authority to use.

### Secret-bearing

Variable/secret retrieval and authentication commands that can return credential material remain excluded because CLIHarbor's current executor refuses secret-bearing plans.

### Interactive authentication

`login`, interactive authentication, MFA/password prompts, and similar flows remain vendor-owned. CLIHarbor does not synthesize keystrokes or pass credentials through argv.

### Mutating/destructive

Policy load/update/replace, issuer create/update/delete, API-key rotation, password changes, host-factory mutations, and other change/destructive operations remain outside the read-only executor milestone.

### Environment-conditional/deprecated

Commands registered only for some deployment types are not placed in the general cross-environment browser pack unless deployment mode can be established deterministically. Deprecated commands are excluded from new browser authority.

## Run from source

Normal development startup now exercises the embedded first-party pack:

```bash
go run ./cmd/cliharbor serve
```

Explicit source-pack qualification remains available:

```bash
go run ./cmd/cliharbor doctor --pack-file packs/conjur/conjur-v9.yaml
go run ./cmd/cliharbor serve --pack-file packs/conjur/conjur-v9.yaml --no-auto-setup
```

This explicit path is useful when reviewing a modified pack and deliberately does not imply trust from repository location alone.

## Work-laptop qualification boundary

Online evidence is sufficient to implement, pin, and regression-test the command and fallback-download contracts, but it cannot prove a specific organization's policy, endpoint configuration, authentication state, or corporate executable provenance.

For a managed laptop:

1. run `evaluation preflight` against the unchanged qualified CLIHarbor bundle;
2. start CLIHarbor normally;
3. if a compatible corporate `conjur.exe` exists, require unambiguous discovery/version qualification;
4. if no Conjur exists and policy permits the pinned GitHub release, allow the verified current-user fallback;
5. if automatic download is blocked by policy, do not bypass it—use the approved corporate install or `--no-auto-setup`;
6. execute a non-secret read workflow using an approved vendor-owned session.

A corporate CLI/version/help mismatch is evidence to revise or version the pack, not a reason to loosen discovery, version, argument, or supply-chain validation.
