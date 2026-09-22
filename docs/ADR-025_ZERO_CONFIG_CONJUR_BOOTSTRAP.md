# ADR-025 — Zero-config first-party Conjur bootstrap

**Date:** 2026-09-22  
**Status:** Accepted.

## Context

The first real Conjur integration originally required two user-managed prerequisites after downloading CLIHarbor:

1. obtain the real Conjur pack as a separate CI artifact and pass it with `--pack-file`; and
2. separately ensure an approved compatible `conjur.exe` was installed or manually provide `--tool-path`.

That preserved a strict trust boundary but made the normal user path unnecessarily operational. CyberArk's official `conjur-cli-go` v9.3.1 release publishes a standalone Windows amd64 executable with a release-recorded SHA-256, and CLIHarbor already has a reviewed version-gated first-party pack.

The product goal is therefore to remove avoidable setup steps without turning CLIHarbor into a generic package manager, weakening enterprise policy, or granting network content implicit execution authority.

## Decision

### Embed the reviewed first-party pack

The source-of-truth pack remains reviewable at:

```text
packs/conjur/conjur-v9.yaml
```

The same bytes are compiled into CLIHarbor and loaded through the normal hardened built-in pack loader for default `serve` and `doctor` startup.

Normal users no longer need a separate Conjur pack download or `--pack-file` argument.

Explicit local pack sources remain supported for advanced/operator/development flows and replace the default-pack selection for that process.

### Provision only a genuinely missing first-party dependency

Default `serve` first performs normal tool discovery.

Automatic Conjur provisioning is eligible only when:

- the default embedded first-party pack is in use;
- automatic setup is enabled;
- the exact `cyberark-conjur-v9/conjur` tool state is `missing`; and
- no explicit backend tool-path override was supplied.

CLIHarbor does not automatically replace or repair discovery states that are ambiguous, incompatible, probe-failed, identity-failed, unsupported-platform, or invalid-override.

### Pin one exact reviewed CyberArk Windows artifact

The managed fallback is:

```text
release: CyberArk conjur-cli-go v9.3.1
asset: conjur_windows_amd64.exe
size: 21,950,000 bytes
SHA-256: da2b31ca00b8faaefb8e1fe891563b5cc07c39460e776fb42e7f89b05d3ee4f6
```

The runtime does not perform `latest` lookup or accept a browser/operator supplied download URL/hash for the automatic path.

Production download behavior is HTTPS-only, redirect bounded, origin restricted to GitHub/GitHubusercontent, response/body bounded, staged, exact-size/SHA verified before activation, synced, atomically renamed where the platform permits, and reverified after activation.

Cached managed copies are reverified before reuse. An invalid managed copy is removed rather than executed.

### Keep installation current-user scoped

The managed executable lives under CLIHarbor's current-user cache, versioned by vendor CLI version.

CLIHarbor does not:

- write Program Files;
- modify machine PATH;
- write machine-wide registry/configuration;
- install a service, driver, scheduled task, certificate, browser extension, or startup item;
- request elevation intentionally.

The managed path becomes a backend-only tool override for that process and then must pass the ordinary Conjur version/discovery/executable-identity contract before any task can execute.

### Keep enterprise policy authoritative

`--no-auto-setup` disables automatic dependency network activity while retaining the embedded pack.

An explicit approved `--tool-path` remains authoritative and is never superseded by managed bootstrap.

A proxy, EDR, AppLocker, WDAC, SmartScreen, firewall, browser, or other policy block is surfaced as a setup/environment constraint. CLIHarbor does not disable or bypass it.

### Keep vendor authentication separate

Installing the Conjur executable does not configure or authenticate a Conjur account.

Read-only browser tasks continue to use the existing `vendor-session` contract. CLIHarbor does not collect or persist passwords, MFA values, API keys, or vendor access/refresh tokens.

## Alternatives considered

### Continue requiring a separate pack artifact

