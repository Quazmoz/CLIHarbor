---
title: "Shared secrets may be multi-line up to 16 KiB; the receiver alone decides, and the protocol stays v=1"
author: Quinn
date: 2026-11-04
branch: dev
cost: { minutes: 8, tokens: 158874 }
id: l-5e74badf
scope: repo
status: active
src: agent
touches:
  - internal/passwordshare/share.go
  - web/src/api/passwordSharing.ts
---

## Decided
LAN sharing carries multi-line secrets (PEM keys and chains, SSH keys, JSON service-account files) as well as passwords. One limit, 16 KiB, everywhere: it fits a 4096-bit RSA PEM key plus a three-certificate chain (~10 KiB) or a cloud JSON key (~2.5 KiB). LF and tab are the only control characters allowed; CRLF becomes LF in place (no second copy of the secret) on both sender and receiver. Invitations stay v=1 with the strict 4-field fragment: the receiver alone decides what it accepts, and an older receiver's 400 is already reported as definitive (nothing stored).
Multi-line entry is an explicit, unmasked choice in both senders, and the UI says it is shown on screen. Switching modes clears the field.

## Tried and ruled out
Pasting a key into the masked field: browsers strip line breaks from input type=password, so a PEM arrives silently corrupted. That is why the multi-line mode is a separate text area, not a looser check on the masked field.
Raising the shared 64 KiB local JSON body cap: not needed. The app's JSON.stringify at most doubles the value (newline, tab, quote, backslash become two bytes), so 2 x 16 KiB plus a 1 KiB invitation fits. A client that escapes every character as \uXXXX would not fit, and nothing here sends that.

## Watch out
Changing the limit means changing all of these together: MaxPasswordBytes (Go sender and receiver, LAN MaxBytesReader), sender.js and sender.html maxlength, and MAX_PASSWORD_BYTES/acceptablePassword in the web API module. Above 32 KiB the escaped JSON overflows the 64 KiB cap; the user asked to be consulted before going above 64 KiB, before a protocol version change, and before renaming "password" to "secret".

In the code: internal/passwordshare/share.go normalizePassword, remote.go, sender.js, web/src/api/passwordSharing.ts. Regressions: TestMultiLineSecretsNormalizeAndOtherControlsStayRefused, TestOlderReceiverRefusingMultiLineIsDefinitive, TestPasswordSendBodyCapFitsEscapedMaximumValue (fails if the limits disagree), and the two multi-line page tests.
