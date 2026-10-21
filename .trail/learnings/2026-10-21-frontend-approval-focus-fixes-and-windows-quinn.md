---
title: Frontend approval/focus fixes and Windows-case Terraform roots
author: Quinn
date: 2026-10-21
branch: dev
cost: { minutes: 18, tokens: 127267 }
touches:
  - internal/webui/static/assets/index-Cvy6aYlr.js
  - internal/webui/static/assets/index-O_F6f7gV.js
  - internal/webui/static/index.html
  - internal/webui/static/web-source.sha256
  - internal/platforms/terraform/platform.go
  - internal/platforms/terraform/platform_test.go
  - QUICKSTART.md
  - README.md
  - docs/CLI_CATALOG.md
  - docs/TERRAFORM_INTEGRATION.md
---

## Decided
- A run submitted with an approval clears the command preview in executeRun's finally: the server consumes approvals, so a lingering checkpoint read "Approved" for a dead ID.
- TaskDiscovery is no longer keyed by taskToolFilter (remount dropped keyboard focus); it re-derives catalogOpen during render when toolFilter changes. The search query intentionally survives a filter change (TaskDiscovery.test asserts it).
- refreshTools uses a request counter; installManagedCLI bumps it so an older refresh cannot overwrite fresh tools.
- AuthenticationPage.cancelCheck reconciles the cancel snapshot (same Get snapshot, events included) via evidenceFromSnapshot + finishAttempt when the run already finished.
- Terraform New accepts a case-only resolved/clean difference on Windows (EvalSymlinks canonicalizes drive + component case) and stores the canonical path. This does NOT relax symlink/junction refusal: a junction resolves to a different path and is still refused.
## Tried and ruled out
- Visually-hidden span for Terraform row button names: accname drops the leading space ("Selectedaws_..."); use aria-label.
## Watch out
- trail check flags many terraform/pack keyword false positives against the Oct 20/21 learnings on this branch; read each, most touch unrelated files.
- TestWindowsRootCaseDifferenceIsNotAJunction only runs on Windows; it has not been executed on a Windows host yet.
