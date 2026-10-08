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
- the Windows evaluation job builds and verifies the candidate, executes `verify-windows-eval-repro` to compare it with two isolated rebuilds, then continues through self-test, evidence smoke flow, final bundle verification, and artifact upload.

### Revisit when

- the qualified target architecture or FIPS policy changes;
- the project adopts independent rebuilders, signed provenance/attestations, or code signing;
- another release profile needs intentionally different controlled Go build inputs.


## ADR-023 — Make support diagnostics an allowlisted, deterministic export

**Date:** 2026-09-18  
**Status:** Accepted.

### Context

Operator troubleshooting needs a shareable CLIHarbor support artifact, but ordinary `doctor` output can contain executable/candidate paths and arbitrary discovery prose. A generic log/filesystem scraper followed by best-effort regex redaction would make sensitive source data part of the primary design and would be difficult to prove complete.

### Decision

Add `cliharbor diagnostics export <output>` with schema `cliharbor.diagnostics/v1`.

The bundle is constructed only from approved bounded metadata fields: build/runtime identity, pack ID/version, tool ID/status/semantic version/candidate count, non-path configuration mode/counts, and aggregate readiness counts. It has no representation for command output, argv, environment values, executable/candidate paths, pack source paths, browser/session state, arbitrary diagnostics prose, or credential material.

The serialization contains no timestamp and no maps, validates stable ordering, is globally size bounded, and is written through private same-directory staging plus atomic/no-replace activation. Existing/symlink/non-regular targets fail closed; Windows also rejects a reparse-point export parent at the checked boundary. The command does not upload or transmit the file.

### Alternatives considered

1. Scrape `doctor`, logs, environment, and filesystem state then regex-redact secrets.
2. Reuse Phase 0 evidence as the support artifact.
3. Emit diagnostics only to stdout.

### Rationale

An allowlisted DTO prevents disallowed data from entering the artifact at all and keeps diagnostics independent from vendor output semantics. A separate schema avoids weakening Phase 0 evidence provenance requirements. Explicit deterministic file export is easier to review, hash, compare, and transfer than terminal output.

### Consequences

Positive:

- support metadata is useful without making paths/output/environment part of the shareable artifact;
- identical approved runtime state serializes identically;
- no-clobber publication and bounded output reduce partial-write/race/resource risks;
- diagnostic data has no import path and cannot become execution authority.

Negative:

- the bundle intentionally contains less detail than local `doctor`;
- troubleshooting that genuinely requires exact paths or vendor output still needs local operator review and targeted handling;
- the file mode does not claim Windows ACL hardening beyond operating-system semantics.

### Security / reliability implications

- confidentiality comes from schema allowlisting and semantic validation, not an ever-growing redaction regex set;
- build/tool identity strings are character/length bounded before serialization;
- command output, browser secrets, environment values, and filesystem authority are structurally absent;
- cancellation before activation leaves no published partial artifact;
- concurrent exports to one destination allow at most one successful publisher;
- SHA-256 is byte-integrity metadata, not authentication or attestation.

### Verification

- deterministic serialization/schema tests;
- source-sentinel regression tests proving pack source paths, executable/candidate paths, discovery messages, environment secrets, and output-like strings do not enter the DTO;
- traversal, existing-file, symlink/non-regular target, cancellation cleanup, Unicode-path, private-mode where portable, and concurrent no-clobber tests;
- Windows-specific no-replace activation coverage;
- normal Windows/Linux CI, race detector, vet, formatting, and repository quality gates.

### Revisit when

- a support workflow needs additional metadata: add fields only after proving they are non-sensitive and bounded;
- enterprise policy requires encrypted/signed diagnostic artifacts;
- a future authenticated upload transport is proposed; transport must be a separate explicit authority boundary.

### Supersedes / superseded by

- Does not supersede Phase 0 evidence ADRs; support diagnostics and vendor evidence serve different trust/provenance purposes.


## ADR-024 — Browser failures use a closed typed operator contract

**Date:** 2026-09-19  
**Status:** Accepted.

### Context

CLIHarbor already prevented executable paths and argv from entering normal browser run snapshots, but browser-facing failures were inconsistent. HTTP routes returned short string codes, the run manager collapsed distinct planner failures, executor failure reason was lost from terminal run state, and the React client converted failures into HTTP-status prose. That made remediation inconsistent, encouraged future string matching, and left stale UI after retained-run eviction.

The browser is an untrusted presentation boundary. Internal Go errors, discovery paths/candidates, process details, session/CSRF material, and future vendor error prose must not become error metadata merely because they are useful for local debugging.

### Decision

Introduce a narrow `internal/apperror` contract for the current browser/runtime boundary. A browser-safe failure contains:

- stable machine-readable `code`;
- bounded `category`;
- reviewed safe `message`;
- optional reviewed `remediation`;
- explicit `retryable`;
- optional validated task-field association limited to `packId`, `commandId`, or `values.<input-id>`.

