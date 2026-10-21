---
title: "Dev gate repair: macOS tempdir symlinks, packtest ids, gofmt gate, Vite pin"
author: Quinn
date: 2026-10-21
branch: dev
cost: { minutes: 6, tokens: 85053 }
touches:
  - web/src/test/setup.ts
  - tools/task/main.go
  - internal/app/app.go
  - internal/app/runtime_default_test.go
  - internal/audittrail/lock.go
  - internal/discovery/discovery_test.go
  - internal/platforms/conjur/credential_login_test.go
  - internal/runs/guarded_output_test.go
  - internal/server/credential_config_api_test.go
  - internal/server/server.go
---

## Decided
- Terraform platform tests resolve t.TempDir() with filepath.EvalSymlinks; macOS /var -> /private/var otherwise trips the intended symlinked-root refusal in terraform.New. Production refusal stays as-is.
- packtest.json `values` keys must be kebab-case pack input ids; one bad key fails the whole document.
- `go run ./tools/task check` now fails on gofmt drift, with explicit roots (cmd internal packs schemas tools) so it skips web/node_modules.
- Vite pinned to 8.3.4 for the 8.3.0-8.3.2 advisories; 8.3.5 was skipped as same-day-fresh.
- Frontend control-char checks use /\p{Cc}/u (ESLint no-control-regex rejects \u0000 ranges).
## Tried and ruled out
- Relaxing terraform root symlink rejection to fix the macOS tests: weakens a deliberate safeguard.
## Watch out
- `go test ./...` also walks web/node_modules/flatted/golang (no tests; compile only).
