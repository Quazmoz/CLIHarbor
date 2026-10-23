# Terraform integration: approved local configuration checks, state inventory and guarded state removal

## Status

**Read-only configuration formatting, state inventory and guarded local state removal (dev source). Not a qualified Windows release.**
CLIHarbor provides a dedicated Terraform workspace, while preserving existing Conjur,
Idira, Docker, Kubernetes, GitHub, AWS, Helm and Vault packs.

The existing Terraform installation can be discovered and version-qualified
(`>=1.5.0 <2.0.0`). Five offline help/version tasks remain. The version task uses plain-text output; JSON remains in the version-discovery probe, because Terraform's version JSON includes additional undeclared fields not supported by CLIHarbor's strict structured-card parser.
State inventory does not spawn Terraform. State removal invokes the official `terraform state rm` (see *State removal* below). Configuration formatting invokes only the version-qualified, identity-checked Terraform executable using bounded stdin in an isolated temporary working directory.

## Quickstart

1. Open **Add a CLI → HashiCorp Terraform**, or choose **Set up Terraform (no admin required)** from the dedicated Terraform workspace to open the same guide under Diagnostics. On Windows, download an organization-approved Windows ZIP from HashiCorp. In File Explorer, paste the guide's **Copy user folder** value (`%USERPROFILE%`), then create `bin` there if missing. Extract `terraform.exe` directly to `%USERPROFILE%\bin\terraform.exe`. CLIHarbor searches this user directory when no matching PATH executable is present. Relaunch CLIHarbor from a new terminal; browser refresh does not rediscover executables. Verify readiness and version (`>=1.5.0 <2.0.0`). If Terraform is already found with an incompatible version, a second copy in the user `bin` folder will not override the PATH match. Fix the approved installation or use an administrator-approved backend `--tool-path` override. An invalid override must be corrected or removed at startup, not from the browser. The official link is a manual download; managed Terraform installation is disabled pending independent ZIP-member hash and size qualification.
2. Identify an existing, **trusted local Terraform root directory**, not a remote backend. Stop concurrent writers before relying on the inventory.
3. Launch CLIHarbor with a startup-only approval, for example:
   - Windows PowerShell: `.\cliharbor.exe serve --terraform-project "C:\Users\you\infra\demo"`
   - Linux/macOS: `./cliharbor serve --terraform-project "/home/you/infra/demo"`
   - Repeat `--terraform-project` for additional independent roots (maximum 16). Quoting a path containing spaces is supported. **Never** pass a project from an untrusted source.
4. Open **Built-in CLIs → HashiCorp Terraform → Configuration**. Select an approved project and choose **Check formatting**. The operation checks only eligible direct-child `.tf` files and never modifies them. Check the file-by-file formatted, needs-formatting, unsupported or inspection-failed statuses. A ready official Terraform CLI and active browser session are required.
5. In **Projects**, choose an approved project and one direct-child `.tfstate` file. Symlinks, nested paths, UNC paths and remote backend connections are unavailable.
6. Open **Resources**. Filter the managed/data category and resource type, search exact addresses, or switch between Table, JSON addresses and Safe summary.
7. Select exactly one resource address for inspection. Selecting or switching values never invokes Terraform.
8. To make Terraform forget that resource, open **State management** and choose **Preview removal**. CLIHarbor runs `terraform state rm -dry-run` and shows exactly what would be removed. Type the state file name to confirm, then choose **Forget from state**. The result names the verified backup written beside the state file. Real infrastructure is not destroyed.

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
eligible, direct-child `.tf` files under an approved root (maximum 4096 directory
entries), up to 256 KiB per file and 2 MiB total. The project listing and
formatting operation apply the same eligibility checks: symlinks, directories,
oversized and non-regular files do not consume the 64-file budget or enter
the formatter. Every candidate is revalidated after opening it through the
approved-root handle; content that changes, becomes inaccessible, or exceeds
a bound fails closed. Projects exceeding the 64-eligible-file formatting limit
still appear in the approved-project list and continue to support read-only
state inventory; their formatting requests fail closed. It uses traversal-resistant
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