Planner and executor errors remain richer internal types. The run manager maps only material UX distinctions into the operator contract: invalid task input, unavailable tool, stale/replaced executable, blocked local policy, capacity/lifecycle failures, output/event limits, and generic process-lifecycle failure. Failed retained runs carry the same DTO in snapshots and SSE completion. Cancellation and timeout remain explicit run statuses rather than being reclassified as generic errors.

HTTP security/session/method/not-found/stream failures use the same DTO envelope. Arbitrary `err.Error()`, discovery prose, executable/candidate paths, argv, environment values, bootstrap/session/CSRF material, and unreviewed vendor output are not serialized into it.

The React client validates the error envelope, known code/category set, text bounds/control characters, retryability, and field syntax. Unknown or malformed responses become a generic local-response error. UI behavior branches on codes/state, never message text.

### Alternatives considered

1. Continue returning short string codes and let each React caller invent its own prose.
2. Serialize wrapped Go errors and redact sensitive substrings.
3. Convert every Go error in the repository to one global application-error framework.
4. Treat run status plus stdout/stderr as sufficient error UX.

### Rationale

A closed DTO creates a stable cross-layer contract while preserving the richer local errors needed for engineering and `doctor`. Selecting safe text from reviewed constants prevents forbidden data from entering the browser boundary at all; regex redaction is not the primary control. Limiting the abstraction to UX/trust boundaries avoids turning ordinary Go error handling into a framework.

### Consequences

Positive:

- the browser can classify failures deterministically without string parsing;
- safe remediation is consistent across HTTP, run snapshots, and stream completion;
- stale executable identity is distinguishable from malformed input or generic execution failure;
- field-specific validation can be associated accessibly with controls;
- retained-run eviction and stream exhaustion have explicit recoverable UI states;
- unknown future codes fail safely instead of crashing the browser.

Negative:

- adding a new browser-visible failure class requires coordinated backend DTO and frontend known-code updates;
- vendor-specific failure/remediation remains intentionally unavailable until real evidence defines it;
- `doctor` and other operator-local CLI surfaces remain richer and are not forced into the browser taxonomy.

### Security / reliability implications

- no raw internal cause crosses the browser error boundary;
- browser-safe text is fixed/bounded and field association is allowlisted;
- React renders all messages/output as text, never HTML;
- cancellation/timeout races continue to be resolved by authoritative executor/run state;
- EventSource automatic recovery remains bounded; after exhaustion the browser performs one snapshot reconciliation and requires explicit retry;
- run eviction during reconciliation disables stale active controls.

### Verification

- Go unit tests cover planner/executor classification, unsafe field rejection, stable HTTP mapping, hostile internal-cause exclusion, and stale executable classification;
- React/Vitest coverage exercises malformed/unknown DTOs, hostile-looking text rendering, field focus/ARIA association, stream exhaustion, eviction, live status, and timeout visibility;
- existing run-manager/executor race and lifecycle suites remain authoritative for cancellation/timeout ordering;
- production embedded-browser E2E remains the real-runtime gate for bootstrap/session, SSE/reconnect, cancellation, hostile output, and single execution;
- Linux/Windows CI, Go race detector, dependency scans, embedded-asset synchronization, and Windows evaluation qualification remain required.

### Revisit when

- real vendor evidence justifies vendor-specific safe failure classes;
- authentication or destructive confirmation introduces new operator error state;
- browser/API versioning requires backward compatibility across independently deployed frontend/backend versions;
- remote/multi-user operation is proposed.

### Supersedes / superseded by

- Complements ADR-020's browser-origin boundary and ADR-014's structured-output boundary.
- Does not change the vendor-owned authentication decision or Phase 0 evidence gate.

## ADR-024 — Ship a self-contained extracted-bundle evaluation preflight

**Date:** 2026-09-20  
**Status:** Accepted.

### Context

The Windows evaluation artifact already had deterministic build qualification, an authoritative two-file checksum manifest, vendor-free self-test, and packaged Phase 0 evidence smoke. The managed-laptop procedure still required the operator to manually reconcile the manifest and individual hashes before separately running identity and runtime checks. That duplicated security logic outside the shipped executable and left avoidable ambiguity around wrong working directories, partial extraction, copied executables, altered discovery-only packs, and evidence files written back into the qualified bundle.

### Decision

Ship `cliharbor evaluation preflight [--bundle <directory>]` as the primary pre-Phase-0 laptop gate.

The preflight:

- accepts only the qualified Windows amd64 evaluation identity;
- binds the running process to the manifest-covered packaged executable;
- requires the exact extracted evaluation layout and rejects unexpected/case-conflicting/symlink/reparse-point entries where supported;
- reuses one importable evaluation-bundle checksum authority shared with `tools/task`;
- parses the packaged Phase 0 pack through the production pack parser and requires the exact discovery-only `idsec`/`conjur` authority with zero commands, version probes, help probes, or version constraints;
- reuses the vendor-free temp, embedded-frontend/loopback-session, and direct self-process checks already exercised by `self-test`;
- never runs discovery and therefore never launches a vendor executable;
- revalidates the bundle after runtime checks before reporting `READY FOR PHASE 0 INVENTORY`;
- emits deterministic PASS/WARNING/BLOCKED output with safe, non-path-leaking remediation.

