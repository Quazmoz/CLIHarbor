# Terraform integration — approved local configuration checks and state inventory

## Status

**Read-only configuration formatting and state inventory (dev source); not a qualified Windows release.**
CLIHarbor provides a dedicated Terraform workspace, while preserving existing Conjur,
Idira, Docker, Kubernetes, GitHub, AWS, Helm and Vault packs.

The existing Terraform installation can be discovered and version-qualified
(`>=1.5.0 <2.0.0`). Five offline help/version tasks remain. The version task uses plain-text output; JSON remains in the version-discovery probe, because Terraform's version JSON includes additional undeclared fields not supported by CLIHarbor's strict structured-card parser.
State inventory does not spawn Terraform. Configuration formatting invokes only the version-qualified, identity-checked Terraform executable using bounded stdin in an isolated temporary working directory.

## Quickstart

1. Open **Add a CLI → HashiCorp Terraform**. If missing, choose **Get Terraform — official download**. Download the Windows ZIP from HashiCorp, extract the CLI to a folder owned by your Windows user (no admin elevation), then restart CLIHarbor. If Terraform is not discoverable on PATH, restart with `--tool-path terraform-cli/terraform=C:\Users\you\tools\terraform.exe`. Verify discovery/version readiness; this does not authenticate to any cloud provider. The vendor link is a guided manual download, **not** in-app installation. The latter remains disabled pending independently qualified ZIP member hash and size.
2. Identify an existing, **trusted local Terraform root directory**, not a remote backend. Stop concurrent writers before relying on the inventory.
3. Launch CLIHarbor with a startup-only approval, for example:
   - Windows PowerShell: `.\cliharbor.exe serve --terraform-project "C:\Users\you\infra\demo"`
   - Linux/macOS: `./cliharbor serve --terraform-project "/home/you/infra/demo"`
   - Repeat `--terraform-project` for additional independent roots (maximum 16). Quoting a path containing spaces is supported. **Never** pass a project from an untrusted source.
4. Open **Built-in CLIs → HashiCorp Terraform → Configuration**. Select an approved project and choose **Check formatting**. The operation checks only eligible direct-child `.tf` files and never modifies them. Check the file-by-file formatted, needs-formatting, unsupported or inspection-failed statuses. A ready official Terraform CLI and active browser session are required.
5. In **Projects**, choose an approved project and one direct-child `.tfstate` file. Symlinks, nested paths, UNC paths and remote backend connections are unavailable.
6. Open **Resources**. Filter the managed/data category and resource type, search exact addresses, or switch between Table, JSON addresses and Safe summary.
7. Select exactly one resource address for inspection. Selecting or switching values never invokes Terraform. The **State management** tab explains consequences, but the **Preview removal** button is deliberately disabled and there is no removal action.

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

## Configuration formatting contract

The browser posts an opaque approved project ID to a same-origin, CSRF-protected
`/api/v1/terraform/format-check` endpoint. Each check accepts at most 64
direct-child `.tf` entries under an approved root (maximum 4096 directory
entries), up to 256 KiB per file and 2 MiB total. Projects exceeding the
64-file formatting limit still appear in the approved-project list and
continue to support read-only state inventory; their formatting requests
fail closed. It uses traversal-resistant
Go `os.Root` directory handles with startup identity, modification-time and
size revalidation. Both configuration and state listing/reads use those
handles to avoid path-replacement directory traversal. Symlinks, oversized files, unreadable files and replacement
races fail closed.

For each bounded snapshot, CLIHarbor runs
`terraform fmt -check -write=false -no-color -` with the configuration passed
on standard input. The process has a neutral home, no inherited Terraform
CLI argument environment, no shell, a five-second per-file timeout, 25-second
request deadline, 1024-byte-per-stream output bound and one concurrent
project formatting operation across the local runtime. Exit 0 means formatted;
exit 3 means needs formatting only when there were no diagnostics; errors,
timeouts, unexpected exits and truncated output mean inspection failed.
Raw stdout, stderr, source text and diffs are discarded, not sent to the browser
or persisted. The browser sees only the direct-child filename, status,
conservative reason and completion time.

Formatting is **not** syntax/type validation, provider execution,
remote backend access, drift detection or an infrastructure plan. Sensitive
configuration text is still read by a local executable; approve only projects
and binaries you trust. `.tfvars`, nested modules and `.tf.json` are not
included in this milestone. An inspection can be stale if another process
changes source after the snapshot; rerun after changes.

**Qualification hold:** This development change must not be promoted to
`beta` until pinned Go/Node checks, embedded web-asset synchronization,
real Terraform synthetic-fixture integration, and native Windows reparse
and process acceptance pass. A dev source commit alone does not update the
embedded production frontend.

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
`init`, mutating `fmt`, `validate`, `plan`, `apply`, `destroy`, state attributes,
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
