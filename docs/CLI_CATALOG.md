# Supported CLI catalog

Open **Add a CLI** in the sidebar or on Overview. Search the configured reviewed
packs, install a missing supported tool, then select **Open tasks**. Installation
verifies the download, qualifies the executable, and updates Tasks and the Tools
sidebar without restarting CLIHarbor. Existing installations are discovered on
startup and can use the same catalog.

| CLI | Pinned download | Managed installation platforms |
| --- | --- | --- |
| CyberArk Conjur | 9.3.1 (`9.3.1-7207d6a` CLI version) | Windows amd64; macOS amd64 and arm64 |
| CyberArk Idira PAM (`idsec`) | Existing approved v0.13.x installation | Discovery only; no managed installation; read-only Safes/accounts metadata (unqualified candidate) |
| Kubernetes kubectl | 1.35.3 | Windows, macOS, Linux: amd64 and arm64 |
| GitHub CLI | 2.101.0 | Windows and macOS: amd64 and arm64 |
| Docker CLI | Existing installation | Discovery only; use an approved Docker setup with a working engine |
| Helm | 4.3.0 | Windows amd64 and arm64; macOS/Linux discovery only (Helm publishes tar.gz there) |
| AWS CLI v2 | Existing installation | Discovery only; AWS ships installers, not portable archives |
| HashiCorp Vault | Existing installation | Discovery only; executables exceed the 512 MiB portable-install bound |
| HashiCorp Terraform | Existing approved Terraform 1.5.x–1.x installation | Discovery only; version and offline command help; no project, state or mutation operations |

Idira PAM intentionally omits managed-download metadata despite the upstream v0.13.0 release: the Windows ZIP has an official archive digest, but no independently reviewed embedded executable hash and organization approval. See [Idira PAM](IDIRA_PAM.md).

Other platform combinations show installation guidance rather than an Install
button. Conjur's existing Windows-only automatic setup remains separate;
macOS Conjur, kubectl, and GitHub CLI downloads require an explicit Install action.