The extracted qualified bundle is treated as immutable input. Managed-laptop evidence and diagnostics are written outside it so a later exact-layout preflight remains meaningful.

### Alternatives considered

1. Keep manual `certutil`/PowerShell hashing as the primary operator procedure.
2. Duplicate the task-package verifier inside the CLI.
3. Run discovery as part of preflight to prove vendor presence.
4. Add code signing/enterprise policy bypass guidance as part of this milestone.

### Rationale

A shipped deterministic gate removes shell/tooling dependencies and manual reconciliation while preserving the existing trust boundary. Sharing the checksum/parser primitives prevents drift between CI packaging verification and the operator executable. Keeping discovery out of preflight makes the preflight safe even when unknown or malformed vendor binaries are present on `PATH`.

### Security / reliability implications

- checksum equality remains integrity evidence, not signing, publisher identity, provenance, or host attestation;
- exact-layout checks make partial extraction and post-extraction additions explicit instead of silently tolerated;
- the preflight does not modify firewall, proxy, execution policy, registry, `PATH`, application-control policy, or machine configuration;
- SmartScreen/AppLocker/WDAC/EDR blocks are reported as environmental gates and must not be bypassed;
- a maliciously replaced executable plus correspondingly replaced manifest is outside checksum-only authenticity guarantees and remains a reason to retain CI artifact identity/digest separately.

### Verification

Unit/regression tests cover manifest and privileged-file corruption, authority expansion, build identity, temp failure, deterministic output, running-executable binding, hostile filesystem entries where supported, and no-vendor-launch behavior. Windows artifact CI stages a clean extracted-copy bundle, puts deliberately invalid vendor executable sentinels first on `PATH`, runs the packaged preflight, then performs the final authoritative bundle verification before upload.

### Revisit when

- the organization adopts approved code signing or artifact attestation;
- the evaluation bundle gains additional privileged files;
- the Phase 0 pack intentionally gains approved probe authority;
- the target architecture or supported Windows profile changes.



## ADR-025 — Allow ephemeral Conjur password handoff without making CLIHarbor a credential store

**Date:** 2026-09-29  
**Status:** Accepted.

### Context

The original MVP delegated login entirely to external vendor flows because a browser password form would otherwise risk process-list exposure, logging/run-history leakage, duplicated vendor protocol logic and unclear MFA semantics. Real work-laptop use now requires a usable UI path for ordinary Conjur username/password authentication. The qualified Conjur CLI 9.3.1 source also establishes that its `-p/--password` flag is argv-visible, while its masked prompt requires an interactive terminal, so neither subprocess mechanism is acceptable for browser-supplied secrets.

The same qualified upstream CLI depends on `conjur-api-go v0.15.4`. Its `Client.Login` path performs the password exchange in-process and stores the resulting API key through Conjur's configured credential-storage provider.

### Decision

Add one narrow Conjur-specific credential adapter and dedicated authenticated loopback endpoint.

- UI credential entry is advertised only for healthy `cyberark-conjur-v9/conjur` plus supported password-style `authn`/LDAP configuration with writable vendor credential storage.
- The endpoint accepts only bounded `packId`, `toolId`, identity and password JSON under the existing HttpOnly session, exact Host/Origin and CSRF boundary.
- The password is passed directly to pinned `conjur-api-go v0.15.4`; it never enters planner/executor argv, run state, invocation preview, logs, diagnostics or CLIHarbor persistence.
- The vendor library remains authoritative for credential validation/exchange and durable credential storage.
- OIDC/JWT/certificate/IAM/Azure/MFA/challenge modes remain vendor-owned.
- A successful login call is immediately followed by the existing trusted `whoami` session check; transport success is not treated as authorization evidence.

### Alternatives considered

1. Continue requiring external terminal login for every Conjur deployment.
2. Invoke `conjur login -p <password>`, which exposes the password in argv.
3. Pipe the password to `conjur login`, which the pinned CLI rejects because its masked prompt requires an interactive terminal.
4. Add a generic secret-input type to trusted packs.
5. Reimplement Conjur authentication/storage directly over HTTP.

### Rationale

The vendor API provides the narrowest reviewed boundary that solves UI usability without broadening normal task execution or inventing a second credential store. It reuses the same authentication/storage implementation family as the qualified CLI while avoiding argv leakage.

### Security / reliability implications

- credential input expands frontend/backend memory sensitivity for the duration of one request;
- strict request bounds, duplicate/unknown-field rejection, CSRF/session/origin checks and closed-set errors are mandatory;
- the browser clears password state after each attempt;
- returned API-key bytes are cleared after the vendor library persists them;
- one concurrent login is allowed to prevent duplicate credential exchanges;
- network duration is bounded by the vendor client timeout;
- vendor credential-storage configuration remains authoritative, including enterprise policy;
- privileged local malware/current-user compromise remains outside what a loopback UI can defend against.

