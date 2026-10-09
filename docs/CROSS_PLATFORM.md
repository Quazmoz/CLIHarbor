# Windows and macOS setup

CLIHarbor uses the same Go runtime, embedded React UI, loopback security, trusted packs, typed forms, run history, and streaming on Windows and macOS. Native macOS builds support Apple Silicon (`arm64`) and Intel (`amd64`). Windows retains its existing x64 evaluation/preflight path.

## Normal macOS startup

```bash
go run ./tools/task build
./bin/cliharbor self-test
./bin/cliharbor doctor
./bin/cliharbor serve --no-auto-setup
```

`doctor` reports missing vendor tools with exit 1; CLIHarbor can still start and show their readiness. The built-in Conjur, Docker, kubectl, and GitHub CLI packs load automatically. Open **Add a CLI** to install the pinned official Conjur, kubectl, or GitHub CLI on macOS. Successful installation publishes the tool and tasks immediately. Docker remains externally installed. Conjur must satisfy `>=9.3.1-0 <10.0.0-0`. Its [pinned upstream release configuration](https://github.com/cyberark/conjur-cli-go/blob/v9.3.1/.goreleaser.yml) includes darwin builds.

Discovery searches absolute PATH directories first. After PATH misses, macOS checks the bounded Go/local/bin and Docker directories under the user's home, plus `/opt/homebrew/bin` and `/usr/local/bin`. Multiple matches in a tier remain ambiguous. Pin one approved installation when needed:

```bash
./bin/cliharbor serve --tool-path "cyberark-conjur-v9/conjur=/absolute/path/to/conjur"
```

Executable permission, resolved basename, version, and identity checks apply. For OIDC/JWT/SaaS or other interactive Conjur modes, complete the official `conjur login` flow in your terminal and return to **Authentication → Check session**. The existing reviewed HTTPS authn/LDAP browser bridge is also available when the vendor configuration qualifies.

## Platform boundaries

| Capability | Windows | macOS |
| --- | --- | --- |
| Embedded browser UI, packs, read-only tasks, SSE, cancellation | Supported | Supported |
| Conjur, Docker, kubectl installed-CLI discovery | Supported | Supported |
| Automatic pinned Conjur download | Windows amd64 only | Use **Add a CLI** |
| Explicit pinned Conjur installation | Windows amd64 | Intel and Apple Silicon |
| Reviewed Conjur authn/LDAP bridge and session checks | Supported | Supported |
| Guided external Conjur OIDC/JWT/SaaS launcher | Supported | Use the official CLI in your terminal |
| Descendant cleanup | Job Object | Dedicated process group |
| Immutable evaluation preflight | Existing Windows amd64 bundle | Use native build/self-test |

macOS/Linux groups clean up descendants that retain their process group on cancellation, timeout, and normal teardown. Deliberate process-group/session escape requires a stronger OS sandbox; it is not Job Object containment. The browser UI remains read-only and cannot select executables or arbitrary argv.

## Builds and verification

`go run ./tools/task build` runs the frontend checks, rebuilds embedded assets, then builds for the native Go host and writes `bin/SHA256SUMS`. The narrower `go-build` command compiles against existing embedded assets and does not regenerate the UI. When explicitly authorized and manually dispatched, CI runs quality checks on Windows/macOS/Linux, the production Chrome browser gate on macOS/Linux, and the existing Windows evaluation qualification. The macOS quality job uploads an unsigned native executable plus its checksum as `cliharbor-macos-<runner-arch>-<commit-sha>`; it is not the Windows evaluation bundle.

For an explicit Intel or Apple Silicon build from macOS:

```bash
GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -o bin/cliharbor-macos-amd64 ./cmd/cliharbor
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o bin/cliharbor-macos-arm64 ./cmd/cliharbor
```

Cross-compilation proves build compatibility; native execution and enterprise vendor acceptance are separate checks. macOS signing/notarization and managed Windows application-control qualification remain external release requirements.

Run the focused local checks:

```bash
go test -timeout 2m ./...
go test -race -timeout 2m ./...
CLIHARBOR_BROWSER_E2E=1 go test -timeout 90s -count=1 -run '^TestProductionEmbeddedBrowserE2E$' ./internal/app
go run ./cmd/cliharbor pack lint --cases packs/example/packtest.json packs/example/pack.yaml
go run ./cmd/cliharbor pack test --cases packs/example/packtest.json packs/example/pack.yaml
```

The browser command requires Chrome/Chromium and Node 24; on macOS it discovers the usual application path. `CLIHARBOR_E2E_CHROME=/absolute/path` can select a test browser explicitly. The current hermetic Conjur browser fixture requires macOS or Linux; Windows retains its native Go/UI and Job Object checks.
