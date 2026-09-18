# Architecture Decision Record Index

This file records decisions already made during product discovery so future agents do not accidentally reverse them without evidence.

## ADR-001 — Local browser app instead of desktop shell

**Status:** Accepted.

**Decision:** CLIHarbor runs a local backend and serves a browser UI over loopback rather than using Electron/Tauri as the primary architecture.

**Why:** The desired company adoption flow is “pull/run the repo or invoke a subcommand, then use the browser.” It also makes embedding into an existing company CLI straightforward and avoids shipping a separate desktop runtime.

**Consequences:** Browser/local-server security must be treated seriously. We need loopback binding, secure bootstrap/session handling, origin/host checks, and XSS-safe rendering.

## ADR-002 — Direct executable invocation, not PowerShell/CMD for normal commands

**Status:** Accepted.

**Decision:** If a user normally types `idsec ...` in PowerShell, CLIHarbor resolves `idsec.exe` and launches it directly with an argument vector.

**Why:** PowerShell is usually only locating/starting the binary. Direct invocation reduces quoting ambiguity and shell-injection exposure.

**Exception:** PowerShell/CMD may be used only when the task intentionally targets a script/shell behavior and the pack/security review explicitly allows it.

## ADR-003 — Vendor CLI remains source of truth

**Status:** Accepted.

**Decision:** CLIHarbor wraps the official CLI rather than reimplementing vendor REST APIs for the MVP.

**Why:** It minimizes code, preserves existing auth/profile semantics, lowers approval burden, and keeps the product thin.

## ADR-004 — Authentication delegated to wrapped CLI

**Status:** Accepted.

**Decision:** MVP does not provide its own username/password storage or token cache. Login is vendor-owned.

**Why:** `idsec` already supports interactive auth and OS-keystore token storage. Rebuilding this increases risk without adding core product value.

## ADR-005 — External interactive login before embedded PTY

**Status:** Accepted.

**Decision:** When login needs terminal interaction, launch/attach to the vendor CLI through an external terminal first. Embedded PTY is deferred.

**Why:** It is the smallest secure implementation and avoids secret input/terminal-emulation complexity.

## ADR-006 — Idira/CyberArk first, generic engine underneath

**Status:** Accepted.

**Decision:** Build the first real pack for the concrete internal Idira/CyberArk need. Do not try to support every CLI on day one.

**Why:** This guarantees utility even if broader market adoption never occurs and lets real workflows shape the abstraction.

## ADR-007 — Curated packs before automatic CLI interpretation

**Status:** Accepted.

**Decision:** Runtime behavior is defined by reviewed packs. Automatic `--help`/AI extraction may later help authors draft packs but will not make live production execution decisions.

**Why:** Existing projects such as instagui already pursue automatic extraction. CLIHarbor's differentiation is correctness/security/enterprise trust, not maximal zero-config coverage.

## ADR-008 — Windows first

**Status:** Accepted.

**Decision:** Windows is the first supported platform.

**Why:** It matches the initial environment and keeps early process/auth/browser integration focused.

**Consequence:** Core data models should remain portable, but platform-specific execution/cancellation code may live behind explicit interfaces.

## ADR-009 — Go backend + React/TypeScript frontend

**Status:** Accepted as initial implementation default.

**Decision:** Use Go for the local runtime and React + TypeScript + Vite for the browser UI.

**Why:** Go supports a small self-contained executable, easy static asset embedding, solid Windows process/HTTP support, and future embedding/companion-binary use with an internal CLI.

**Revisit condition:** If the existing company CLI's architecture makes a different implementation materially simpler, preserve the browser/pack/execution contracts while reassessing language choice.

## ADR-010 — No arbitrary shell endpoint

**Status:** Accepted / security invariant.

**Decision:** Browser requests identify pack tasks and typed fields. There is no endpoint that accepts a free-form executable or command string.

**Why:** CLIHarbor should be a safe action/workflow layer, not a browser-exposed shell.

## ADR-011 — Single executable release target

**Status:** Accepted as packaging objective.