### Verification

Backend tests cover request-boundary enforcement, malformed/oversized payloads, secret non-echo, adapter target/mode/storage fail-closed behavior, vendor-error sanitization and API-key-buffer clearing. Frontend tests cover exact endpoint/CSRF use, password clearing, absence from run requests, capability validation and automatic trusted session verification. Repository CI must pass frontend type/lint/tests/build, Go vet/tests/race, vulnerability scans, embedded frontend synchronization and Windows evaluation qualification.

### Revisit when

- another vendor needs credential entry;
- Conjur changes the `Login` or credential-storage contract;
- MFA/challenge/OIDC must be integrated;
- remote/multi-user operation is proposed;
- stronger memory-zeroization or OS-native secret UI becomes practical.

### Supersedes / superseded by

- Refines ADR-004 and ADR-005: durable authentication remains vendor-owned, but a reviewed ephemeral browser-to-vendor credential bridge is now allowed.

## ADR-026 — Present vendor-owned Conjur login according to authentication mode

**Date:** 2026-10-02  
**Status:** Accepted.

### Context

The first vendor-login launcher treated reviewed OIDC, JWT, and Idira SaaS/cloud modes identically by starting `conjur login` in a new Windows console. That preserved vendor ownership but produced a transient Command Prompt window for modes that do not require terminal input and left the browser with only a launch acknowledgement.

Qualified Conjur 9.x source establishes materially different interaction contracts: OIDC owns a browser plus loopback callback flow, JWT authenticates from its configured JWT source, while SaaS/cloud Identity authentication can require password, MFA-mechanism selection, OTP/PIN values, security questions, or other interactive input.

### Decision

Keep one fixed, identity-revalidated vendor-login authority but select presentation from the already-loaded Conjur authentication mode:

- OIDC and JWT start the exact verified Conjur executable with fixed argv `["login"]` without a visible console window.
- OIDC remains responsible for opening its own browser and receiving its loopback callback.
- Idira SaaS/cloud starts the same fixed command in a separate vendor-owned terminal so interactive credential/MFA challenges never pass through CLIHarbor.
- CLIHarbor does not redirect/capture vendor credential stdin/stdout for either path and does not synthesize keystrokes.
- Browser launch success is not authentication evidence. The reviewed Conjur `whoami` session check remains authoritative.

### Alternatives considered

1. Always open a new console for every vendor-owned mode.
2. Embed a PTY/terminal in the React UI.
3. Reimplement OIDC/SaaS authentication inside CLIHarbor.
4. Hold the loopback HTTP request open until `conjur login` completes.

### Rationale

Mode-aware presentation removes unnecessary console flash without broadening the credential boundary. An embedded PTY or SaaS challenge UI would make CLIHarbor responsible for additional secret/MFA material. Waiting synchronously for completion is also inconsistent with browser/OIDC flows that may legitimately outlive ordinary HTTP request timeouts.

### Security / reliability implications

- executable identity and fixed argv remain backend-authoritative;
- no shell is introduced;
- OIDC/JWT no-console launch does not grant CLIHarbor access to browser tokens or vendor session material;
- SaaS/cloud retains a real terminal specifically because upstream interaction can require sensitive operator input;
- the existing authentication single-flight gate still prevents setup/password/vendor-login races;
- a started vendor process may later fail independently, so the UI must never equate launch with authenticated state.

### Verification

- backend table coverage must assert OIDC/JWT select the hidden launcher and SaaS/cloud selects the vendor-terminal launcher;
- every mode must retain the exact verified executable and fixed `login` argv;
- executable replacement must fail closed before either launcher runs;
- React coverage must distinguish “sign-in started” from authenticated state and retain explicit session verification;
- Windows CI must compile/test the platform-specific process flags and qualify the resulting evaluation artifact.

### Revisit when

- upstream Conjur changes OIDC/JWT/SaaS interaction semantics;
- CLIHarbor gains an explicit asynchronous authentication-operation API;
- a vendor-supported non-secret completion/status channel becomes available;
- embedded terminal/MFA handling is proposed and receives a separate security review.

### Supersedes / superseded by

- Refines ADR-005: an external terminal remains preferred when terminal interaction is actually required; non-interactive vendor-owned modes no longer open one merely for presentation.
- Complements ADR-025; the password bridge remains unchanged.


## ADR-027 — Support Windows and macOS through the portable runtime

**Date:** 2026-10-04

**Status:** Accepted.

**Supersedes:** ADR-008's Windows-only initial support scope. Windows enterprise evaluation remains first-class.

**Requirement:** CLIHarbor must work on Windows and macOS and include a simple local CLI for macOS testing.

**Decision:** Reuse the embedded frontend, existing darwin pack schema, executable discovery, planner, executor, run manager, and macOS browser launcher. Conjur pack 0.3.0 adds darwin without changing its reviewed command/version envelope; upstream v9.3.1 release configuration publishes darwin builds. Keep its automatic managed download and vendor-terminal launcher limited to their existing reviewed Windows contracts. Add bounded standard macOS CLI fallback directories and shared macOS/Linux process-group cleanup. Provide `cliharbor-fixture` plus the explicit example pack and one-command `demo` task.

