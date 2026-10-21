# Terraform integration — approved local inventory

## Status

**Read-only state inventory implementation (dev source); not a qualified Windows release.**
CLIHarbor provides a dedicated Terraform workspace, while preserving existing Conjur,
Idira, Docker, Kubernetes, GitHub, AWS, Helm and Vault packs.

The existing Terraform installation can be discovered and version-qualified
(`>=1.5.0 <2.0.0`). Five offline help/version tasks remain. The version task uses plain-text output; JSON remains in the version-discovery probe, because Terraform's version JSON includes additional undeclared fields not supported by CLIHarbor's strict structured-card parser.
No provider installation, network backend access or Terraform subprocess is used for state inventory.

## Quickstart

1. Open **Add a CLI → HashiCorp Terraform**. If missing, choose **Get Terraform — official download**. Download the Windows ZIP from HashiCorp, extract the CLI to a folder owned by your Windows user (no admin elevation), then restart CLIHarbor. If Terraform is not discoverable on PATH, restart with `--tool-path terraform-cli/terraform=C:\Users\you\tools\terraform.exe`. Verify discovery/version readiness; this does not authenticate to any cloud provider. The vendor link is a guided manual download, **not** in-app installation. The latter remains disabled pending independently qualified ZIP member hash and size.
2. Identify an existing, **trusted local Terraform root directory**, not a remote backend. Stop concurrent writers before relying on the inventory.
3. Launch CLIHarbor with a startup-only approval, for example:
   - Windows PowerShell: `.\cliharbor.exe serve --terraform-project "C:\Users\you\infra\demo"`
   - Linux/macOS: `./cliharbor serve --terraform-project "/home/you/infra/demo"`
   - Repeat `--terraform-project` for additional independent roots (maximum 16). Quoting a path containing spaces is supported. **Never** pass a project from an untrusted source.
4. Open **Built-in CLIs → HashiCorp Terraform → Projects**. Select the approved project from the dropdown, then one direct-child `.tfstate` file. Symlinks, nested paths, UNC paths and remote backend connections are unavailable.
5. Open **Resources**. Filter the managed/data category and resource type, search exact addresses, or switch between Table, JSON addresses and Safe summary.
6. Select exactly one resource address for inspection. Selecting or switching values never invokes Terraform. The **State management** tab explains consequences, but the **Preview removal** button is deliberately disabled and there is no removal action.

## What is read

The backend bounds state files to 8 MiB and extracts resource identifiers from
supported **Terraform state-v4 JSON**. Only exact addresses, resource types,
module addresses and managed/data categories enter the browser response.
No raw attribute values, outputs or credential content are returned, although
resource addresses themselves may be sensitive. This snapshot parser is not
a substitute for `terraform state list` validation. Unsupported state schemas,
ambiguous instance addresses, changed file identity, inaccessible or oversized
files are refused. No Terraform command is started for this inventory.

Project roots are approved by the **launching process operator**, not through
browser-supplied paths. Browser requests use opaque identifiers. API requests
cannot add roots, select alternate paths, pass shell arguments, or disable locking.

## State detach, backups and recovery

The old v0.3.0 generic `local-state-resources`, `local-state-forget-preview`
and `local-state-forget` tasks were removed in v0.4.0 and remain disabled in v0.4.1. The former dry-run was
an independent, advisory command, not an enforced snapshot-bound prerequisite.

**There is currently no state detachment and no CLIHarbor-created backup.**
Do not assume that Terraform locking, backup creation or recovery has run.
Future state-removal execution requires an authenticated, one-use preview tied
to trusted file handle/identity, state snapshot, exact resource instance set,
time-limited approval, exclusive lock and verified backup evidence.
A lost response after a mutation must be reconciled before retrying; no
automatic replay may be allowed.

Even with a future qualified `terraform state rm`, forgetting state
does **not** destroy cloud infrastructure, and a future apply can recreate
resources still present in configuration. Preserve existing state/backups
outside CLIHarbor according to your organization's policy.

## Unsupported

Remote backends, HCP Terraform, workspace switching, provider downloads,
`init`, `fmt`, `validate`, `plan`, `apply`, `destroy`, state attributes,
output values, mutating tasks, automatic backup and mutation history are all
unavailable in this milestone. The tabs reserve navigation space but do not
claim those operations execute.

## Qualification

Do not treat a source-only commit as a release. Run the repository's pinned
`go run ./tools/task check`, `npm run typecheck --prefix web`,
`npm run lint --prefix web`, `npm test --prefix web`,
`go test -race ./...`, `go vet ./...`,
`go run ./tools/task web-build` and
`go run ./tools/task verify-web-sync`. Test Windows drive/path casing,
junctions and reparse points, concurrent state replacement, large/malformed
state fixtures, keyboard focus, narrow viewport, and authenticated loopback
API boundaries before beta promotion. No GitHub Actions should be dispatched
without explicit authorization.
