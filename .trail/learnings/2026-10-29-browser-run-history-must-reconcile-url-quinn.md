---
title: Browser run history must reconcile URL selection independently of list reads
author: Quinn
date: 2026-10-29
branch: dev
cost: { minutes: 1, tokens: 3906 }
id: l-29c2bfbe
scope: repo
status: active
src: agent
touches:
  - web/src/App.tsx
  - web/src/RunsPage.tsx
  - web/src/TaskSwitcher.tsx
  - test/browser_e2e.mjs
---

## Decided
App.tsx owns run selection in /runs?run=<id> through the existing navigate function and one requestedRunFromLocation parser for initial load and popstate. RunsPage delegates row selections to that owner. Duplicate run parameters select nothing. Returning to the bare history route clears abandoned detail. List metadata and exact run evidence are independent reads, so a successful direct-run response must remain visible even if the list request fails.

## Tried and ruled out
Reading the query only in the initial useState initializer leaves Back/Forward on the same /runs route displaying the previous run. Setting requestedRun from Activity alone also leaves the URL behind the selection. Changing only the visible ID would be worse: existing output could be misattributed. AppNavigation.test.tsx holds a detail response across Back and verifies it cannot restore abandoned evidence; the Chrome comparison journey traverses real selected-run URLs without another command start.

## Watch out
Native HTMLDialogElement.close queues a close event. TaskSwitcher's effect cleanup can close then reopen the same element under root StrictMode before that event arrives; blindly forwarding onClose dismisses the reopened search. Guard the dialog's current open state. The old synchronous jsdom close fake hid the ordering, so both an explicitly queued test event and real Chrome coverage are required. Mutation navigation warnings and backend approvals remain authoritative; these changes only navigate or read evidence.