**Security impact:** No shell, credential persistence, remote listener, pack auto-trust, or new browser execution authority. POSIX groups are established before exec and killed on cancellation/timeout/normal cleanup; deliberate group/session escape is not Windows Job Object containment. Default product packs exclude the testing CLI.

**Migration:** Pack schema stays v1. Conjur pack advances to 0.3.0; example pack advances to 0.2.0. Existing Windows startup/preflight remains compatible. On macOS, vendor CLI installation and unsupported interactive authentication remain external approved operations.

**Verification:** Native macOS Go/real-browser checks, local fixture execution integration, descendant-cleanup regressions, Windows/macOS/Linux CI, and Windows evaluation gates. Building a Windows binary on macOS does not prove native Windows behavior. See [platform setup](CROSS_PLATFORM.md) for exact support boundaries.

## ADR-028 — Run the Conjur secret-value reference audit from the browser without returning values

**Date:** 2026-10-05
**Status:** Accepted.

### Context

`tools/audit-conjur-secret-values.ps1` finds Conjur variables whose stored value is a path/reference to another secret (for example `RH.value.value.value/password`) instead of secret material. Operators need this from the CLIHarbor UI, on Windows and macOS, without PowerShell. The script spawns one `conjur variable get` process per variable, which is slow for large inventories, and invoking it from CLIHarbor would violate ADR-002/ADR-010 (no `powershell.exe`).

### Decision

Add one fixed, read-only Conjur adapter at `GET|POST|DELETE /api/v1/conjur/secret-audit`, implemented in-process with pinned `conjur-api-go` (as ADR-025 already permits for the reviewed credential bridge).

- Enabled only for a healthy `cyberark-conjur-v9/conjur` tool. It reuses the session that the vendor CLI stored (`NewClientFromEnvironment`); CLIHarbor supplies no credential.
- The browser chooses only the reviewed pack/tool identity and the `high`/`medium` reporting threshold. Start/cancel use the existing session + exact Origin + CSRF boundary.
- It preserves the script's guarantees: a pre-count bound of 50,000 variables, bounded ID-only paging, duplicate/drift detection with full re-enumeration after reads, rejection of control/format/bidi resource IDs, a 1 MiB per-value bound, and the same classifier (ported case-for-case and tested against the script's self-test).
- Values are read in batches with per-variable fallback, classified, and the buffers zeroed in the backend. The response DTO has **no field that can hold a value**: only variable IDs, closed reason codes, and closed per-variable failure codes (`no_value`, `forbidden`, `output_limit_exceeded`, `retrieval_failed`).
- Failed or cancelled audits discard partial results so an incomplete audit never looks clean.
- There is one audit at a time, held in memory. Nothing is persisted. The UI's redacted JSON download is generated client-side from the snapshot.
- The UI requires an explicit acknowledgement before starting, because each read is recorded in Conjur's audit log.
- It performs no mutation. Remediation stays with the operator's approved change process.

### Alternatives considered

1. Launch the PowerShell script from the backend. Rejected: shell invocation, Windows-only.
2. Spawn `conjur variable get` per variable through the executor. Rejected: secret-bearing stdout would cross the executor/run-history path, and per-process cost is high.
3. Add remediation (`variable set`) to the UI. Deferred: a mutating, secret-input workflow needs its own reviewed contract (ROADMAP Stage 7).

### Security / reliability implications

Secret values now transit backend memory during an operator-initiated audit. Go cannot guarantee erasure of strings/allocations made inside the vendor library. Variable IDs are operational metadata and are shown in the UI. SI-6 still holds: no secret value is ever returned to the browser, run history, logs, or diagnostics.

### Verification

Go tests cover classifier parity, value/metadata non-echo in the serialized snapshot, batch→per-variable fallback, failure codes, drift detection, and session failure. Server tests cover CSRF/Origin, unknown/duplicate fields, and threshold validation. Frontend tests cover acknowledgement gating, the exact request body/CSRF, redacted rendering, and rejection of unsafe server text.


## ADR-029 — Preserve native console input and visible Conjur login results

**Date:** 2026-10-05
**Status:** Accepted; Windows runtime and managed-tenant qualification remain release requirements.

The previous console launcher detached from Conjur immediately after process creation. A vendor failure could close the window before the operator could read it, while the browser displayed a launch acknowledgement. Inherited/null standard handles are also unsuitable for the vendor’s password/MFA terminal prompts.

Retain ADR-026’s mode selection. For SaaS/cloud, launch a private CLIHarbor console host that accepts only the approved Conjur executable and discovery-time SHA-256 content evidence. Revalidate the handoff, connect the vendor directly to native console devices, execute fixed `login` argv, wait for the vendor, and keep the result visible until the operator closes the native window. The host never reads credential interaction, captures vendor output, or invokes a shell. OIDC/JWT retain hidden vendor execution; a bounded startup check rejects immediate non-zero exits without capturing output.