## State removal (`terraform state rm`), backups and recovery

The old v0.3.0 generic `local-state-forget*` pack tasks stay removed: pack tasks still cannot mutate state, and `ResolveExecutionContext` refuses them. Removal is a dedicated platform operation with a backend-enforced two-step contract (ADR-040).

**Preview** (`POST /api/v1/terraform/state-removal/preview`, session + Origin + CSRF):

- The body takes opaque project/state IDs and 1 to 50 exact resource-instance addresses. Each address must be in a fresh bounded snapshot of the approved direct-child `.tfstate`, read through the pinned `os.Root` handle. Leading-dash, control or bidi-break characters, duplicates, unknown fields and query strings are refused.
- CLIHarbor runs `terraform state rm -dry-run -lock=true -lock-timeout=0s -state=<approved file> -- <addresses>` with the version-qualified, identity-checked executable. It runs in a neutral temporary directory with a minimal environment (`CHECKPOINT_DISABLE=1`, `TF_IN_AUTOMATION=1`, `TF_INPUT=0`), so the project's backend block, `TF_CLI_ARGS*` and `TF_DATA_DIR` cannot redirect or extend the command.
- The dry run must exit 0 and list exactly the requested addresses (`Would remove …`). The snapshot must be byte-identical afterwards.
- The response is a one-use preview ID (256-bit random, stored hashed). It is bound to the project, state file identity (same file, size, mtime), SHA-256, lineage, serial, address set and executable path plus content hash. It expires after 5 minutes. At most 8 previews are pending; the oldest is evicted.

**Execute** (`POST /api/v1/terraform/state-removal/execute`):

1. The preview is consumed first, so it can never be replayed, even if a later step refuses. The `confirm` field must equal the previewed state file name.
2. The state must still be byte-identical to the preview, and the executable must be unchanged. Otherwise the request is refused as stale and nothing is written.
3. An `approved` mutation-audit entry (`terraform-cli/state-rm`, risk `destructive`) is written before anything else. If the audit journal is unavailable, the operation is refused.
4. CLIHarbor writes `<state>.cliharbor-<UTC>-<rand>.backup` with exclusive create, fsyncs it, re-reads it and verifies its SHA-256 against the preview.
5. `terraform state rm -backup=<state>.terraform-<UTC>-<rand>.backup -lock=true -lock-timeout=0s -state=… -- <addresses>` runs. A held lock fails immediately instead of waiting.
6. Post-check. The new state must have the same lineage, a higher serial, and exactly the previous address set minus the previewed addresses. Terraform's own backup must describe the previewed snapshot (same lineage, serial and address set); Terraform re-serializes it, so bytes are not compared. A `completed` audit entry records the exit status.

Outcomes: `removed` (verified); a refusal with nothing changed (lock held, Terraform error with the state provably byte-identical, stale preview); or `unverified`. `unverified` means the state changed but the post-check failed. The response names both backups and tells the operator not to retry. There is no automatic retry or restore. A lost response is reconciled by reloading the inventory, since the preview is already consumed.

**Recovery:** with no other Terraform process running, copy the CLIHarbor backup over the state file. It is byte-identical to the state you previewed. Backups end in `.backup`, so they are never listed as selectable state files. CLIHarbor does not prune them.

**Limits:** one state operation runs at a time per runtime, with a 10-second Terraform timeout per command and 64 KiB of output per stream. Raw Terraform output is never returned to the browser. Forgetting state does **not** destroy infrastructure, and a later `apply` will recreate resources still in configuration. Local `.tfstate` files only: remote backends and workspaces are still unsupported. Only a non-Terraform writer that rewrites the file *without* changing its serial, in the window between CLIHarbor's last identity check and Terraform's lock, would escape the post-check. CLIHarbor's byte-identical backup still allows recovery in that case.

## Unsupported

Remote backends, HCP Terraform, workspace switching, provider downloads,
`init`, mutating `fmt`, `validate`, `plan`, `apply`, `destroy`, state attributes,
output values, and mutating pack tasks are unavailable in this milestone. Local
state removal is the only state mutation, and only through the guarded flow above. The tabs reserve navigation space but do not
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
