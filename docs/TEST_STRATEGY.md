# Test Strategy

## 1. Testing philosophy

CLIHarbor sits between a browser and powerful local CLIs. Tests must preserve user intent, prevent unexpected executable/argv authority, and fail safely when packs, PATH, tools, or external output change.

The highest-risk code is pack validation/trust, tool discovery, execution planning/process lifecycle, auth orchestration, and untrusted output handling—not static UI markup.

### Phase 1 checkpoint

Automated coverage verifies loopback-only binding, exact Host/Origin/CSRF/session/bootstrap behavior, restrictive headers/CSP, frontend route ownership, safe dev proxying, browser launch/fallback behavior, React status states, embedded production assets, Go/frontend build gates, and Linux race testing.

### Phase 2 checkpoint

`internal/packs` coverage verifies known-good packs plus fail-closed schema/semantic/trust/resource-bound cases including unsupported versions, duplicate IDs/keys, unresolved references, invalid input/risk/output shapes, browser-selectable execution fields, unsafe flag layouts/leading-dash values, executable paths/shell/interpreters, hostile YAML features, UTF-8/size/depth bounds, secret-output persistence policy, deterministic load order, local symlink rejection, duplicate packs, error path redaction, and registry deep-copy behavior.

### Phase 3 checkpoint

`internal/discovery`, pack version-probe tests, app doctor tests, and CLI flag tests cover:

- a single compatible candidate resolves to `ready`;
- exact resolved path is retained;
- multiple PATH candidates become `ambiguous` and are not probed;
- relative/current-directory PATH entries are ignored;
- explicit relative/invalid overrides become `invalid-override` rather than falling back to PATH;
- an explicit valid override resolves PATH ambiguity;
- overrides naming undeclared pack/tools are rejected;
- incompatible versions become `incompatible`;
- version output with multiple distinct semantic versions becomes `probe-failed` rather than being guessed;
- probe failures do not expose captured output;
- unsupported platforms are not probed;
- discovery snapshots return defensive copies;
- version constraints require probes and invalid constraint syntax fails pack loading;
- unsupported version parser values fail structural validation;
- CLI override syntax/duplicates fail closed;
- mixed `--pack-file` + `--pack-dir` configuration is rejected;
- doctor with no configured packs is informational and does not imply cwd auto-discovery.

### Phase 4 checkpoint

`internal/planner`, `internal/executor`, and executable-identity coverage now verify the low-level read-only execution boundary:

- only a validated pack command plus current `ready` discovery state can produce a plan;
- ready discovery state must carry an executable identity;
- unknown/missing/null/wrongly typed/trailing JSON values fail closed;
- zero integers, empty optional strings, Unicode, spaces, quotes, shell metacharacters, and leading-dash constraints preserve deterministic argv semantics;
- change/destructive/interactive/credential-sensitive, auth-required, and secret-bearing commands remain blocked;
- same-path executable replacement, same-size content mutation with restored metadata, and symlink identity substitution are rejected;
- normal/non-zero exits, cancellation before start, cancellation after observable output, timeout, output limits, sink failure, setup failure, and double cancellation have explicit coverage;
- neutral temporary working directories are removed after runs;
- Windows-only tests cover normal descendant completion, case-insensitive executable paths, explicit cancellation, timeout, output-limit and sink-failure descendant cleanup, plus inherited stdout/stderr handles using a per-run Job Object.

### Phase 4b integration checkpoint

`internal/app/execution_integration_test.go` exercises the real internal authority chain without vendor credentials or shell wrappers:

- an explicit-local synthetic pack passes the production YAML/schema/semantic loader;
- discovery uses a backend-only absolute override tied to the declared tool;
- a fixed pack-authored version probe resolves `1.2.3` and satisfies the declared semantic-version constraint;
- typed planner inputs produce exact argv including a zero integer, Unicode, spaces, and shell metacharacters;
- executor stdout/stderr and exit code are compared with direct invocation of the same fixture executable/argv;
- non-zero exits remain process results;
- cancellation after observable output produces the expected cancelled run state;
- a second explicit-local fixture pack/tool uses a different tool ID, version probe/result, command shape, and input mapping while proving cross-pack command isolation through the same registry/discovery/planner/executor core;
- authenticated task metadata integration sees both fixture packs with the correct scoped tool/version evidence;
- the test binary acts only as the synthetic CLI; no external tool, credential, vendor syntax, or browser-selected execution shape is introduced.

