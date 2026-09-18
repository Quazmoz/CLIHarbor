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

Real-browser reconnect/eviction/slow-reader coverage remains desirable beyond the current HTTP/component boundaries.

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

Exercise browser -> authenticated API -> planner -> fixture executable -> streamed events -> UI. Current component and HTTP integration tests cover the individual boundaries; add a production-server real-browser test for reconnect, cancellation, eviction, and hostile-origin behavior before release. Do not add browser E2E that only rechecks static markup.

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

HTTP boundary tests cover Host/session/Origin/CSRF enforcement for run mutations and authenticated SSE reads. Add hostile-origin real-browser coverage before release so browser behavior is verified in addition to handler semantics.

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

Current component coverage handles authenticated status loading and failure/retry states. Expand as pack/tool/task UI arrives: discovery states, task forms, validation, auth gating, risk banners, preview redaction, run transitions, output modes, keyboard/focus/live-region semantics, labels/errors, reduced motion, and no color-only state.

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

A Windows MVP release requires all applicable unit/integration/security/E2E gates green, manual real-tool acceptance, review of the CI `npm audit` and pinned `govulncheck` results, no undisposed high-severity vulnerability, redacted diagnostics, SHA-256 checksum verification for the packaged executable, and packaged-binary testing on a clean Windows profile.

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
- existing-file refusal, relative traversal rejection, cancellation cleanup, restricted staging permissions where supported, and concurrent atomic no-clobber activation;
- CLI flag scoping so inventory selectors cannot become executable/argv input;
- Windows/Linux formatting, vet, unit/integration tests, embedded frontend synchronization, and build;
- Linux `go test -race`;
- dependency vulnerability scan and npm audit;
- Windows evaluation binary `version` and vendor-free `self-test` execution before artifact upload.

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