The extra local process exists solely to provide terminal handles and preserve the vendor result. No browser-supplied executable, command, fingerprint, credential, or environment is accepted. The ordinary executable identity checks and `whoami` session verification remain authoritative. The private helper’s fingerprint is content evidence across a local process boundary, not a serialization of executable authority or a new public API.

Qualification includes actual Windows console-handle tests with a credential-free helper executable, paths containing spaces/Unicode, changed-content refusal, malformed handoff refusal, immediate hidden-process failure, and real managed-tenant sign-in. Compiling Windows tests on another OS is not Windows runtime qualification.

## ADR-030 — Manage Conjur secret variables through approval-gated stdin templates

**Date:** 2026-10-05
**Status:** Accepted; real-appliance qualification pending.

### Context

Operators need to create/delete Conjur variables, grant/revoke privileges on them, and set their values from CLIHarbor. The official CLI (`cyberark/conjur-cli-go` v9.3.1) does all permission and create/delete work through `policy update --branch <b> --file -`, which reads policy YAML from stdin, and sets values through `variable set --id <id> --file -`, also stdin. Its `--value` flag would put the secret in argv. The executor previously never supplied stdin, and the Stage 6 approval branch had left the executor rejecting every non-read plan, so approved mutations could not run.

### Decision

- The executor admits `change`/`destructive` plans that carry impact metadata. The run manager, its only caller, consumes the single-use approval first.
- Packs gain `stdin` for mutation commands, with exactly one of:
  - `yamlTemplate`: a trusted document with `{{input}}` placeholders. Strings and integers render as YAML double-quoted scalars; enum values must be plain words and render verbatim.
  - `input`: the raw value of the command's only `secret` input.
- `secret` is a write-only input type. Pack validation allows it only as `stdin.input`.
- The approval fingerprint includes stdin. The preview returns policy stdin but never secret stdin. The browser renders secrets as password fields, never keeps them in retry or preference state, and clears the field once a run starts.
- The Conjur pack adds `secret-create`, `secret-delete` (destructive), `secret-permit`, `secret-deny` and `secret-set-value`. Each policy task has a dry-run switch.

### Alternatives considered

1. A free-form policy textarea. Rejected: it grants arbitrary policy authority, including creating hosts/users whose API keys come back in the output.
2. `variable set --value`. Rejected: the secret would be visible in the process list and the argv preview.
3. Making revoke destructive. Rejected: typed `DELETE:` text would wrongly suggest deleting the variable. Revoke stays `change` with explicit approval and an exact policy preview.

### Security / reliability implications

The secret value transits browser memory, the loopback request and backend memory (as part of the in-memory approval fingerprint hash), and then the vendor process's stdin. It is not persisted by CLIHarbor. `!deny` only removes permissions created by the same policy branch, which the task text states. Dry run is self-hosted only.

### Verification

- Planner contract tests pin the exact argv and stdin for every task, prove a hostile role ID stays one YAML scalar (parsed back with `yaml.v3`), and keep the secret out of argv.
- Pack tests cover every stdin/secret validation rule.
- Executor tests prove stdin delivery for mutations and empty stdin for reads.
- Run manager tests prove the preview never contains the secret and a swapped secret voids the approval.
- A frontend test covers the password field, the non-echo review, the exact request and clearing afterwards.

## ADR-031 — Supported CLI catalog and additive live activation

**Date:** 2026-10-06
**Status:** Accepted; native Windows and managed-vendor qualification pending.

### Context

Portable installation already exists, but its controls were confined to
Diagnostics and installed tools required a restart before tasks appeared.
Operators need a selection of supported CLIs that populate the workspace.

### Decision

Expose `/tools` from Overview and the sidebar. Reuse the trusted pack registry,
portable installer, discovery, planner, and executor. Add immutable kubectl
1.35.3 and GitHub CLI 2.101.0 artifact contracts and bump their pack versions.
Keep Docker installation external because its CLI requires an engine.

Allow installation only for authoritative `missing` states. Before live
activation, run ordinary discovery on the installed tool alone, require its
exact install version, and compare its captured content hash with the pinned
executable hash. The run manager may add that qualified missing tool under its
lock. Swap sanitized catalog metadata under its own lock and refresh the UI.
Enable existing Conjur adapters only after its qualified activation.

This supersedes the portable-install restart requirement in Pack Spec §21 and
Security's browser-managed installation section. Existing ready or uncertain
tool states, explicit invalid overrides, the pack registry, active plans,
approvals, and retained run evidence are not replaced. Credential ownership,
loopback/session/CSRF protection, direct argv execution, and pre-launch identity
checks remain authoritative. No arbitrary download URLs, package managers,
remote packs, installers, shells or command scraping are added.

### Verification