### Phase 4c-A authenticated run API checkpoint

Coverage now proves:

- run creation requires the established browser session plus exact Host/Origin/CSRF mutation boundary;
- authenticated status supplies the per-session CSRF token without rendering/logging it;
- request bodies are bounded, valid UTF-8 JSON with duplicate keys and unknown execution-authority fields rejected;
- browser payloads contain only pack/command IDs plus typed values;
- run IDs are generated server-side and duplicate read-only requests create distinct bounded runs;
- active-run and retained-run limits are deterministic;
- snapshots never expose executable path or argv and encode output bytes as Base64 data;
- output exhaustion fails the run rather than growing memory without bound;
- explicit cancellation releases capacity;
- manager/application shutdown cancels active runs;
- a full application test performs bootstrap → status/CSRF → authenticated multi-pack task metadata → POST run → SSE events/completion → final snapshot/output verification → shutdown.

### Phase 4c-B streaming/task UI checkpoint

Coverage now targets:

- manager-backed event replay strictly after a monotonic cursor and rejection of impossible cursors;
- authenticated SSE framing with `Last-Event-ID` replay, stable completion state, and no executable/argv/environment fields;
- stream disconnect without implicit run cancellation;
- bounded concurrent SSE handlers with excess streams rejected before they can consume unbounded server resources;
- slow clients observing bounded manager state rather than sitting on executor output sinks;
- task metadata filtering to ready, read-only, non-auth, non-secret commands;
- authenticated tool diagnostics limited to pack/tool identity, versions, discovery status, and fixed browser-safe remediation, with executable/candidate paths and execution authority excluded;
- frontend CSRF retention in runtime memory only;
- typed task submission containing only pack/command IDs plus values;
- stdout/stderr rendering as inert React text, including markup-like output;
- stream completion and cancellation state transitions;
- server-owned SSE observer cancellation during shutdown;
- a bounded five-consecutive-failure browser reconnect budget that resets after a successful reopen;
- one authoritative run-status reconciliation after the retry budget is exhausted, including replay of retained snapshot output;
- explicit operator-triggered live-stream retry for a still-running reconciled run.

Production-server real-browser coverage now exercises the embedded application in headless Chrome/Chromium with no vendor dependency. It proves bootstrap/session establishment, clean token removal, Host/Origin/CSRF enforcement, authenticated task loading, typed fixture execution, SSE replay, browser-native reconnect with `Last-Event-ID`, bounded stream-failure handling plus snapshot reconciliation, explicit retry/cancellation, bounded retained-run eviction, single-execution semantics, and inert rendering of hostile markup/control-like output. A dedicated raw-TCP slow-reader regression constrains the accepted socket send buffer, stops consuming SSE after the response headers, and proves the per-frame five-second write deadline releases the bounded observer slot without cancelling execution.

A green CI build proves the code compiles/tests on its CI platforms. It does not replace manual Windows acceptance of real default-browser, PATH, filesystem, vendor CLI, authentication, or antivirus/SmartScreen behavior.

## 2. Test layers

### Unit tests

Use deterministic tests for:

- pack YAML/schema/semantic/security validation;
- trusted-source loading and registry immutability;
- path candidate discovery/override policy;
- version parsing and compatibility constraints;
- typed runtime field validation and exact argv construction;
- risk/confirmation rules;
- redaction/output parsers/auth mapping/API validation as those components arrive.

### Integration tests

Use purpose-built fixture executables rather than real vendor credentials in CI. Fixtures should exercise exact argv, stdout/stderr interleaving, exit codes, JSON/malformed output, long-running/cancellation, child spawning, high-volume output, Unicode/spaces in paths/args, interactive-required signals, and secret-like text.

### End-to-end tests

Exercise browser -> authenticated API -> planner -> fixture executable -> streamed events -> UI. CI now runs a production embedded-server headless-Chrome test with the synthetic fixture pack. It covers the security/lifecycle behavior that cannot be established by jsdom or handler tests alone; component and HTTP tests remain the faster deterministic coverage for edge matrices and socket-level slow-reader behavior. Do not replace this with browser E2E that only rechecks static markup.

### Real-tool acceptance

Run separately in an approved environment against exact deployed `idsec`/`conjur` versions. Public CI must never require production credentials.

## 3. Pack validation matrix

Continue testing rejection of:

- unsupported API version;
- duplicate YAML keys/pack/input IDs;
- missing tool/input references;
- illegal risk/input/output values;
- arbitrary executable/path fields and known shell/interpreter/script launchers;
- user-controlled/templated flag names/argument structures;
- malformed optional layouts;
- invalid regex/input-constraint combinations;
- invalid version constraints or a constraint without a version probe;
- unsupported version parser/timeout/probe shapes;
- unknown fields;
- invalid UTF-8;
- aliases/anchors/merges/custom tags/multiple docs;
- excessive size/depth/node count;
- unsafe secret-output metadata;
- symlink/non-regular explicit local entries;
- duplicate pack IDs across sources.

Known-good packs must remain deterministic across caller/filesystem enumeration order.

## 4. Pack loader/registry tests

For future source expansions verify source trust is explicit, cwd contents never become authoritative implicitly, remote URLs do not enter local-source APIs, directory behavior is deliberate/non-recursive, file reads remain bounded, partial invalid sets produce no partial registry, duplicate paths/IDs are deterministic errors, accessors cannot mutate authoritative state, and user-facing errors do not leak directory/secrets.

## 5. Discovery/version tests

For every platform-specific change verify:

- only pack-declared executable basenames are eligible;
- browser values cannot alter executable/path selection;
- absolute PATH entries are searched; empty/relative/cwd entries are ignored;
- Windows extension behavior is limited to intended binary extensions and remains case-insensitive where appropriate;
- Unix executable permission checks are enforced;
- symlink resolution is explicit and final basename policy remains correct;
- duplicate candidate paths are de-duplicated;
- zero/one/multiple candidates map to missing/selected/ambiguous deterministically;
- explicit overrides are authoritative, absolute, regular executable paths tied to a known pack/tool;
- an invalid override never falls back silently;
- unsupported platforms never run probes;
- version probe argv is exactly pack-authored data with no shell;
- timeout/non-zero/cancellation behavior is distinguishable and sanitized;
- stdout/stderr buffers remain bounded;
- no raw probe output leaks into normal diagnostics;
- semantic-version parser accepts one intended version and rejects no-version/multiple-version ambiguity;
- constraint failures produce unavailable tools;
- snapshot accessors are defensive copies.

Manual Windows acceptance should validate real PATH behavior and exact resolved paths on the corporate baseline before release.

## 6. Execution planner tests — Phase 4 baseline implemented

For each input type prove:

- unknown browser fields are rejected;
- required values cannot be omitted;
- JSON/runtime types are exact; integers do not silently become strings/floats;
- string rune-length/regex/leading-dash constraints are enforced server-side;
- enum values are pack-declared only;
- one browser value becomes only its intended argv element(s);
- whitespace/quotes/metacharacters such as `& | ; > < $ ( ) % ! ^` remain data and are never reparsed by a shell;
- omitted optional values omit the entire flag/value pair;
- boolean switches emit only their pack-authored flag;
- enum maps emit only pack-authored literals;
- tool discovery state must be `ready`;
- executable path/name/version/identity are copied only from authoritative discovery state;
- a nominally ready discovery state without identity is rejected as stale;
- planner output is immutable/defensively copied;
- risk policy cannot be downgraded by request input.

Property/fuzz tests are appropriate for runtime value and argv-construction boundaries.

## 7. Executor tests — Phase 4 baseline implemented

Verify:

- executable receives exact planned argv;
- no shell process is spawned for normal tasks;
- selected executable identity is revalidated where required before spawn;
- stdout/stderr remain separately identifiable;
- start failure vs non-zero CLI exit are distinct;
- timeout/cancellation are deterministic, including cancellation before start and after output begins;
- output-limit and sink failures cancel execution;
- partial lifecycle setup failure cleans up the started process and lifecycle boundary;
- same-path executable replacement and metadata-collision content mutation are rejected before spawn;
- Windows descendants are owned by a per-run Job Object before execution resumes and are cleaned up for cancellation, timeout, output-limit, sink-failure, normal teardown, and inherited-output-handle cases;
- output is bounded per stream and `WaitDelay` bounds inherited stdout/stderr handle waits;
- Unicode and spaces in executable paths/args/output work;
- the current executor remains read-only; duplicate/retry semantics for consequential side effects must be designed before mutating commands are enabled.

## 8. Local web security tests

