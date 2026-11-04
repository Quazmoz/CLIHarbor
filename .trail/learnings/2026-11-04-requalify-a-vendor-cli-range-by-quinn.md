---
title: Requalify a vendor CLI range by diffing only the surfaces the pack invokes
author: Quinn
date: 2026-11-04
branch: dev
cost: { minutes: 19, tokens: 224416 }
id: l-b977ed5a
scope: repo
status: active
src: agent
touches:
  - README.md
  - docs/CLI_CATALOG.md
  - docs/IDIRA_PAM.md
  - internal/packs/idira_pack_test.go
  - packs/idira/idira-pam.yaml
  - docs/PASSWORD_SHARING.md
  - docs/UX.md
  - internal/apperror/error.go
  - internal/passwordshare/remote.go
  - internal/passwordshare/sender.css
---

## Decided
Widen a first-party pack's versionConstraint to a new upstream minor only after
reviewing the upstream source diff (CLI and the SDK version its go.mod pins) for
each surface the pack invokes or parses: the version/status actions and their
docs (exit codes), each list action's schema/filter/model files, and anything
that writes to stdout. Bump the pack version, keep the next minor refused, and
add a semver admission check, not just a string comparison.

## Tried and ruled out
Running the downloaded vendor binary's --help probes locally to confirm flags:
the session's auto-mode permission classifier blocked executing externally
downloaded code. Source review of the schema struct tags (flags are generated
from them) was used instead and the gap was reported as an open gate.

## Watch out
idsec v0.14 moved failures, warnings and the SDK logger from stdout to stderr and
made failed exec actions exit non-zero; older v0.13 could print failures on stdout
with exit 0, which CLIHarbor's strict stdout guard rejects as malformed (fail
closed). Live-tenant and native Windows acceptance are still separate gates.

In the code: packs/idira/idira-pam.yaml (0.2.0, >=0.13.0-0 <0.15.0-0),
internal/packs/idira_pack_test.go, docs/IDIRA_PAM.md "v0.14 requalification".
Compare with: gh api repos/cyberark/<repo>/compare/<old>...<new>.
