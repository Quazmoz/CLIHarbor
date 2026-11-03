---
title: Conjur grant wording must not promise exclusive access
author: Quinn
date: 2026-11-03
branch: dev
id: l-dfc0b90e
scope: repo
status: active
src: agent
touches:
  - docs/CONJUR_INTEGRATION.md
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - internal/webui/static/assets/ConjurAccessExplorer-DkNHuroq.js
  - internal/webui/static/assets/ConjurWorkspace-DMNx6Ypb.js
  - internal/webui/static/assets/OverviewPage-gbRR96yR.js
  - internal/webui/static/assets/PlatformPage-BqQUO1hQ.js
  - internal/webui/static/assets/TerraformWorkspace-DBGVnJFQ.js
  - internal/webui/static/assets/ToolsPage-C61Nh8j2.js
  - internal/webui/static/assets/index-CpF44AJr.css
---

## Decided
Describe an omitted optional permission as “No additional grant.” Keep plain-language privilege labels beside the exact read/execute/update tokens and preserve those tokens in requests. A variable owner, role memberships and grants can independently provide access, so neither an empty explicit-grants list nor a successful revoke proves exclusive ownership or complete removal of access.

## Tried and ruled out
“Owner only” overstates what omitting one grant proves. “Rotate” alone overstates variable set: it stores a Conjur value and does not update the credential in its source system. Raw privilege names alone make metadata read and secret-value retrieval easy to confuse.

## Watch out
Unknown vendor privilege names remain inert text with no revoke action. Use a Map for label lookup so names such as constructor cannot resolve inherited object properties. The guided single-line value/path restrictions are CLIHarbor constraints, not universal Conjur limits.

In the code: web/src/platforms/conjur/conjurRuns.tsx shares presentation labels across creation, permission management and migration templates. ConjurCreateSecret.tsx retains separate approved declaration/value/grant steps. ConjurManagePermissions.test.tsx checks raw unknown names; docs/CONJUR_INTEGRATION.md links official evidence reviewed on 2026-11-03. Native Windows and real-tenant acceptance remain separate from fixture browser checks.