**Decision:** Release builds should embed the web frontend into the local runtime where practical.

**Why:** Simplifies enterprise adoption and reduces runtime dependencies. Development may still use Node/Vite tooling.

## ADR-012 — Structured output preferred, raw output preserved

**Status:** Accepted.

**Decision:** Use vendor machine-readable output where reliable, but always preserve raw output as fallback and evidence.

**Why:** Parsed tables improve UX; vendor version changes can break parsers. Silent parser failure must not create false data.

## ADR-013 — Packs are privileged configuration

**Status:** Accepted.

**Decision:** Pack loading is trusted/reviewed and schema validated. Arbitrary remote pack installation is deferred until a signature/trust model exists.

**Why:** Packs control what executables/arguments CLIHarbor may run.

## ADR-014 — Structured output is bounded declarative post-processing

**Status:** Accepted.

**Decision:** A trusted pack may declare only a bounded top-level JSON object composed of named scalar fields for structured browser rendering. Parsing runs after the single authoritative executor invocation, produces a normalized DTO, never feeds execution, and always leaves raw stdout/stderr and run/exit state available. Secret-bearing output and sensitive structured fields are refused in this phase.

**Why:** This improves operator readability without introducing a scripting/template/plugin surface, without allowing CLI output to become command authority, and without creating a second source of truth for process success.

**Security/reliability implications:** Parser bytes, fields, strings, nesting shape, UTF-8, duplicate keys, unknown fields, integer range, and control characters are fail-closed. A non-zero exit cannot be promoted into structured success. Browser rendering uses inert text only.

**Revisit when:** A verified vendor workflow requires nested collections, tables, or secret-aware structured handling that cannot be represented safely by the scalar-card contract.

## How to supersede a decision

Do not silently change an accepted ADR. Add a new ADR section with:

- the old decision being superseded;
- new evidence/requirement;
- security impact;
- migration impact;
- updated docs/tests required.

## ADR-015 — Phase 0 evidence is CLI-only, fixed, bounded, and exportable

**Status:** Accepted.

**Decision:** Work-laptop inventory and Phase 0 help/version evidence collection live on the operator CLI surface, not the browser API. A probe is selectable only by `pack/tool/probe`; executable path and argv come exclusively from validated trusted pack/discovery state. Evidence exports use a strongly typed, bounded, sanitized schema and atomic non-overwriting creation.

**Why:** The first real integration needs factual data from the company-installed CLI versions without turning CLIHarbor into a diagnostic shell or exposing executable authority to browser input.

**Security/reliability implications:** No arbitrary executable/argv input, no shell, no interactive stdin, neutral temporary working directory, minimal child environment, executable identity revalidation, bounded timeout/output, shared platform process-tree ownership (including Windows Job Objects), conservative redaction, no credential-store/environment enumeration, and no browser/session secrets in evidence. Exported probe provenance includes only sanitized fixed argv from trusted declarations; evidence activation is atomic and no-clobber. Discovery-time version probes fail closed on truncated/invalid-UTF-8 output. Raw vendor prose still requires operator review before external sharing because generic redaction cannot prove organization-specific text is non-sensitive.

**Revisit when:** A verified workflow requires a probe that cannot be represented as fixed read-only argv, or evidence requirements exceed the bounded Phase 0 schema.

## ADR-016 — Unsigned CI artifact for controlled work-laptop evaluation

**Status:** Accepted for the evaluation milestone.

**Decision:** CI may produce an unsigned Windows x64 evaluation executable after the normal quality/security gates, without publishing a GitHub Release or claiming code signing.

**Why:** The immediate need is controlled first-environment validation, not public distribution or installer deployment.

**Security/reliability implications:** Application-control policy is an environmental prerequisite. CLIHarbor must not bypass WDAC/AppLocker/SmartScreen/EDR. A blocked unsigned executable requires the organization's approved signing/allowlisting process.

**Revisit when:** Wider enterprise distribution, persistent installation, or production release requires signing/provenance policy.

## ADR-017 — Phase 0 evidence import is inert review, never command authority

