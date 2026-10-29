---
title: "Cancel Conjur dropdown reads per load, preserve mutation reconciliation"
author: Quinn
date: 2026-10-29
branch: dev
cost: { minutes: 1, tokens: 3906 }
id: l-6ad3f04f
scope: repo
status: active
src: agent
touches:
  - web/src/platforms/conjur/conjurRuns.tsx
---

## Decided
Conjur dropdown inventory in web/src/platforms/conjur/conjurRuns.tsx uses one AbortController per load. Scope-bound results hide old options immediately when account, inventory availability or requested kinds change. Cleanup aborts the read chain and best-effort cancels only an acknowledged running read; an old finally block must not clear the newer controller's single-flight guard.

## Tried and ruled out
A shared alive boolean is insufficient: React StrictMode cleanup/setup can make it true again before an old request completes, and listIDs can continue paging inside an awaited kind after unmount. Aborting all completedRun callers on navigation was rejected because approved mutations must retain terminal reconciliation and the shared activity lock. Optional read signals close SSE and reconciliation resources without changing mutation callers.

## Watch out
A lost run-start acknowledgement gives no run ID to cancel; the backend still bounds the read, and History is the evidence source. A delayed acknowledgement that does return a running ID must be cancelled even after cleanup. conjurRuns.test.tsx enables root-level reactStrictMode through the Testing Library option; merely nesting StrictMode in a wrapper does not guarantee initial effect replay in the pinned React version.
