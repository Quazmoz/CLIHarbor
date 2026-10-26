---
title: Busy feedback follows workflow state; spinner CSS must replace button icons
author: Quinn
date: 2026-10-26
branch: dev
id: l-205d1710
scope: repo
status: active
src: agent
touches:
  - docs/TEST_STRATEGY.md
  - docs/UX.md
  - internal/webui/static/assets/index-40YiPHUT.css
  - internal/webui/static/assets/index-B4QKo_xU.js
  - internal/webui/static/index.html
  - internal/webui/static/web-source.sha256
  - test/browser_e2e.mjs
  - web/src/App.tsx
  - web/src/AppFeatures.test.tsx
  - web/src/platforms/conjur/ConjurCreateSecret.test.tsx
---

## Decided
- Keep working feedback outside approval-card conditionals in web/src/platforms/conjur/ConjurCreateSecret.tsx and TerraformStateRemoval.tsx: a one-use approval is consumed and its card disappears before the CLI finishes. Disappearing approval UI is not completion evidence.
- WorkingStatus.tsx follows each workflow's existing pending/running state, not global fetch activity. A successful run-start POST can return while the CLI still runs; lost SSE does not mean completion. Keep mutation retries explicit.
## Tried and ruled out
- Adding spinner borders/animation to busy buttons without resetting their existing pseudo-icon styles. Browser screenshots showed a rotating filled shape because .run-button::before contributed background and clip-path. Reset both for aria-busy buttons; browser_e2e.mjs checks their computed values, since jsdom tests passed despite the visual defect.
## Watch out
- Preserve synchronous duplicate-submit guards before clearing permission approval/access state. Native disabled buttons are feedback; they do not replace those guards or backend one-use approvals.
- Pending UI must not announce or persist secret values. Use actual stage names and indeterminate motion, never invented completion percentages; respect reduced motion.