**Status:** Accepted.

**Decision:** CLIHarbor may strictly ingest `cliharbor.phase0/v1` files through an operator-only `evidence inspect` command, but imported evidence is permanently inert. The importer validates bounded structure, identity, provenance, state/timestamp consistency, and sanitization before rendering a deterministic review. It has no path into pack loading, command planning, browser APIs, or process execution.

**Why:** Work-laptop evidence needs a safe engineering review gate before it can inform a real vendor pack. Treating arbitrary captured text as an executable definition would collapse the trust boundary created by the Phase 0 collector.

**Security/reliability implications:** Evidence files are untrusted, symlinks/non-regular files and observed read races fail closed, malformed/duplicate/unknown data is rejected, and sensitive/path-like material excluded by the schema cannot silently re-enter through import. Successful validation establishes internal consistency only; it is not a signature/attestation and does not establish file authenticity, claimed source environment, freshness, or vendor semantics beyond what is independently verified.

**Revisit when:** A signed/attested evidence format or organization-approved promotion workflow exists and has an explicit authority model. Even then, model-generated or arbitrary captured text must not gain command authority implicitly.

## ADR-018 — Phase 0 evidence uses detached SHA-256 for transfer integrity only

**Status:** Accepted.

**Decision:** Phase 0 export computes and prints SHA-256 over the exact JSON bytes written. The digest remains outside the evidence schema and must be retained independently if it is to be used as a transfer-integrity check. Evidence inspection may require an expected SHA-256 and must fail before rendering on mismatch.

**Why:** The laptop-to-engineering handoff needs deterministic detection of accidental or unauthorized byte changes without introducing signing keys, certificates, organization-specific PKI, or a false authenticity claim.

**Security/reliability implications:** The same bounded stable file snapshot is hashed and parsed; expected digests are strictly decoded and compared in constant time. SHA-256 is not a signature or attestation. Keeping the digest only beside the evidence file does not establish an independent trust path, and no checksum can promote evidence into executable pack authority.

**Revisit when:** The organization has an approved artifact/evidence signing or attestation mechanism with defined key ownership, verification policy, rotation/revocation, and release integration.


## ADR-019 — Windows evaluation checksums cover executable and trusted pack

**Status:** Accepted.

**Decision:** The Windows x64 evaluation build emits a deterministic root `EVALUATION_SHA256SUMS` manifest covering the evaluation executable and the explicitly trusted Phase 0 pack. CI recomputes every required entry before artifact upload. The existing `bin/SHA256SUMS` remains executable-only for local-build compatibility.

**Why:** The executable and pack jointly define the Phase 0 execution authority. Hashing only the binary left a substitution gap where the shipped trusted pack could change independently after qualification.

**Security/reliability implications:** Manifest generation rejects files outside the repository root, duplicate entries, symlinks, and non-regular files; relative paths are normalized and sorted for deterministic output. A matching manifest detects byte changes to the covered files but is not a signature, publisher proof, build attestation, or host attestation. The GitHub artifact ZIP digest is separate archive-level evidence.

**Revisit when:** The evaluation bundle contains additional privileged configuration, or an organization-approved signing/attestation model supersedes checksum-only integrity.


## ADR-020 — Reject foreign browser origins on reads and streams

**Status:** Accepted.

**Decision:** The loopback HTTP boundary rejects every request that carries a non-empty `Origin` different from CLIHarbor's exact bound origin. State-changing requests continue to require an explicit exact application `Origin` and the per-session CSRF token. Origin-less GET requests remain valid for local non-browser clients and still require route/session authorization.

**Why:** Read-only endpoints are not side-effect authority, but authenticated SSE observers consume bounded server capacity and expose run output. Relying only on CORS/browser response visibility leaves a hostile-origin request able to reach the local authenticated surface in cases where browser cookie/site rules permit the request. Exact server-side rejection gives reads, streams, and mutations one deterministic foreign-origin boundary while preserving CLI/local-client diagnostics that do not send an Origin header.