Maintain tests that server binds only loopback, unexpected Host/Origin/mutation requests fail, session/CSRF/bootstrap controls hold, bootstrap URLs clean up and remain token-free in normal startup output, API/bootstrap never fall through to frontend routing, static traversal fails, dev proxy remains explicit loopback-only and strips session/auth/CSRF/cookies, CORS stays restrictive, and CSP avoids unsafe execution.

HTTP boundary tests cover Host/session/Origin/CSRF enforcement for run mutations and authenticated SSE reads. Production real-browser coverage now also verifies hostile-origin rejection. Typed error-boundary tests require stable code/status mapping and prove arbitrary internal causes do not enter browser JSON.

## 9. XSS/output rendering tests

Process output now reaches the UI as Base64-decoded text. Component coverage includes HTML/script-like output remaining inert. Expand the corpus with `javascript:` text, ANSI escapes, extremely long strings, malformed encodings, and future structured fields containing markup. Output must remain inert data and parsing failure must preserve raw non-secret evidence.

## 10. Redaction tests

Prove secrets are absent—not merely hidden—from future input diagnostics, invocation previews, logs, errors, run metadata, stdout/stderr persistence, structured output, and diagnostic bundles.

Current tests already cover local pack path redaction, secret-output metadata constraints, and discovery probe failures not echoing captured output.

## 11. Authentication tests

Once auth orchestration exists, use a fixture CLI for signed-out/login/signed-in, cancellation, non-zero login failure, expiry, logout, status unavailable, and MFA-style interactive behavior without CLIHarbor capturing credentials. Verify actual vendor flow separately.

## 12. Parser resilience

The Phase 5 fixture/parser suite now covers valid reordered scalar JSON, optional/missing fields, malformed JSON, wrong primitive types, unknown fields, duplicate keys, nested objects/arrays, boundary and oversized strings/output, invalid UTF-8, signed-integer overflow, floating-point/NaN-equivalent invalid integer input, ANSI/control characters, markup-like strings, Unicode, stdout+stderr, non-zero exit with structured-looking stdout, cancellation, and secret-like/sensitive-field refusal.

The generic run-manager fixture traverses the real trusted registry -> planner -> executor -> retained-run path and proves parser failure preserves the underlying run/exit state, raw stdout/stderr, and exactly one execution. Completion/replay coverage proves normalized results are cloned per reader, temporary parser buffers are released after completion, and the authenticated SSE `run-complete` event carries the same-run structured DTO. Browser component coverage proves markup-like structured values remain inert React text, normal completion does not require a follow-up GET, and parser failure still displays raw output. Continue adding vendor-specific parser cases only after Phase 0 establishes exact vendor schemas.

## 13. Risk/confirmation tests

Once run APIs exist prove read tasks do not require destructive confirmation, destructive tasks cannot execute without valid backend confirmation, confirmation is bound to the exact target/context/run intent, and stale confirmation cannot be replayed after target/context change.

## 14. UI and accessibility tests

Current component coverage exercises authenticated status loading and typed failure/retry states, server and client input validation, focus movement to invalid controls, `aria-invalid`/description association, inert hostile-looking text, unknown error-code fallback, bounded SSE exhaustion/reconciliation, retained-run eviction, live connection status, timeout text, and keyboard-focusable raw-output regions. The application uses native keyboard-operable controls and targeted live regions so raw stdout/stderr are not continuously announced.

Continue coverage as auth/risk/confirmation surfaces arrive: auth gating, destructive warnings, dialogs, confirmation focus return, reduced motion where motion is introduced, responsive overflow, and no color-only state.

## 15. Windows matrix

Windows CI is first-class for Go/frontend build/test. Manual release acceptance remains required for:

- PATH and `.exe`/`.com` resolution/casing;
- explicit path override with spaces/Unicode;
- default-browser handler behavior;
- no CMD/PowerShell use for normal probes/tasks;
- Windows Job Object descendant ownership/cancellation remains covered by Windows runtime tests;
- locked/readonly config locations;
- Windows Terminal present/absent when auth arrives;
- antivirus/SmartScreen on packaged binaries.

## 16. Real Idira/CyberArk acceptance

After Phase 0 inventory, for each supported deployed version verify exact binary resolution, version parsing/constraint, auth semantics, login/logout, one read-only workflow equivalence with direct CLI output, permission/expiry recovery, structured/raw result fidelity, and absence of sensitive data from CLIHarbor diagnostics/history.

## 17. Release gates

