---
title: "Conjur guided secret creation: owner and access dropdowns"
author: Quinn
date: 2026-10-15
branch: main
cost: { minutes: 9, tokens: 164136 }
touches:
  - docs/CLI_CATALOG.md
  - docs/CONJUR_INTEGRATION.md
  - internal/packs/conjur_pack_test.go
  - internal/planner/conjur_pack_test.go
  - internal/webui/static/assets/index-DqYD0QDJ.js
  - internal/webui/static/index.html
  - internal/webui/static/web-source.sha256
  - packs/conjur/conjur-v9.yaml
  - web/src/platforms/conjur/ConjurCreateSecret.test.tsx
  - web/src/platforms/conjur/ConjurCreateSecret.tsx
---

## Decided
- Pack stdin yamlTemplate placeholders must be required inputs (no conditionals), so the optional owner is a separate command `secret-create-owned`; default owner = plain `secret-create`.
- Access grant reuses `secret-permit` as a third approved step, run AFTER set-value so a failed grant leaves a usable secret.
- Dropdown roles come from `list-resources` stdout (createRunOutputDecoder + JSON array), filtered to the `account:kind:` prefix, sent as absolute IDs (`/id`).
- Inventory runs are sequential: run manager MaxActive = 4.
## Tried and ruled out
- Expiry guard of two run-margins for three approvals: approval TTL is 2 min, so it would always fail. Kept a single-run margin; a lapsed grant approval is reported as partial completion.
## Watch out
- Built web bundle is committed: run `go run ./tools/task web-build` and commit internal/webui/static.
- Tests that vi.mock('../../api/runs') must pass through createRunOutputDecoder via importOriginal.
- Adding a pack command needs the pack version bump + internal/packs/conjur_pack_test.go command list.