**Security/reliability implications:** Foreign-origin GET/SSE traffic fails before session/API handling; mutation protection remains exact Origin plus CSRF rather than Origin alone. Host validation remains independent and exact. This does not claim protection from a malicious local process that can operate outside browser origin semantics, and it does not expand browser execution authority.

**Verification:** Unit tests cover hostile and `null` origins on authenticated status/SSE plus valid same-origin and origin-less reads. The production embedded-server headless-browser gate covers hostile-origin EventSource and form mutation attempts, Host rejection, one-time bootstrap, and same-origin CSRF behavior.

**Revisit when:** Remote access, a non-browser client requiring an `Origin` header, multiple legitimate UI origins, or a different browser-session transport is introduced.


## ADR-021 — One packaged checksum authority for Windows evaluation artifacts

**Date:** 2026-09-18  
**Status:** Accepted.

### Context

ADR-019 established that the Windows evaluation boundary includes both the executable and the trusted Phase 0 pack, but the implementation still packaged the ordinary executable-only `bin/SHA256SUMS` beside the broader root `EVALUATION_SHA256SUMS`. Requiring operators to compare both surfaces created avoidable authority ambiguity even though the root manifest covered the stronger boundary.

### Decision

`EVALUATION_SHA256SUMS` is the sole checksum manifest packaged with a Windows evaluation artifact. It must contain exactly one canonical entry for the evaluation executable and exactly one canonical entry for the trusted Phase 0 pack.

`bin/SHA256SUMS` remains supported only for ordinary local `go-build`/`build` compatibility. `windows-eval` invalidates that generated compatibility manifest before producing the evaluation bundle, and the evaluation verifier fails if it is present.

The repository-owned `verify-windows-eval` task is the common local/CI verification contract. CI runs it after build and again immediately before uploading exactly the authoritative manifest and its two covered privileged files.

### Alternatives considered

1. Keep both checksum manifests in the evaluation artifact and require CI to prove their executable digests agree.
2. Remove `bin/SHA256SUMS` from all build modes.
3. Introduce signing/attestation as part of this milestone.

### Rationale

One manifest removes an avoidable duplicate source of integrity authority while preserving existing local-build compatibility. Reusing one deterministic verifier also reduces shell-specific validation drift. Signing and attestation solve a different identity/provenance problem and are not required to make the current checksum boundary unambiguous.

### Consequences

Positive:

- operators have one packaged privileged-file checksum authority;
- both privileged evaluation files remain covered;
- stale cross-build checksum manifests are invalidated;
- CI and local verification use the same path/entry/digest rules;
- upload configuration contains only the manifest and the files it covers.

Negative:

- a user switching build modes may observe generated checksum files being removed because they no longer describe the active build mode;
- checksum verification still cannot establish publisher, signer, host, or build-system identity.

### Security / reliability implications

- manifest parsing rejects malformed digests, non-canonical paths, traversal, backslashes, drive-like paths, unsorted entries, and case-insensitive aliases appropriate to the Windows target;
- privileged files and the manifest must be regular non-symlink files;
- checksum manifest publication stages and syncs bytes before platform-specific atomic no-replace activation; stale manifests are invalidated explicitly by the owning build mode, and concurrent same-destination writers fail closed rather than replacing one another;
- file hashing/read helpers re-read the same open file and compare identity/size/modification metadata to detect observed concurrent mutation;
- verification recomputes the required hashes from the on-disk files and rejects unexpected entry counts or a present compatibility manifest;
- GitHub's artifact archive digest remains separate archive-level integrity evidence;
- checksum/manifests remain inert data and never become executable, pack, browser, or workflow authority.

### Verification

- deterministic unit/regression coverage for exact entries, ordering, duplicate/alias rejection, traversal/non-canonical path rejection, symlink rejection, stale compatibility-manifest rejection, content-change mismatch, and successful regeneration;
- Windows/Linux quality jobs exercise the shared Go task package;
- the Windows evaluation CI job runs `verify-windows-eval` on the packaged files immediately before upload.

### Revisit when

