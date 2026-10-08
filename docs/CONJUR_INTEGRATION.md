# Conjur CLI 9.x Integration

## Status

CLIHarbor includes a version-gated, curated Conjur CLI integration: reviewed reads, approval-gated secret variable management, LDAP mapping workflows, and issuer deletion. It is not a passthrough for every vendor command; see [Coverage and exclusions](#coverage-and-exclusions).

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

Pack version `0.7.0` supports installed Conjur on Windows and macOS using the same reviewed 9.x argv/version contract. The upstream [v9.3.1 release configuration](https://github.com/cyberark/conjur-cli-go/blob/v9.3.1/.goreleaser.yml) publishes darwin builds. The automatic pinned fallback and guided external vendor-login launcher remain Windows-specific; on macOS, install an approved official CLI and complete interactive login in your terminal. See [Windows and macOS setup](CROSS_PLATFORM.md).

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
- `pkg/cmd/policy.go` — `policy update --branch <b> --file -` (stdin) and `--dry-run`;
- `pkg/cmd/variable.go` — `variable set --id <id> --file -` (stdin; `--value` would expose the secret in argv and is not used);
- `cyberark/conjur` `gems/policy-parser` and `app/models/loader/types.rb` — `!variable`, `!permit`, `!deny`, `!delete` statement fields and `!deny` scoping to the loading policy;
- `pkg/clients/clients.go` — vendor-owned authentication/config/session behavior;
- checked-in `vhs/golden/*` command captures — root and command help/output behavior.

The trusted pack records fixed `--help` evidence probes for the root, `list`, `resource`, `role`, and `whoami` surfaces so an operator can capture exact deployed help text without granting arbitrary probe argv.

Windows evaluation CI also runs the exact pinned v9.3.1 binary through the `list` help probe and requires the Stage 5 `--members-of`, `--permitted-roles`, and `--privilege` flags to remain present. This checks the reviewed release directly rather than relying only on historical documentation.

## Implemented browser workflows

The current pack exposes reviewed non-secret reads and separately approved change/destructive workflows:

| CLIHarbor command | Conjur argv shape | Notes |
| --- | --- | --- |
| `whoami` | `conjur whoami --output json` | Current authenticated identity |
| `list-resources` | `conjur list [approved filters] --limit <25|50|100> [--offset N] --output json` | Bounded resource pages; page size is required and defaults to 25 in the browser. Relationship queries use their dedicated tasks. |
| `count-resources` | `conjur list [approved filters] --count --output json` | Count-only query with no resource payload or pagination limit. |
| `resource-exists` | `conjur resource exists <resource-id> --output json` | Structured boolean card |
| `resource-show` | `conjur resource show <resource-id> --output json` | Resource metadata |
| `resource-permitted-roles` | `conjur resource permitted-roles <resource-id> <privilege> --output json` | Permission relationship query |
| `role-exists` | `conjur role exists <role-id> --output json` | Structured boolean card |
| `role-show` | `conjur role show <role-id> --output json` | Role metadata |
| `role-members` | `conjur role members <role-id> [--verbose] --output json` | Member list/details |
| `role-memberships` | `conjur role memberships <role-id> --output json` | Parent-role memberships |
| `ldap-group-list` | `conjur authn-ldap groups list --id <service> --output json` | Group mapping names scoped to a configured LDAP service |
| `ldap-user-list` | `conjur authn-ldap users list --id <service> --output json` | User mapping names scoped to a configured LDAP service |
| `ldap-group-show/create/delete` | `conjur authn-ldap groups <show|create|delete> ...` | Show mappings and approval-gated mutations |
| `ldap-user-show/create/delete` | `conjur authn-ldap users <show|create|delete> ...` | Show mappings and approval-gated mutations |
| `issuer-delete` | `conjur issuer delete --id <id> ...` | Destructive; explicit approval |
| `secret-create` | `conjur policy update --branch <b> --file - [--dry-run]` + `!variable` | Change, approval required |
| `secret-delete` | `conjur policy update --branch <b> --file - [--dry-run]` + `!delete` | Destructive, typed approval |
| `secret-permit` | `conjur policy update --branch <b> --file - [--dry-run]` + `!permit` | Change, approval required |
| `secret-deny` | `conjur policy update --branch <b> --file - [--dry-run]` + `!deny` | Change, approval required |
| `secret-set-value` | `conjur variable set --id <id> --file -` + secret on stdin | Change, approval required; value never shown |

### Bounded resource listing

The upstream Conjur 9.3.1 `list` command defaults to as many as 10,000 resources when `--limit` is omitted. That vendor default is appropriate for a terminal but can exceed CLIHarbor's deliberately bounded in-memory browser output. CLIHarbor therefore does not rely on the vendor default: `list-resources` requires one reviewed page size (`25`, `50`, or `100`) and retains `offset` for explicit pagination. The browser selects `25` initially because required enum inputs initialize to their first reviewed value.

The deprecated list compatibility flags for role membership/permitted-role queries are no longer exposed through `list-resources`; the existing `role-members` and `resource-permitted-roles` tasks are the authoritative browser workflows for those operations. Counting is likewise a separate `count-resources` task so a pagination cap cannot silently change count semantics. The executor's output limit remains a final safety boundary rather than being enlarged or disabled.

All user-controlled positional identifiers are represented by CLIHarbor's constrained positional primitive: one validated scalar becomes exactly one argv element. CLIHarbor does not split it, template it, reinterpret it as a shell command, or allow a leading `-` that could become an undeclared flag.

## Access & permissions explorer

Open **Built-in CLIs → CyberArk Conjur → Access & permissions**, or visit `/dedicated/conjur/access-explorer`. This dedicated view runs **only existing backend-advertised read-only tasks**, with bounded inventory pages (25/50/100), a server-side search and a resource kind selector. Every resource or role selection rechecks the configured Conjur endpoint/account, CLI readiness/version, and the `whoami` identity before and after the query. Changed context, failed or incomplete vendor reads, oversized/malformed JSON, and cross-account IDs discard the result rather than imply that access is absent.

Resource detail output is deliberately restricted to `id`, `kind`, and `owner` strings; annotations, policies, arbitrary metadata and values are not displayed or exported from this view. Inventory exports contain only approved resource IDs. An optional task shortcut opens the already-approved task form with the reviewed resource/role ID prefilled; it does not preview, authorize or execute the task. All mutations retain the existing review/approval/audit lifecycle.

**Permission interpretation:** `resource permitted-roles` returns Conjur-reported permitted-role relationships for a selected `read`, `write`, or `execute` privilege. `role members` returns direct members by default. In the pinned 9.3.1 Go CLI, `role memberships` uses `RoleMembershipsAll` and therefore returns **recursively expanded memberships**, not direct parent edges. Duplicate IDs are removed for display; traversal is not performed by CLIHarbor. None of these relationships, nor an empty or unavailable result, constitutes proof of an individual identity's effective permission. Checking effective permission requires a separately reviewed authoritative privilege check, not graph inference. No new pack command is introduced.

See CyberArk's pinned [resource implementation](https://github.com/cyberark/conjur-cli-go/blob/7207d6a4a2005130978e10d03d7f6b55ab0216d6/pkg/cmd/resource.go) and [role implementation](https://github.com/cyberark/conjur-cli-go/blob/7207d6a4a2005130978e10d03d7f6b55ab0216d6/pkg/cmd/role.go). The explorer remains fixture/CI-qualified only until tested against an approved Conjur backend.

## Secret variable management

Select the task on the workbench, fill in the fields, select **Review change**, check the target, the exact policy document and the Conjur account/endpoint, then approve. Deleting a variable also requires typing the shown `DELETE: <variable>` text. Approvals expire after two minutes, work once, and are void if any input, the executable or the Conjur context changes.

| Task | Policy sent on stdin |
| --- | --- |
| Create secret variable | `- !variable` / `id: "<variable>"` |
| Delete secret variable | `- !delete` / `record: !variable "<variable>"` |
| Grant secret permission | `- !permit` / `role: !<kind> "<role>"` / `privileges: [ … ]` / `resource: !variable "<variable>"` |
| Revoke secret permission | the same shape with `!deny` |

- **Policy branch** is the branch loaded with `policy update` (`root` or e.g. `apps/myapp`). The variable and role IDs are relative to it; start a role ID with `/` for an absolute ID (for example `/ops`).
- **Privileges**: `execute` lets a role fetch the value, `update` lets it change the value, and `read` lets it see the variable's metadata. An application normally needs `read, execute`.
- **Revoke** removes only permissions granted by the same policy branch (Conjur scopes `!deny` to the loading policy). Revoke from the branch that granted the permission and confirm with **List permitted roles**.
- **Validate only (dry run)** asks Conjur to validate the policy without applying it. Conjur supports this on self-hosted (non-SaaS) deployments only.
- **Set secret value** takes the variable's full ID (for example `apps/myapp/db/password`). The value goes to `conjur variable set --file -` on stdin, so it never appears in the process list, the preview, run history, or the browser's retry state, and the field is cleared once the run starts. Values are limited to 4,096 characters on one line.
- Templates are fixed: you cannot submit free-form policy. User-entered IDs are always quoted YAML scalars, so they cannot add statements, and the templates never create users or hosts, so no API keys are returned.

To create a working secret: **Create secret variable**, **Set secret value**, then **Grant secret permission** (`read, execute`) to the consuming host or layer.

## Authentication model

All exposed commands use:

```yaml
requirements:
  requiresAuth: true
  authMode: vendor-session
```

`vendor-session` means task execution uses the vendor CLI's existing configuration/session/credential-storage behavior. CLIHarbor never puts a password, token, API key or MFA response into task argv or interactive stdin.

### Secure password handoff

For qualified Conjur configurations that use password-style `authn` or LDAP, the Authentication page now offers an explicit sign-in form. This is implemented as a **vendor adapter**, not as a pack command and not as a generic secret input type.

The backend uses pinned:

```text
github.com/cyberark/conjur-api-go v0.15.4
```

This is the same API library line used by the reviewed Conjur CLI 9.3.1 source. `Client.Login(identity, password)` performs the vendor login exchange and writes the resulting API key through Conjur's configured credential-storage provider. CLIHarbor does not persist the supplied password; the request exists only for the browser-to-loopback-to-vendor call lifetime, never enters argv/run history/logs, and the returned API-key byte slice is cleared after vendor storage completes.

The form is exposed only when the Conjur tool is healthy and the loaded Conjur configuration supports this bounded flow with an HTTPS appliance URL, a non-SaaS environment, and writable credential storage. OIDC, JWT, certificate, IAM/Azure, MFA/challenge and other interactive modes remain vendor-owned.

The login endpoint itself is protected by the existing loopback session, exact Host/Origin and CSRF controls, strict bounded JSON, no-store response policy and sanitized closed-set errors. Only one login attempt is admitted concurrently.

After a successful credential exchange the browser immediately runs the existing reviewed `conjur whoami --output json` session check. That check remains the browser-visible evidence that the stored vendor session is usable.

Downloading the Conjur executable still does not configure a Conjur appliance/account, authenticate a user, or create vendor credentials.

## Coverage and exclusions

The pinned CyberArk `conjur-cli-go` v9.3.1 provides commands beyond the **24 reviewed CLIHarbor pack tasks**. CLIHarbor supports resource/role queries, bounded inventory, whoami, LDAP group/user mapping list/show/create/delete, issuer delete, fixed-template secret variable operations, and the dedicated Conjur sign-in and secret-value audit. This is not full upstream CLI parity.

The following capabilities remain outside the browser's present authorization and data-sensitivity contract, pending separate per-command qualification:

- `variable get`, `host/user rotate-api-key`, and host-factory token/host creation may return credentials, secret values, or access material.
- `login`, `authenticate`, `logout`, and `init*` are vendor-owned configuration/session flows; only the separately reviewed password-style login adapter is currently available in-browser.
- Arbitrary policy `load/update/replace`, issuer `create/update`, and password changes require new operation-specific validation/approval/reconciliation before browser execution.
- `issuer get/list`, `policy fetch`, `pubkeys` and environment-dependent `check` require explicit data-sensitivity and size contracts. The upstream `check` command is registered only for non-SaaS configurations.
- Deprecated, compatibility or terminal-help commands do not automatically become browser executable tasks.

Operators may use their approved Conjur CLI in a terminal for workflows not qualified for the browser. CLIHarbor does not synthesize vendor syntax or accept arbitrary command strings.

## Commands intentionally not exposed

The upstream CLI contains more functionality than CLIHarbor currently grants browser authority to use.

### Secret-bearing

Variable/secret retrieval and authentication commands that can return credential material remain excluded because CLIHarbor's current executor refuses secret-bearing plans. Writing a value (`secret-set-value`) is write-only and returns no secret material.

### Interactive authentication

The pack still does not expose `login` or `authenticate` commands. The separate reviewed adapter supports only password-style authn/LDAP handoff. OIDC, MFA/challenge, certificate and similar interactive flows remain vendor-owned; CLIHarbor does not synthesize keystrokes or pass credentials through argv.

### Mutating/destructive

Free-form policy load/update/replace, issuer create/update, API-key rotation, password changes, host-factory mutations, and other change/destructive operations remain excluded. Only the fixed templates above, the LDAP mapping tasks, and issuer delete run, each behind backend-bound approval.

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
6. establish a vendor session either through the reviewed Authentication-page password bridge (when the configured Conjur mode supports it) or through the organization's approved vendor-owned flow;
7. run the reviewed session check, then execute a non-secret read workflow.

A corporate CLI/version/help mismatch is evidence to revise or version the pack, not a reason to loosen discovery, version, argument, or supply-chain validation.