Install-to-task acceptance, actual post-activation execution, non-missing state
refusal, version/content qualification failures, platform-specific metadata,
search, single submission, custom roots, browser layout and race checks. Native
Windows testing remains a separate qualification requirement. See
[Supported CLI catalog](CLI_CATALOG.md) for artifact evidence and platform scope.


## ADR-032: Restore macOS Conjur installation and remove the demo launcher

**Date:** 2026-10-06

**Decision:** Conjur pack 0.5.0 identifies Conjur by name in the catalog and declares immutable official v9.3.1 executable downloads for Intel and Apple Silicon macOS alongside the existing Windows amd64 pin. Pin the exact probed CLI version `9.3.1-7207d6a`, matching the official release banner rather than its shorter release tag. Reuse the portable installer and normal discovery/activation checks; automatic Conjur setup remains Windows amd64 only. Remove the development `demo` task and its startup documentation. This supersedes ADR-027's demo launcher; the fixture CLI and example pack remain automated-test inputs, never normal product defaults.

**Reason:** Users need the real default CLI catalog and a usable Conjur installation path. A demo launcher that disables all product packs is misleading, and supported macOS discovery without a reviewed macOS installer leaves missing Conjur unusable in the GUI.

## ADR-033 — Generalize the Conjur security audit with bounded scan criteria

**Date:** 2026-10-06
**Status:** Accepted; extends ADR-028's browser-input contract.

Operators need to scan values on their own Conjur backend for arbitrary path patterns or text, beyond the original secret-reference detector. Place **Security audit** beneath Conjur in tool navigation, at `/conjur/security-audit`, retaining the old `/secret-audit` route.

The existing authenticated, read-only endpoint accepts optional `applianceUrl`, `scanType` (`references`, `contains`, `exact`, `regex`), and `pattern` fields. Omitted scan type keeps the reference detector; omitted URL keeps the configured backend for older callers. An explicit URL must be HTTPS without credentials/query/fragment and must equal the vendor-configured URL, allowing a trailing slash. A mismatch fails before client creation. Changing backends continues through official Conjur configuration and sign-in; CLIHarbor cannot redirect existing credentials or tokens.

Custom text is bounded to 1,024 UTF-8 bytes, rejects control/format/bidi characters, and is neither reflected in responses/errors nor persisted. Regex uses the Go standard library and is compiled before value retrieval. Exact and contains matching are case-sensitive and preserve spaces; regex anchors and flags are operator-controlled. Only closed match reasons and variable IDs reach the browser. A deterministic custom match is labelled **Matched**, rather than interpreted as proof of insecure secret material. Non-UTF-8 values are explicit unchecked failures.

Retain ADR-028's session/Origin/CSRF boundary, inventory/read bounds, drift checks, buffer clearing, cancellation, and no-mutation/no-value-export guarantees. The browser clears scan text after start and resets authorization acknowledgement when target or criteria change. Browser report schema version 2 adds the scan type and renames `suspiciousValues` to `matchingVariables`; patterns and values are excluded. This does not expand pack authority or require a pack/schema version change.

Verification covers custom matching/negative cases, request bounds/regex/URL validation, refusal before credential forwarding, non-text reporting, pattern/value non-disclosure, navigation, consent reset, and production-browser setup/mismatch/responsive behavior. Native Windows execution is unchanged; existing Windows CI runs the portable tests.

## ADR-034 — Split CLIHarbor into a generic workspace and dedicated CLI platforms

**Date:** 2026-10-07
**Status:** Accepted; supersedes ADR-033's placement of **Security audit** beneath the Conjur task category.

CLIHarbor has two jobs that were tangled together: a generic workspace that works with any reviewed CLI through packs, and Conjur-specific functionality (guided sign-in, mutation execution context, the secret-value audit) that is built and tested for one vendor. Conjur code lived in `internal/app` beside lifecycle wiring, and the frontend branched on the Conjur pack ID in its sidebar. Adding a second vendor would have repeated that pattern.

**Decision.** Make the split explicit in both halves of the product.

- **Generic core** (unchanged authority): packs, discovery, planner, executor, runs, catalog, diagnostics, and the Overview/Tasks/Runs/Authentication/Add a CLI/Diagnostics pages. Core code must not branch on a vendor.
- **Dedicated platforms**: `internal/platforms` defines a `Platform` interface (descriptor, tool activation, per-pack task availability, mutation execution context). `platforms.Set` routes those hooks to the owning platform and fails closed for any tool no platform owns, exactly as the previous Conjur-only resolver did. Each platform lives in its own package; Conjur moved, with its tests, to `internal/platforms/conjur` (credential login, secret audit, mutation context). A platform whose pack is not loaded (`--no-default-packs`) is not registered and its hooks never run.
- **API**: authenticated `GET /api/v1/platforms` lists dedicated platforms with readiness and a closed set of feature IDs (`tasks`, `sign-in`, `security-audit`). The backend names features; the frontend owns their routes and drops unknown feature IDs. Existing endpoints, including `/api/v1/conjur/secret-audit`, are unchanged. New platform-specific endpoints should live under `/api/v1/<platform-id>/`.
- **UI**: the sidebar keeps the generic workspace navigation and adds a **Dedicated** section with a **Dedicated CLI** picker. Each platform has a home at `/dedicated/<id>`; Conjur's audit moves to `/dedicated/conjur/security-audit`, with `/conjur/security-audit` and `/secret-audit` still served and mapped. The platform list is additive: if it fails to load, the generic workspace keeps working and the Dedicated section is hidden.

