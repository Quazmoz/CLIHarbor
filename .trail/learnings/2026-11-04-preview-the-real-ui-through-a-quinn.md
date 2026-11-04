---
title: "Preview the real UI through a capturing launcher, not a second serve"
author: Quinn
date: 2026-11-04
branch: dev
cost: { minutes: 10, tokens: 155026 }
id: l-4f273581
scope: repo
status: active
src: agent
touches:
  - web/src/App.tsx
  - web/src/OverviewPage.test.tsx
---

## Decided
To look at the production UI (screenshots, UX review) while the operator's own CLIHarbor is running, start the app in-process with the browser E2E fixtures and a launcher that writes the one-time bootstrap URL to a file, then drive headless Chrome over CDP. That reuses realistic Conjur + integration fixture tools without touching the operator's state or browser.

## Tried and ruled out
A second `serve` fails at startup: the mutation audit trail lock is already held ("audit trail already locked or inaccessible"). Even with an isolated HOME, serve hands the one-time bootstrap URL to /usr/bin/open on macOS (absolute path, cannot be shadowed), so it opens and consumes it in the operator's default browser. The URL is only printed when that launch fails.

## Watch out
The bootstrap URL is single-use: do every page visit in one browser session, and restart the harness after rebuilding the bundle (the test binary embeds internal/webui/static at compile time). Use history.pushState + a popstate event to change routes without reloading. Delete the temporary test file afterwards; it must never be committed.

In the code: temporary internal/app/zz_*_test.go calling executionFixtureConfigForTest + configureBrowserConjurFixture, setting options.AuditPath to a t.TempDir() path and options.Browser = browser.LauncherFunc(write URL to file), then Run(ctx, options). Rebuild the UI first with `go run ./tools/task web-build`. Chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless=new --remote-debugging-port=0, read DevToolsActivePort from the profile dir.
