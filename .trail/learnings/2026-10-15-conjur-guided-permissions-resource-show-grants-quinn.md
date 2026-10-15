---
title: "Conjur guided permissions: resource-show grants and shared conjurRuns module"
author: Quinn
date: 2026-10-15
branch: main
cost: { minutes: 5, tokens: 79917 }
touches:
  - docs/CONJUR_INTEGRATION.md
  - internal/webui/static/assets/index-8qKsSPBR.js
  - internal/webui/static/index.html
  - internal/webui/static/web-source.sha256
  - web/src/platforms/conjur/ConjurCreateSecret.test.tsx
  - web/src/platforms/conjur/ConjurCreateSecret.tsx
  - web/src/platforms/conjur/ConjurWorkspace.tsx
  - internal/webui/static/assets/index-CS15bdFL.js
  - web/src/platforms/conjur/ConjurManagePermissions.test.tsx
  - web/src/platforms/conjur/ConjurManagePermissions.tsx
---

## Decided
- Guided Conjur forms share web/src/platforms/conjur/conjurRuns.tsx (completedRun, runRead, matchingPlans, approvalsFresh, useConjurInventory, RoleOptions). New guided forms should reuse it, not copy from ConjurCreateSecret.
- Current permissions come from `resource-show` JSON `permissions[]` ({role, privilege, policy}); the `policy` field is the granting branch, which `secret-deny` must target.
- Grants go into the variable's own policy; variable/role IDs are sent absolute (`/id`) so they resolve the same from any branch.
- ID lists use the Access Explorer's strict parseConjurIDs: a cross-account entry fails the whole inventory closed rather than being filtered.
## Tried and ruled out
- resource-permitted-roles for current access: it returns effective roles per privilege with no granting policy, so revoke can't be targeted.
## Watch out
- Tests mocking ../../api/runs must pass decodeRunOutput through via importOriginal.
- Kept the generic Grant/Revoke task shortcuts; PlatformPage.test.tsx asserts them.
