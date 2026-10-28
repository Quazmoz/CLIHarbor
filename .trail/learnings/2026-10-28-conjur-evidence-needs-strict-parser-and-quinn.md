---
title: Conjur evidence needs strict parser and exact-target checks
author: Quinn
date: 2026-10-28
branch: dev
id: l-1ad1356b
scope: repo
status: active
src: agent
touches:
  - docs/SECURITY.md
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - internal/webui/static/assets/index-BU7cb0wT.js
  - internal/webui/static/assets/index-CS_CyvCb.css
  - internal/webui/static/index.html
  - internal/webui/static/web-source.sha256
  - test/browser_e2e.mjs
  - web/src/ConjurDedicatedJourney.test.tsx
  - web/src/platforms/conjur/ConjurAccessExplorer.test.tsx
---

## Decided
All Conjur mutation existence checks must reuse conjurRuns.variableExists, extracted from creation. Backend parser rejection or absence of reviewed boolean evidence is a refusal, even when raw stdout looks like valid existence JSON. Dedicated preview validation also compares the displayed target against the authorized task's targetInput. Permission readback must contain the exact requested variable ID before it can enable grants or revokes.

## Tried and ruled out
Using runRead plus parseExists in the new maintenance panel bypassed creation's strict structured-evidence requirement. JSON.parse alone is also insufficient for raw identity or permission objects: duplicate fields, including escaped-equivalent keys and nested grant fields, silently overwrite earlier evidence. parseConjurObject keeps native JSON grammar validation, then checks bounded tokens for duplicate object keys before interpretation; it is not a second JSON grammar parser.

## Watch out
A controlled native select with a saved value absent from its options can display the default while submitting the old role. RoleOptions must retain the selected value with an explicit not-currently-listed label during missing/changing inventory. ConjurIDSelect manual entry needs focus on the new textbox and field errors attached to that textbox. A permission table inside the clipped action-card container needs its own labeled, keyboard-focusable horizontal scroller; document overflow alone misses clipped Revoke controls. Acceptance now reviews Revoke at 320px without applying it. Windows and real-tenant qualification remain separate.