A Windows MVP release requires all applicable unit/integration/security/E2E gates green, manual real-tool acceptance, review of the CI `npm audit` and pinned `govulncheck` results, no undisposed high-severity vulnerability, redacted diagnostics, SHA-256 verification of every privileged file in the packaged evaluation/release bundle, and packaged-binary testing on a clean Windows profile. The current evaluation gate specifically treats root `EVALUATION_SHA256SUMS` as the sole packaged evaluation checksum authority and verifies both the Windows executable and the explicitly trusted Phase 0 pack against it. `bin/SHA256SUMS` remains an executable-only compatibility checksum for ordinary local builds and must be absent from the evaluation bundle. The Windows evaluation job also requires the exact `.go-version` patch toolchain and a controlled Go build environment, builds the upload candidate, then requires that candidate and two isolated evaluation rebuilds to have byte-identical authoritative manifests before upload.

Phases 1-4 low-level foundations are not release qualification. Browser execution integration, auth, output rendering/redaction, real-tool workflows, and release acceptance intentionally remain open.

## Phase 0 work-laptop readiness verification

New regression coverage exercises the evaluation boundary in addition to the pre-existing discovery/planner/executor/server/run/UI suites.

Required cases include:

- inventory-only packs and fixed help-probe schema validation;
- defensive cloning of help-probe metadata;
- missing/ambiguous/incompatible/probe-failed discovery through existing discovery tests;
- bounded probe stdout/stderr and non-zero exit preservation;
- timeout/cancellation process-tree behavior;
- invalid UTF-8 preservation at the runner boundary and sanitization before evidence;
- minimal child environment and neutral working directories so arbitrary parent secrets/caller cwd are not inherited by version/help probes;
- fail-closed version discovery for oversized/truncated or invalid-UTF-8 output;
- executable replacement during a version probe is detected before version evidence is accepted;
- Windows version-probe timeout descendant cleanup through the shared Job Object lifecycle boundary;
- executable-path/common-secret/control-character redaction;
- Phase 0 export schema bounds, sanitized fixed-argv provenance, and omission of zero-value timestamps for probes that did not execute;
- existing-file refusal, relative traversal rejection, cancellation cleanup, restricted staging permissions where supported, concurrent atomic no-clobber activation, and Windows same-directory no-replace move behavior that preserves both an existing destination and the staging file on activation failure;
- CLI flag scoping so inventory selectors cannot become executable/argv input;
- Windows/Linux formatting, vet, unit/integration tests, embedded frontend synchronization, and build;
- Linux `go test -race`;
- dependency vulnerability scan and npm audit;
- Windows evaluation binary `version` and vendor-free `self-test` execution before artifact upload;
- authoritative evaluation-manifest verification after build and immediately before upload, including exact entry set/order, canonical forward-slash paths, case-insensitive duplicate rejection for the Windows target, regular/non-symlink privileged-file enforcement, digest recomputation, and rejection of a packaged `bin/SHA256SUMS` compatibility manifest;
- explicit upload of only `EVALUATION_SHA256SUMS`, the evaluation executable, and the trusted Phase 0 pack.

A real company-laptop run remains environment evidence, not a CI assertion. Application-control/EDR/browser-policy behavior must be reported from the actual managed machine.

## Phase 0 evidence import/review verification

The evidence-consumption boundary adds deterministic regression coverage for:

- valid exporter-to-importer round trips;
- oversized, malformed, unknown-field, duplicate-key, and invalid-UTF-8 JSON;
- malformed semantic versions and version constraints;
- duplicate/cross-tool probe identity and undeclared-provenance attempts;
- impossible discovery candidate counts and probe state/flag combinations;
- missing, reversed, or out-of-capture-window timestamps;
- control-character, common secret/token, path, and environment leakage;
- regular-file enforcement and symlink rejection;
- invalid evidence producing no partial review output;
- bounded quoted output previews and explicit PROVES / UNKNOWN / BLOCKED classifications.

The final exact `main` SHA must continue to pass both Windows and Ubuntu quality jobs, the race detector, dependency scans, and Windows evaluation artifact smoke tests.

## Windows evaluation deterministic-rebuild verification

Regression and CI coverage must prove:

