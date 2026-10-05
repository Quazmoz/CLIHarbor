# GitHub CLI integration

CLIHarbor embeds `packs/github/github.yaml` (`github-cli`, version `0.1.0`) alongside Conjur, Docker, and kubectl. The official `gh` executable remains externally installed and owns authentication. No GitHub-specific branch is added to discovery, planning, execution, or run history.

The reviewed baseline is GitHub CLI **2.95.0**, checked against its installed version/help output and the official command manual on 2026-10-05. The pack requires `>=2.95.0-0 <3.0.0-0` on Windows, macOS, and Linux. Older versions and future major versions fail compatibility checks.

| Task | Reviewed command | Returned metadata |
| --- | --- | --- |
| Local version | `gh --version` | CLI version and release URL; no account access |
| Repository inventory | [gh repo list](https://cli.github.com/manual/gh_repo_list) | Name with owner, private/archive flags, URL |
| Pull requests | [gh pr list](https://cli.github.com/manual/gh_pr_list) | Number, state, draft flag, timestamps, URL |
| Issues | [gh issue list](https://cli.github.com/manual/gh_issue_list) | Number, state, timestamps, URL |
| Workflow runs | [gh run list](https://cli.github.com/manual/gh_run_list) | Run ID, event, status, conclusion, timestamps, URL |
| Workflows | [gh workflow list](https://cli.github.com/manual/gh_workflow_list) | Workflow ID, name, state |

Every inventory task requires an explicit owner or `OWNER/REPO` target and a maximum result count between 1 and 100. Repository inputs cannot be URLs or include a host component; the official CLI's existing host configuration remains authoritative. Pull requests and issues have allowlisted state choices. Workflow inventory can include disabled workflows through one fixed boolean switch. Fixed `--json` projections exclude descriptions, titles, bodies, comments, diffs, repository contents, workflow YAML, job logs, artifacts, and credentials. Names and URLs are operational metadata and may identify private repositories.

JSON lists currently use the faithful raw-output view; they do not claim the scalar-card parser supports collections. Stdout/stderr, exit status, cancellation, deadlines, output bounds, and executable revalidation use the ordinary runtime.

Install and authenticate `gh` using the organization's approved vendor process before running authenticated tasks. CLIHarbor does not install `gh`, collect GitHub credentials, launch login, or expose `auth token`, arbitrary `api` requests, extensions, mutations, checkout, or clone. The pack intentionally declares no generic session check: readiness proves executable compatibility, and a task's vendor failure remains authoritative evidence rather than an inferred sign-in verdict. Authentication reports **Session check unavailable**.

Pack checks require no GitHub account or network:

```text
go run ./cmd/cliharbor pack validate packs/github/github.yaml
go run ./cmd/cliharbor pack test --cases packs/github/packtest.json packs/github/github.yaml
go run ./cmd/cliharbor pack lint --cases packs/github/packtest.json packs/github/github.yaml
```

The 43 checked-in planner cases assert exact argv, every exposed state choice, disabled-workflow selection, result bounds, explicit targets, and rejection of undeclared inputs, flag injection, shell-like owner input, and repository URLs. Normal Go tests also check embedded loading and that automatic provisioning stays scoped to Conjur. Windows evaluation CI checks that zero-config `doctor` includes `github-cli/gh`.

Native macOS version/help and discovery checks establish the local CLI contract. Authenticated GitHub/GitHub Enterprise workflows and native Windows runtime behavior still require qualification on approved hosts; planner tests and cross-compilation do not establish that acceptance.
