# Contributing

CLIHarbor is currently an early-stage project. Changes should preserve the product's thin/local/security-first boundary.

## Before coding

Read `AGENTS.md` and `docs/AGENT_INDEX.md`.

For Idira/CyberArk work, verify command syntax against the exact upstream/deployed CLI version. Do not invent commands from memory.

## Development principles

- Keep the runtime small.
- Prefer official CLI delegation over API reimplementation.
- Represent execution as executable + argument array.
- Keep vendor-specific logic out of the generic executor/planner.
- Treat packs as privileged configuration.
- Never commit credentials, tenant-specific data, secrets, or internal endpoints.
- Add tests around security-sensitive boundaries.
- Keep `/bootstrap` and `/api/*` server-owned; frontend routing must not weaken the browser/session boundary.
- Treat generated frontend assets as build output sourced from `web/`, not hand-authored runtime code.

## Toolchains

- Go 1.27.1 (see `.go-version`)
- Node 24.21.0 (see `.node-version`)
- npm lockfile at `web/package-lock.json`

Install frontend dependencies with:

```text
npm ci --prefix web
```

## Runtime and frontend development

Run the production-style embedded runtime:

```text
go run ./cmd/cliharbor
```

The runtime binds to IPv4 loopback, generates a short-lived one-time browser bootstrap handoff, and requests the system default browser. Browser-launch failure is non-fatal and prints the local bootstrap URL for manual opening.

For frontend development, use two terminals:

```text
# terminal 1
go run ./tools/task web-dev

# terminal 2
go run ./cmd/cliharbor --web-dev-url http://127.0.0.1:5173
```

The Vite development server is loopback-only. The browser still talks to CLIHarbor's authenticated origin; the Go runtime proxies frontend requests to the explicitly configured loopback Vite origin. Do not add permissive CORS to bypass this model.

## Cross-platform task entry point

The Go task tool is the supported Windows/Linux/macOS command surface; GNU Make is not required.

```text
# frontend install, typecheck, lint, tests, build, then embedded-asset sync
go run ./tools/task web-build

# frontend gates + asset sync + Go vet/tests
go run ./tools/task check

# synchronize an already-built web/dist into internal/webui/static
go run ./tools/task sync-web

# build embedded CLIHarbor into ./bin
go run ./tools/task go-build

# rebuild frontend, sync assets, then build the executable
go run ./tools/task build
```

For concurrency-sensitive Go changes, also run where supported:

```text
go test -race ./...
```

When frontend source changes, commit the synchronized files under `internal/webui/static/`. CI rebuilds the frontend on Windows and Linux and fails if generated assets differ from committed output.

## CI gates

GitHub Actions runs on Windows and Linux and validates:

- `npm ci` from the lockfile;
- frontend TypeScript typecheck;
- frontend lint;
- frontend component tests;
- production Vite build;
- generated embedded-asset synchronization;
- Go formatting;
- `go vet`;
- Go tests;
- final embedded Go executable build.

Linux also runs the Go race detector. Passing compilation on a platform is not a claim that all platform-specific desktop behavior has been manually exercised there.

## Pull request expectations

A substantive PR should explain:

- problem/outcome;
- affected product requirement or ADR;
- security impact;
- tests run;
- Windows verification when process/browser/path behavior changed;
- pack/schema compatibility implications;
- documentation updates.

## Pack contributions

A pack change should include:

- source/version of the wrapped CLI used for verification;
- help/docs evidence for the command/flags;
- risk classification;
- input validation;
- output sensitivity classification;
- parser fixtures where structured output is used;
- tests proving generated argv.

## Security-sensitive changes

Changes touching any of these require extra review:

- process execution;
- auth/session flows;
- browser bootstrap/session security;
- frontend development proxying or static asset serving;
- pack loading/trust;
- remote networking;
- secret handling/redaction;
- file access;
- destructive command confirmation;
- PTY/terminal support;
- update/distribution mechanisms.

## Documentation discipline

When behavior changes, update the canonical document identified in `docs/AGENT_INDEX.md`. If an accepted architecture decision changes, add a superseding entry to `docs/DECISIONS.md` rather than silently rewriting history.