Rejected for the normal path because the reviewed pack is already part of CLIHarbor's trusted source tree and can be embedded in the qualified executable without creating remote pack authority.

### Require users/IT to preinstall Conjur in every case

Retained as a valid enterprise path, but rejected as the only path because the official release provides an exact standalone per-user-compatible executable and many evaluation/developer machines do not need machine-wide installation.

### Bundle the Conjur executable inside CLIHarbor

Rejected for now. It would significantly enlarge every CLIHarbor artifact, couple vendor binary redistribution to every build, and obscure the independent vendor artifact provenance. Conditional pinned download keeps the primary CLIHarbor artifact smaller and avoids vendor bytes when an approved compatible corporate installation already exists.

### Download the latest Conjur release dynamically

Rejected. Mutable release selection would allow upstream changes to alter executable authority without a CLIHarbor code review/version bump.

### Build a generic package-manager/plugin installer

Rejected. Automatic dependency installation is privileged supply-chain behavior and must remain explicit per reviewed tool/version/platform rather than accepting arbitrary manifests, URLs, package names, scripts, or install commands.

### Automatically replace incompatible or ambiguous installations

Rejected. Those states contain unresolved operator/policy information. Replacing them could hide a corporate installation decision or create a confused-deputy/policy-bypass path.

## Consequences

Positive:

- normal Windows setup becomes one CLIHarbor artifact plus one no-argument product launch after preflight;
- the trusted Conjur pack no longer requires separate transfer/configuration;
- a genuinely absent Conjur dependency can be satisfied without administrator credentials;
- compatible corporate installations remain preferred;
- exact reviewed vendor bytes are independently integrity checked;
- explicit enterprise opt-out and operator overrides remain available;
- existing planner/executor/auth security boundaries are unchanged.

Negative:

- default `serve` may perform outbound HTTPS when Conjur is missing;
- first startup may take longer while the pinned vendor binary downloads;
- GitHub/vendor download availability and organization proxy policy can affect zero-config setup;
- current automatic bootstrap supports only Windows amd64 Conjur v9.3.1;
- hash pinning is exact-byte integrity, not independent publisher attestation or organization approval.

## Security and reliability implications

- network responses are untrusted until exact digest verification succeeds;
- managed cached files are also untrusted until reverified;
- automatic setup never gains generic command/pack/browser authority;
- only `missing` is eligible, preventing installer behavior from becoming an ambiguity/incompatibility repair bypass;
- no failed/substituted/oversized download is activated;
- explicit operator path selection takes precedence;
- ordinary version and executable-identity controls remain mandatory after bootstrap;
- credentials remain vendor-owned;
- enterprise application/network controls remain authoritative.

## Verification

Regression/CI coverage includes:

- embedded Conjur pack loading;
- default-pack versus explicit-pack behavior;
- automatic provisioning eligibility limited to exactly `missing` and not explicitly overridden;
- successful download, exact digest verification and cached reuse;
- same-size wrong-hash managed-copy repair;
- digest mismatch with no activated target;
- oversized response rejection;
- unapproved redirect rejection;
- managed-target symlink replacement without following/modifying the external target where the platform permits symlink testing;
- unsupported platform/unmanaged-tool no-op behavior;
- Windows/Linux formatting, vet, unit tests and final builds;
- race detector and dependency/vulnerability scan;
- production embedded-browser E2E;
- Windows evaluation qualification;
- Windows `doctor` smoke proving the evaluation executable can load its embedded first-party Conjur pack without auto-download.

## Revisit when

- CyberArk Conjur 9.3.1 is no longer the reviewed baseline;
- Windows arm64 or another platform becomes a supported zero-config target;
- the organization adopts mandatory Authenticode publisher verification, signed provenance or artifact attestation;
- CyberArk changes distribution/licensing requirements for the standalone binary;
- a second dependency is proposed for automatic provisioning;
- managed dependency updates need an explicit user-controlled update/rollback policy;
- first-start network latency requires a reviewed asynchronous setup UX rather than synchronous startup provisioning.
