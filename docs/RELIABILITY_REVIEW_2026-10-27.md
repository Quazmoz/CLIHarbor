# Regular CLI reliability review — 26–27 October 2026

Started from live `dev` at `4115f41`, with a clean checkout. That documentation
commit and all earlier history are preserved. This is local source validation,
not Windows or production release qualification. No Actions, promotion,
deployment, private tenant data or infrastructure mutation was used.

## Fixes and regression evidence

| Defect | Root cause and resulting behavior | Regression |
| --- | --- | --- |
| Homebrew Terraform integration failed before execution | The test harness passed a PATH symlink straight to identity capture. Its shared activation helper now resolves it first, matching production discovery. Production symlink refusal is retained. | Baseline real integration failed with `invalid argument`; the repaired integration and explicit Unix symlink regression pass with installed Terraform 1.12.2 on disposable state. |
| Status-retry test intermittently counted five instead of six requests | Its heading existed during loading; the sixth fetch belonged to Activity. A deferred task response now proves metadata remains pending, then verifies the actual task and usable Run action. | Task-specific endpoint assertions and controlled promise completion; no sleeps, total-fetch-count relaxation or retries. |
| Reads could hang after headers arrived | The shared deadline was cleared before body consumption. It now covers the full buffered response, including error bodies, and preserves caller aborts. | Stalled 200/503 bodies and body-time aborts failed before the fix and pass afterward. Legacy partial fetch mocks now use real responses. |
| Lost run-start response looked like a confirmed failure | Transport errors, malformed/mismatched success bodies and internal errors do not establish whether the process started. The shared client reports `run_start_unknown`; Activity says unconfirmed and recovery points to History and the target. Confirmed rejections remain specific. | API tests verify one POST and no automatic retry. Chrome discards a real accepted fixture acknowledgement, recovers its result through History and confirms one `run.started` event. |
| New History link temporarily displayed the previous run's evidence | Prop-driven selection changed the ID without clearing detail state. It now clears old evidence/errors and shows loading immediately; repeating the same selected link preserves evidence. | A delayed linked-run response reproduced the stale display before the fix; the repaired test passes. |
| Unix restart stopped a healthy instance before a failed build, and pull could run stale safeguards | Build completes before ownership-verified stop; `--pull` executes the updated helper. Windows already follows these contracts. | Hermetic fake Go/Git checks fail against the old helper and pass afterward; native restart acceptance uses the real helper. |
| Browser task-selection helper raced collapsed catalog rendering | Opening native details schedules React's toggle update. The shared helper now waits for the actual enabled task button before clicking. | The added lost-acknowledgement stage exposed this race; the complete Chrome suite passes after fixing the helper. |

## Workflow coverage

| Area | Evidence exercised |
| --- | --- |
| Startup/shutdown | Embedded production build, vendor-free self-test, bootstrap/session and failed-launch tests, owned native restart/stop, cancellation and listener cleanup. |
| Packs/discovery | Loader schema/resource/duplicate/trust tests; PATH, override, symlink, version, identity replacement and refresh tests; actual fixture `doctor`; actual pack validate/lint/generate-tests/test. |
| Command Builder | Catalog/filter/task switching, deferred loading, native validation, previews and approval invalidation, duplicate starts, keyboard/focus and 320–1440 px browser coverage. |
| Execution/streaming | Real local fixture argv/output/exit checks, UTF-8 split coverage, independent streams, deadlines/limits, cancellation/descendants, SSE replay/reconnect and terminal snapshots. |
| History/recovery | Retention/eviction, overlapping reads and stale details, navigation/activity lifetime, unconfirmed starts and explicit recovery without replay. |
| Setup/sessions/diagnostics | Existing managed-install integrity and concurrent refresh/activation tests, vendor-session checks, hermetic Conjur sign-in, allowlisted diagnostic sentinel tests and a real 722-byte fixture diagnostic export. |

## Dependency assessment

