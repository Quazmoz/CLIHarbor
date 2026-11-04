---
title: Browser password invitations require trusted HTTPS before trusting page code
author: Quinn
date: 2026-11-04
branch: dev
id: l-d03f8fa4
scope: repo
status: active
src: agent
touches:
  - README.md
  - cmd/cliharbor/main.go
  - cmd/cliharbor/main_test.go
  - docs/ARCHITECTURE.md
  - docs/AUTHENTICATION.md
  - docs/DECISIONS.md
  - docs/DEVELOPMENT_PLAN.md
  - docs/PRD.md
  - docs/ROADMAP.md
  - docs/SECURITY.md
---

## Decided
App-to-app password invitations pin the receiver's exact temporary TLS public key. Browser-only senders instead need an operator-provided certificate already trusted by their device, with the receiving private IP in its SAN. Both use a separate five-minute receiver; the command/authentication listener stays on loopback. This is the explicitly requested LAN feature, not permission to expose the main router.

## Tried and ruled out
Serving a browser encryption form over plaintext HTTP cannot authenticate its JavaScript against an active LAN attacker. Browser warning bypasses or installing a CA automatically would hide that trust decision. A new PAKE, WebRTC relay or transfer-client dependency was unnecessary for the requested CLIHarbor-to-CLIHarbor and browser-on-LAN scopes. Use standard TLS verification and an explicit trusted invitation channel.

## Watch out
React route tests do not establish that a new URL works after direct navigation: the first production Chrome run returned 404 because the Go embedded handler also has an application-route allowlist. Add the path there and its existing route test; retain direct-navigation acceptance. Cross-compilation and fixture-only Chrome trust do not qualify native Windows networking or the organization's real certificate provisioning.

In the code: internal/passwordshare, internal/server/password_sharing.go, web/src/PasswordSharingPage.tsx, internal/webui/webui.go, docs/PASSWORD_SHARING.md, ADR-042. Local verification: go test -race on the sharing/server/app/launcher packages; CLIHARBOR_BROWSER_E2E=1 tests for the HTTPS sender and production embedded app. Do not put invitation links or passwords in task history, logs or CLI argv.