- additional privileged files become part of the Windows evaluation boundary;
- an organization-approved signing or attestation mechanism supersedes checksum-only integrity;
- ordinary local-build compatibility no longer requires `bin/SHA256SUMS`.

### Supersedes / superseded by

- Refines ADR-019 by superseding only its ambiguous dual-manifest evaluation-packaging interpretation. ADR-019's requirement that both the executable and trusted Phase 0 pack be integrity-covered remains in force.


## ADR-022 — Pin and qualify Windows evaluation build inputs

**Date:** 2026-09-18  
**Status:** Accepted.

### Context

The evaluation artifact previously used `-trimpath` and disabled cgo, but the repository task still inherited the caller's Go configuration. Per-user `go env -w` values, `GOFLAGS`, workspace selection, toolchain auto-switching, architecture level, FIPS module selection, or an inherited `GOROOT` could therefore become undeclared build inputs. A checksum can faithfully identify such a build without proving that it was built under the intended configuration.

### Decision

The qualified Windows evaluation path must:

- require the exact Go patch release in `.go-version`;
- force `GOTOOLCHAIN=local`;
- disable `GOENV` and `GOWORK`;
- clear inherited `GOFLAGS`, `GOEXPERIMENT`, `GODEBUG`, and `GOROOT`;
- pin `GOAMD64=v1`, `GOFIPS140=off`, and `CGO_ENABLED=0`;
- use private `GOCACHE` and `GOTMPDIR` directories for every qualified build so the double-build gate does not share compiled-object cache or caller-selected temporary work;
- retain explicit `GOOS=windows` and `GOARCH=amd64`;
- replace inherited environment entries rather than appending duplicate effective keys.

CI resolves Go from `.go-version`. After producing the upload candidate it runs `verify-windows-eval-repro`, which first verifies that candidate, stages the trusted Phase 0 pack into two distinct temporary roots, builds the evaluation executable twice, verifies each staged bundle with the normal authoritative verifier, and requires the candidate plus both rebuilds to have byte-identical `EVALUATION_SHA256SUMS` files.

### Rationale

The Go toolchain documents `GOENV` as a persistent user configuration source, `GOTOOLCHAIN` as capable of selecting or downloading another toolchain, and `GOFIPS140`/`GOAMD64` as build-affecting inputs. Go's reproducible-build guidance recommends cgo-disabled `-trimpath` builds and explicitly notes that unintended environment inputs can leak into outputs. Pinning these inputs makes the evaluation artifact contract reviewable and reduces local/CI drift.

### Consequences

Positive:

- evaluation builds fail closed on the wrong Go patch release;
- per-user Go configuration/workspaces/default flags cannot silently change the qualified build;
- CI workflow YAML no longer duplicates the Go patch version;
- two isolated same-checkout rebuilds must agree before packaging continues;
- the reproduction task does not publish or replace the real evaluation artifact.

Negative:

- developers need the exact `.go-version` toolchain to create evaluation builds;
- organization-specific FIPS builds are intentionally not represented by the generic evaluation artifact and would require a separate reviewed build profile;
- two-build equality on one runner is weaker than independent cross-machine reproducibility.

### Security / reliability implications

The deterministic-rebuild gate reduces undeclared build inputs but does not authenticate the builder, source checkout, runner, signer, or target host. It is not SLSA provenance, artifact attestation, or code signing. A future signed/FIPS-specific/enterprise release profile must define its own exact toolchain and build-input contract rather than weakening this evaluation profile.

### Verification

- unit tests cover case-insensitive environment replacement, exact `.go-version` parsing, pinned evaluation settings, and stable trusted-pack copying;
- every normal quality job compiles/tests the repository task package on Windows and Linux;
- the Windows evaluation job executes `verify-windows-eval-repro` before the normal build, self-test, evidence smoke flow, final bundle verification, and artifact upload.

### Revisit when

- the qualified target architecture or FIPS policy changes;
- the project adopts independent rebuilders, signed provenance/attestations, or code signing;
- another release profile needs intentionally different controlled Go build inputs.