- `.go-version` contains one exact `major.minor.patch` toolchain token and evaluation builds fail when the active bundled Go toolchain differs;
- CI resolves Go from `.go-version` instead of duplicating the patch version in workflow YAML;
- build-environment overrides replace case-variant inherited values without duplicate effective `GO*` entries;
- evaluation builds disable the per-user Go environment file and workspace selection, clear inherited `GOFLAGS`, `GOEXPERIMENT`, `GODEBUG`, and `GOROOT`, force `GOTOOLCHAIN=local`, pin `GOAMD64=v1`, `GOFIPS140=off`, disable cgo, and use private `GOCACHE`/`GOTMPDIR` directories per build;
- the trusted Phase 0 pack is copied from a stable bounded regular-file snapshot into each reproduction root and exact bytes are preserved;
- two separately staged evaluation bundles built from the same checkout, metadata, exact Go toolchain, and controlled environment produce byte-identical `EVALUATION_SHA256SUMS` manifests;
- the already-built evaluation upload candidate independently passes the normal verifier and its authoritative manifest is byte-identical to both staged rebuild manifests;
- each staged reproduction independently passes the normal authoritative bundle verifier;
- the determinism check does not modify or publish the real evaluation artifact paths;
- failure is described as a deterministic-rebuild failure, not as proof of signer identity, cross-machine provenance, host attestation, or independent reproducibility.

## Windows evaluation checksum-authority verification

Regression coverage must prove:

- the authoritative evaluation manifest contains exactly the executable and trusted Phase 0 pack, once each, in deterministic order;
- malformed digests, CRLF/non-terminated lines, traversal, non-canonical paths, backslashes, drive-like paths, and case-insensitive aliases are rejected;
- duplicate normalized artifact inputs fail manifest generation;
- symlink/non-regular privileged files fail verification;
- modifying a covered artifact makes verification fail until the manifest is regenerated from the changed bytes;
- stale generated checksum manifests are explicitly invalidated before a new build mode becomes authoritative;
- checksum publication is staged, synced, atomic/no-replace, and a concurrent same-destination publication allows exactly one writer to succeed;
- evaluation verification fails if local-build compatibility `bin/SHA256SUMS` is present;
- CI re-verifies the same on-disk privileged files immediately before uploading exactly those files plus the root manifest;
- the GitHub artifact archive digest is reported separately and never substituted for privileged-file checksums;
- no checksum or manifest content becomes executable, pack, browser, or workflow authority.

## Phase 0 evidence transfer-integrity verification

Regression coverage must prove:

- export digest equals SHA-256 of the exact activated JSON bytes, including serialization newline;
- read-side digest is computed from the same stable bounded snapshot that is parsed;
- uppercase/lowercase hex normalize to identical digest bytes;
- malformed length/non-hex expected digests fail before file review;
- checksum mismatch emits no partial evidence review;
- a still-valid JSON document modified after digest capture fails verification;
- symlink/non-regular/raced file protections remain in force before hashing;
- checksum calculation alone is never described as signer authentication or environment attestation;
- no checksum input can become executable, argv, pack, browser, or workflow authority;
- the packaged Windows evaluation binary completes a vendor-free `inventory --export` -> `evidence checksum` -> checksum-required `evidence inspect` smoke flow before artifact upload.


## Privacy-preserving diagnostic export verification

Regression coverage for `cliharbor.diagnostics/v1` must prove:

- identical approved state serializes to identical JSON bytes with stable pack/tool ordering;
- schema version, build/runtime tokens, enumerated discovery status, counts, and total serialized size are bounded and validated;
- secret-looking environment values, pack source names/paths, executable/candidate paths, discovery messages, command-output-like values, browser/session/CSRF material, and argv have no route into the DTO;
- malformed/control-bearing or oversized metadata fails closed rather than being emitted and “cleaned” after the fact;
- relative parent traversal is rejected;
- existing, symlink, directory, and special-file destinations are not overwritten;
- unsafe export parents are rejected, including the Windows reparse-point check;
- spaces/Unicode in an otherwise valid destination path work;
- pre-activation cancellation leaves neither destination nor staging debris;
- concurrent exports to one destination yield one complete valid winner and no overwrite;
- private permissions are asserted where the platform provides portable mode semantics;
- Windows no-replace activation works without relying on hard-link support;
- the emitted SHA-256 corresponds to the exact serialized bytes and is not described as signing or attestation;
- diagnostic data never becomes pack, planner, executable, argv, browser, or workflow authority.

These tests complement rather than replace local `doctor` and Phase 0 evidence tests because the three surfaces have intentionally different confidentiality/provenance contracts.
