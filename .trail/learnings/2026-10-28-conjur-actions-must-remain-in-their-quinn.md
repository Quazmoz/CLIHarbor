---
title: Conjur actions must remain in their dedicated workspace
author: Quinn
date: 2026-10-28
branch: dev
id: l-4b527fe9
scope: repo
status: active
src: agent
touches:
  - docs/CONJUR_INTEGRATION.md
  - docs/DECISIONS.md
  - docs/SECURITY.md
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - internal/app/browser_e2e_test.go
  - internal/webui/static/assets/index-BGPLkrKD.css
  - internal/webui/static/assets/index-DK0oKVez.js
  - internal/webui/static/index.html
  - internal/webui/static/web-source.sha256
---

## Decided
The user corrected the prior UX choice: Conjur permission, maintenance, inspection and migration shortcuts must stay in Conjur rather than handing off to Command Builder. ADR-041 supersedes the generic-shortcut choice in the October 15 guided-permissions learning. Reuse ConjurManagePermissions and ConjurCreateSecret; other authorized catalog tasks use ConjurTaskPanel and the shared typed controls in taskForm.tsx. The backend pack and preview/run APIs remain the authority.

## Tried and ruled out
Do not infer LDAP authenticator service IDs or issuer IDs from policy/resource names: there is no reviewed enumeration contract for those fields. Keep explicit manual entry and use bounded inventory only where ID semantics are known. LDAP CSV roles cannot safely offer identifiers containing commas as single selectable roles.
The browser E2E fixture's old whoami-only pack cannot qualify permissions. Load the actual embedded Conjur pack with a test-only Linux extension and a credential-free CLI fixture instead. isRunCreateRequest defaults to the integration fixture pack, so Conjur assertions must pass its pack ID explicitly.

## Watch out
Preserve vendor-target focus/visibility refresh and account/endpoint-keyed form resets. Context loading can remount selectors; acceptance tests should wait for inventory and then obtain the current control. Resource-exists parsing expects a reviewed JSON object, not scalar true. At 320px, the Conjur Tools tab overflowed the page; allow the dedicated tab row to wrap and retain a real browser overflow assertion. Inventory is a convenience, never proof of existence or permission. Mutation approvals stay one-use, edits invalidate them, and unknown starts must never replay automatically.
