# Conjur CLI 9.x Integration

## Status

CLIHarbor includes a real, version-gated read-only pack for the official CyberArk / Idira Secrets Manager Conjur CLI:

```text
packs/conjur/conjur-v9.yaml
```

The implementation is derived from the official upstream `cyberark/conjur-cli-go` v9.3.1 release and source, not from remembered or guessed CLI syntax.

**Upstream qualification baseline:**

- repository: `cyberark/conjur-cli-go`
- release: `v9.3.1`
- upstream commit: `7207d6a4a2005130978e10d03d7f6b55ab0216d6`
- CLIHarbor compatibility constraint: `>=9.3.1 <10.0.0`

The deployed company-managed Windows binary is still an environment-specific compatibility surface. CLIHarbor therefore runs a fixed `conjur --version` probe and fails closed when the discovered version does not satisfy the pack constraint.

## Authoritative upstream evidence

The pack was derived from these official upstream surfaces:

- [`cyberark/conjur-cli-go`](https://github.com/cyberark/conjur-cli-go) — certified Conjur/Idira CLI source repository;
- [`v9.3.1`](https://github.com/cyberark/conjur-cli-go/releases/tag/v9.3.1) — release tied to the qualified upstream commit;
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
- if the vendor CLI cannot use an existing session, the command is expected to fail and the operator should authenticate through the approved vendor-owned flow;
- generic `requiresAuth: true` commands without this explicit mode remain blocked and are not surfaced in the browser.

This is deliberately narrower than implementing a CLIHarbor authentication adapter or browser credential form.

## Commands intentionally not exposed

The upstream CLI contains more functionality than CLIHarbor currently grants browser authority to use.

### Secret-bearing

Examples include variable/secret retrieval and authentication commands that can return credential material. These remain excluded because CLIHarbor's current executor refuses secret-bearing plans.

### Interactive authentication

`login`, interactive authentication, MFA/password prompts, and similar flows remain vendor-owned. CLIHarbor does not synthesize keystrokes or pass credentials through argv.

### Mutating/destructive

Policy load/update/replace, issuer create/update/delete, API-key rotation, password changes, host-factory mutations, and other change/destructive operations remain outside the read-only executor milestone.

### Environment-conditional/deprecated

Commands registered only for some deployment types, such as certain self-hosted-only operations, are not placed in the general cross-environment browser pack unless the deployment mode can be established deterministically. Deprecated commands are also excluded from new browser authority.

## Run from source

On a machine with the repository/toolchain:

```bash
go run ./cmd/cliharbor doctor --pack-file packs/conjur/conjur-v9.yaml
go run ./cmd/cliharbor serve --pack-file packs/conjur/conjur-v9.yaml
```

If `conjur` is installed outside `PATH`, use the normal backend-only override:

```text
--tool-path cyberark-conjur-v9/conjur=C:\path\to\conjur.exe
```

The browser cannot select or alter that executable path.

## Work-laptop use with the qualified evaluation executable

The Phase 0 evaluation bundle remains intentionally immutable and discovery-only. Do not copy this pack into the extracted qualified bundle before running `evaluation preflight`, because preflight rejects unexpected bundle entries.

After preflight succeeds, place `conjur-v9.yaml` in a separate company-approved user-writable location and explicitly load it, for example:

```bat
bin\cliharbor-windows-x64-evaluation.exe doctor --pack-file "..\cliharbor-packs\conjur-v9.yaml"
bin\cliharbor-windows-x64-evaluation.exe serve --pack-file "..\cliharbor-packs\conjur-v9.yaml"
```

If company policy does not permit transferring the pack separately, keep using the discovery-only Phase 0 flow until an internally approved distribution mechanism is available.

## Qualification boundary

Online source evidence is sufficient to implement and regression-test the command contract, but it does not prove the exact binary/configuration installed on a managed corporate endpoint.

Before calling a specific work-laptop installation qualified, verify at minimum:

1. `evaluation preflight` succeeds for the CLIHarbor executable;
2. discovery resolves the intended `conjur.exe` unambiguously;
3. the fixed version probe reports a version satisfying `>=9.3.1 <10.0.0`;
4. the relevant fixed help probes match the expected command family;
5. at least one non-secret read workflow succeeds using the existing approved vendor session.

A mismatch is evidence to revise or version the pack, not a reason to loosen discovery, version, or argument validation.
