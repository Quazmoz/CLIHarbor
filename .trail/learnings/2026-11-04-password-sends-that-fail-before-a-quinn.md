---
title: "Password sends that fail before a verified connection are definitive, and receiver expiry must re-check the wall clock"
author: Quinn
date: 2026-11-04
branch: dev
cost: { minutes: 7, tokens: 135270 }
id: l-e30bba51
scope: repo
status: active
src: agent
touches:
  - web/src/api/errors.ts
  - internal/passwordshare/share.go
  - internal/server/password_sharing.go
  - internal/apperror/error.go
---

## Decided
An app-to-app password send that fails before the HTTP transport hands back a connection (dial refused/timeout, TLS handshake failure, pin/IP/validity mismatch) cannot have written any request bytes, so it is reported as "nothing was sent" (unreachable, or receiver mismatch) instead of "unconfirmed". Only failures after a connection exists stay unconfirmed and are never retried. A pin mismatch is a security signal and gets its own message telling the sender not to retry that invitation.
Temporary receiver certificates are valid one hour either side of creation: the ephemeral-key pin and the five-minute receiver deadline bound the transfer, and a one-minute window broke transfers between laptops with ordinary clock drift.

## Tried and ruled out
Detecting the failure kind from the returned error chain (errors.Is on TLS/url errors) depends on how net/http and crypto/tls wrap errors across Go versions. Flags set inside our own VerifyConnection and an httptrace GotConn callback are exact.
A single ttl-long expiry timer: Go runtime timers run on the monotonic clock, which pauses during macOS/Linux suspend, so after a laptop wakes the password buffer and LAN listener lived on for up to another full TTL unless the UI polled.

## Watch out
GotConn fires only after TCP + verified TLS succeed (HTTP/1.1, keep-alives disabled, so no transport-level retry of the POST). If HTTP/2 or keep-alives are ever enabled for the sender, re-check that boundary.
New server error codes must be added to web/src/api/errors.ts with the same category, or the UI silently degrades them to the generic "not confirmed" message.

In the code: internal/passwordshare/share.go (Send classification, clockSkew, expire re-check every ttl/60), internal/server/password_sharing.go, internal/apperror/error.go, web/src/api/errors.ts. Regressions: TestUnreachableAndClockSkewedSends, TestWallClockExpiryAfterSuspendWithoutUI, TestPinnedTLSRefuses..., and the page test for definitive send refusals; each was confirmed to fail without its fix.