The **Create a custom CLI pack** guide on the same page is separate from the install catalog. It downloads a discovery-only pack YAML file with no runnable tasks and no backend writes. It does not import, install, or activate a CLI. After independent review, validate/lint locally and explicitly start CLIHarbor with `--pack-file`. See [Pack specification](PACK_SPEC.md) and [README authoring quickstart](../README.md#add-another-cli-without-changing-go-code).

The catalog lists tools from already-loaded trusted packs. Adding an arbitrary
executable or URL does not generate command authority. Additional CLIs need a
reviewed pack with approved command/input/output contracts and immutable install
metadata; see [Pack specification](PACK_SPEC.md). No remote pack marketplace,
shell installer, package-manager bridge, or runtime command scraping is added.

## Installation and activation

- Requests carry only pack/tool IDs and an optional constrained current-user
  install base directory. Artifacts and exact archive members come from packs.
- Only a tool with authoritative discovery status `missing` can be installed.
  Ready, ambiguous, incompatible, failed, unsupported and invalid override
  states are refused, including direct API requests.
- The existing portable provisioner bounds HTTPS downloads, restricts redirects,
  checks sizes/hashes, and extracts only one reviewed executable from ZIPs.
- Only the installed tool is qualified using the normal discovery path and its
  reviewed version probe. Its parsed version must match the install version.
- Discovery's captured executable content hash must also match the pinned
  executable hash. The run manager revalidates its identity before activation
  and the executor retains its existing checks before each run.
- Activation adds only a previously missing tool. Other tool identities, active
  plans, approvals, retained runs and the trusted pack registry are preserved.
- The sanitized task/tool catalog is refreshed under a lock. The browser fetches
  the updated catalogs; a failed refresh tells the user to reload the page.
- Conjur activation also enables its existing reviewed authentication and audit
  adapters. Installation does not authenticate any CLI or create a service.
- Managed executables and custom install locations persist through the existing
  current-user mechanisms and are reverified at the next startup. A custom
  location is not saved while live executable/version/hash qualification is
  failing; failed qualification cannot seed a misleading location for restart.

kubectl must remain within one minor release of the target cluster's API server.
The catalog displays the pinned version before installation. Operators needing
another version should use their approved installation and ordinary discovery.
GitHub authentication remains owned by `gh`; Docker needs an accessible engine;
kubectl and Helm need their normal kubeconfig/context and cluster access. AWS
CLI uses its existing profile/SSO session (`AWS_PROFILE` is inherited); Vault
uses `VAULT_ADDR` and its token helper. All three new packs are read-only and
use client-side field selection so tags, user data, environment variables,
release values and secret values are never printed.

## HashiCorp Terraform first-party support

Terraform is included in the first-party registry as `terraform-cli` (source: `packs/terraform/terraform.yaml`) and appears in **Add a CLI**, Diagnostics and Tasks even before installation. CLIHarbor discovers an existing approved Terraform CLI version `>=1.5.0 <2.0.0` and checks it with `terraform version -json`, using the JSON `terraform_version` field rather than provider versions.

Five offline tasks become available for an approved installed binary: **Terraform CLI version** (`terraform version -json`, shown as version/platform cards), **Terraform command reference** (`terraform help`), **Terraform provider command help** (`terraform providers -help`), **Terraform formatting command help** (`terraform fmt -help`), and **Terraform workflow command help** (a validated dropdown mapping `init`, `validate`, `plan`, `apply`, `destroy`, `workspace`, `state`, or `output` to exactly `terraform <command> -help`; it never executes the selected operation). Discovery probes and task executions use a fresh temporary working directory and a minimal synthetic environment, so they do not use the CLIHarbor checkout, the operator's Terraform root module, `TF_CLI_ARGS` or normal Terraform credentials. The version JSON can include `provider_selections` from the isolated working directory; the planner does not treat those entries as CLI versions. These tasks do not initialize backends, inspect state, download providers or modify infrastructure. The workflow selector is the only browser input and is constrained to a fixed enum mapping, followed by the mandatory `-help` argument; all other tasks accept no inputs. Unapproved argv/path/state/remote values are refused by the production planner.

**Current scope is deliberate.** This initial integration is not a project runner and does not claim to validate Terraform code or inspect infrastructure. `terraform providers` without `-help` reads backend state; even `terraform fmt -check` and `terraform validate` can surface HCL source excerpts in diagnostics. Until CLIHarbor has a reviewed workspace trust policy, controlled project-directory selection and a secret-safe output boundary, do not expose `init`, `plan`, `apply`, `destroy`, `providers` execution, `fmt` execution, `validate`, state or output retrieval. No managed Terraform download is offered without independent artifact verification and organization approval.

References: [Terraform CLI commands](https://developer.hashicorp.com/terraform/cli/commands), [version](https://developer.hashicorp.com/terraform/cli/commands/version), [providers](https://developer.hashicorp.com/terraform/cli/commands/providers) and [fmt](https://developer.hashicorp.com/terraform/cli/commands/fmt). Exact-argv and negative planner contracts are in `packs/terraform/packtest.json`.

## Artifact evidence

Portable artifact pins reviewed 2026-10-06. Current declarations are in `packs/conjur/conjur-v9.yaml` (pack 0.8.0),
`packs/kubectl/kubectl.yaml` (pack 0.4.0), and `packs/github/github.yaml`
(pack 0.2.0); the existing pack schema is unchanged. Helm pins in
`packs/helm/helm.yaml` (reviewed 2026-10-14) match the official
`.zip.sha256sum` files; each `helm.exe` member was hashed and measured
independently and not run. Conjur macOS pins use
the official v9.3.1 release API digest and exact size. Its install version matches
the exact official CLI banner, `9.3.1-7207d6a`, so live qualification succeeds.
kubectl hashes and exact sizes were read from the versioned official download's
checksum files and response metadata. GitHub ZIP bytes were compared with the
official release API's digest and size; each exact executable member was then
hashed and measured independently. GitHub and kubectl binaries were not run for that review. The macOS arm64 Conjur
standalone executable was independently hash/size verified and its version probe
was run to qualify the exact CLI version.

Primary references:

- [CyberArk Conjur v9.3.1 release metadata](https://api.github.com/repos/cyberark/conjur-cli-go/releases/tags/v9.3.1)
- [Kubernetes download and checksum procedure](https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/)
- [kubectl version skew policy](https://kubernetes.io/releases/version-skew-policy/#kubectl)
- [GitHub CLI v2.101.0 release](https://github.com/cli/cli/releases/tag/v2.101.0)
- [GitHub release asset metadata](https://api.github.com/repos/cli/cli/releases/tags/v2.101.0)
- [Helm v4.3.0 release](https://github.com/helm/helm/releases/tag/v4.3.0) and `get.helm.sh/*.zip.sha256sum`
- [Vault 2.1.2 SHA256SUMS](https://releases.hashicorp.com/vault/2.1.2/vault_2.1.2_SHA256SUMS) (size bound evidence)

Acceptance covers install-to-task publication without restart, failed version
and content qualification, non-missing-state refusal, platform-specific install
capabilities, single submission, search, and existing custom-location behavior.
Native Windows runtime qualification remains required in Windows CI; a macOS
run or Windows cross-compilation does not establish it.

### Conjur 9.x inventory tools

The reviewed Conjur pack v0.7.0 now includes **Browse secret variable IDs**, **Browse policies**, **Browse hosts** and **Browse groups**. Each uses the vendor's `list` command with a fixed `--kind` value, required `--limit` 25/50/100, optional `--offset`, and JSON output. Only metadata is returned; secret values are never retrieved. The dedicated Conjur home links to these and existing review/approval tasks, all using the shared planner and execution gate.