**Zero-config bootstrap.** ADR-025's pinned Conjur provisioner moved from `internal/toolbootstrap` to `internal/platforms/conjur`. A platform declares a `platforms.AutoSetup` (tool ref, version, display names, sanitized failure guidance, supported hosts, provisioner factory); the generic runtime iterates the declared list and keeps every ADR-025 guarantee (missing-only, embedded default packs only, explicit overrides win, cancellation propagates, re-discovery and readiness qualification after activation, identical operator messages). `internal/toolbootstrap` keeps only the generic `Provisioner` interface and the pack-declared portable installer.

**Sign-in.** The generic Authentication and Overview pages own the session check for every CLI. Vendor sign-in forms are supplied by dedicated platforms (`web/src/platforms/<id>`) through a `ToolSignIn` provider and render only on `/dedicated/<id>/sign-in`. On the generic pages, a CLI owned by a dedicated platform shows a link to that sign-in instead of a form. If the platform list cannot load, the generic pages fall back to the plain vendor-flow guidance.

**Not changed.** Pack schema/authority, session/Origin/CSRF boundaries, credential API endpoints, and the reviewed Conjur pack. Generic task categories still list the Conjur pack, because the core can run any reviewed pack; the dedicated section adds platform-built functionality on top.

**Follow-up.** Consider namespacing the audit endpoint under `/api/v1/platforms/conjur/` with a compatibility alias.

Verification: unit tests for `platforms.Set` routing and fail-closed behavior, unchanged ADR-025 runtime tests driving the platform-declared bootstrap (including Windows-only cases), the moved provisioner tests, generic-page sign-in links without vendor forms, the dedicated sign-in route, the platforms API session requirement, frontend parsing that rejects malformed IDs and drops unknown features, sidebar separation, legacy-route compatibility, generic workspace without any dedicated platform, and embedded-route allowlisting (including `/tools`, which was previously missing).

## ADR-035 — Conjur metadata-first regex explorer and curated toolbox

**Status:** Accepted.

Replace the heuristic, all-values-first Conjur audit *UI default* with read-only, metadata-only variable-ID regex matching. Offer reviewed regex presets and an editable custom expression. Retain optional value-regex searches with conspicuous separate operator acknowledgement; preserve the original scan API types for existing callers. Both modes must use the same configured Conjur backend and authenticated vendor session, bounded Go/RE2 expressions, inventory drift checks and redacted output. Expressions and secret data cannot appear in report snapshots or logs. A regex match is a search result, not a security verdict.

Add four vendor-verified, page-bounded read-only inventory commands (variables, policies, hosts and groups) to Conjur pack v0.7.0, and present approved tasks as navigation shortcuts in the Conjur home. Quick links cannot authorize or execute commands; the shared task planner and approval requirements remain authoritative.

## ADR-036 — Reuse approved read-only Conjur tasks for a bounded access explorer

**Date:** 2026-10-08  
**Status:** Accepted

**Context:** CLIHarbor already provides vetted Conjur Go CLI v9.3.1 read commands, a bounded task runner and session handling. The new UX must not become an unrestricted API proxy or confuse role-graph relationships with effective rights.

**Decision:** Build the Access & Permissions Explorer as a dedicated client of the existing approved read-only tasks, without new pack commands or secret-value APIs. Fix the browser's input/response scope to approved resource IDs, derived kind metadata, and explicit relationship types. Never invoke raw resource/role show commands in the explorer, as their unfiltered outputs are retained by the generic task history. Check configured endpoint/account, CLI readiness/version and whoami before and after inspection, discard drifted and partial results, and re-use normal task forms for any further operator action. Treat `role memberships` as vendor-recursively expanded (per pinned Go source), never as a direct edge or effective-access proof.

**Alternatives considered:** (1) New Conjur REST proxy (rejected: duplicative authorization and broad trust boundary). (2) Client-computed effective permissions (rejected: incomplete visibility and unsupported semantics). (3) Export arbitrary resource JSON (rejected: possible sensitive annotations).

**Security/reliability implications:** Conjur controls native authorization; the explorer never executes mutations. Query count, response size and pagination are bounded; stale and unauthorized results are unknown, not denied. Pre/post checks are not atomic session snapshots. Generic read-run history still retains its normal output contract.

**Verification:** React parsing and interaction tests, platform API tests, production-browser E2E and Windows/Go build gates; real corporate server qualification remains an explicit follow-up.

**Revisit when:** A reviewed backend-native context-bound Conjur permission-check API and corporate fixture tests can prove actual effective permissions and provide stronger atomic session binding.