The verified npm findings were `undici` through `jsdom` and `zod` through
`eslint-plugin-react-hooks` / `zod-validation-error`. These are development
dependencies, absent from the production dependency tree and embedded browser
runtime. The smallest lockfile scope is two existing package records:
`undici` 8.10.2 → 8.12.3 and `zod` 4.6.5 → 4.6.7. Their parents' existing ranges
accept both versions; no dependency, override or top-level version was added.
Unrelated npm metadata churn was removed. Final `npm audit --json` reports zero
vulnerabilities, including development dependencies.

The [Undici advisory](https://github.com/advisories/GHSA-xjj6-f33q-929c) fixes
the high-severity content-encoding crash in 8.12.2; that line also fixes the
EventSource memory and integrity-token advisories reported by npm. The
[Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) fixes excessive
collection-validation memory use in 4.6.6. Pinned `govulncheck@v1.8.0` reports
no reachable Go vulnerabilities with Go 1.27.3.

## Local checks

Toolchains: Go 1.27.3, Node 24.21.0, npm 11.19.0; native macOS arm64.

- `bash tools/dev-restart.sh`: frontend install, typecheck, lint, all 358 tests
  in 38 files, production build, embedded synchronization and native build pass.
- `go test -race -shuffle=on -count=1 -timeout 3m ./...`: passes.
- `go mod verify`, `go vet ./...`, `gofmt -l cmd internal packs schemas tools`:
  pass, with no formatting drift.
- `CLIHARBOR_BROWSER_E2E=1 go test -count=1 -timeout 3m -run
  '^TestProductionEmbeddedBrowserE2E$' -v ./internal/app`: passes in Chrome,
  including the new real-process acknowledgement-loss recovery stage.
- `go test -count=1 -v ./internal/platforms/terraform -run
  'TestStateRemoval(HarnessResolvesExecutableSymlink|WithInstalledTerraform)$'`:
  both pass, without a resolved-path override or integration skip.
- `bash tools/test-dev-restart-paths.sh` and
  `node --test test/browser_harness_helpers.test.mjs`: pass.
- A consecutive native helper restart logs the verified prior PID stop and a
  fresh PID on a different loopback port. The final cleanup removes its owned
  PID marker; no unrelated process was stopped.
- Fresh native `version`, `self-test`, fixture `doctor`, pack validate/lint,
  diagnostics export, generate-tests and all nine generated contract cases pass.
- `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -exec=/usr/bin/true ./...`:
  packages compile. The replacement executor deliberately does **not** run
  Windows tests. This is compile coverage only.
- Final repository `go run ./tools/task check` and `verify-web-sync` must run
  after the regenerated embedded assets are committed; their Git drift gate
  intentionally rejects uncommitted generation. The follow-up evidence commit
  records those final results.
- `trail build` refreshed the graph. `trail check --base dev` reports two
  deliberate conflicts with the superseded Terraform workaround; the commit
  message explains why the harness fix is correct and preserves identity
  safeguards. Trail caps its diff at 400 KiB, so the generated JavaScript makes
  this an incomplete automated learning scan, supplemented by source review.

## Limits and release holds

Passing these checks establishes the repository-controlled fixture contracts
on this Mac, not universal CLI correctness. Native Windows execution remains
unverified: Job Objects, PATH/casing, reparse points, filesystem locks, terminal
handles, default browser, restart PowerShell and endpoint controls remain
required runtime acceptance. Corporate Conjur sessions, vendor authorization,
network/proxy policy and real service mutations were not exercised.

No known npm or reachable Go advisory remains from the scans above. Unknown
future advisories and vendor-specific behavior still require review. An accepted
run whose evidence was evicted or lost on restart remains an unknown outcome;
no idempotency or transactional rollback guarantee was added.

Trail replacement `l-484cf882` deliberately supersedes `l-a7d6d064`'s manual
Terraform test workaround. The old learning remains as history. Recovery,
approval clearing, task-search behavior, vendor boundaries and native Windows
release holds from the other learnings remain in force.
