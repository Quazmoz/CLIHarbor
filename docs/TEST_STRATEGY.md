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

A green CI build proves the code compiles/tests on its CI platforms. It does not replace manual Windows acceptance of real default-browser, PATH, filesystem, vendor CLI, authentication, or antivirus/SmartScreen behavior.

## 2. Test layers

### Unit tests

Use deterministic tests for:

- pack YAML/schema/semantic/security validation;
- trusted-source loading and registry immutability;
- path candidate discovery/override policy;
- version parsing and compatibility constraints;
- typed runtime field validation and argv construction once planner exists;
- risk/confirmation rules;
- redaction/output parsers/auth mapping/API validation as those components arrive.

### Integration tests

Use purpose-built fixture executables rather than real vendor credentials in CI. Fixtures should exercise exact argv, stdout/stderr interleaving, exit codes, JSON/malformed output, long-running/cancellation, child spawning, high-volume output, Unicode/spaces in paths/args, interactive-required signals, and secret-like text.

### End-to-end tests

Once general execution exists, exercise browser -> authenticated API -> planner -> fixture executable -> streamed events -> UI. Do not add browser E2E that only rechecks static markup.

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

## 6. Execution planner tests — Phase 4

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
- executable path is copied only from authoritative discovery state;
- planner output is immutable/defensively copied;
- risk policy cannot be downgraded by request input.

Property/fuzz tests are appropriate for runtime value and argv-construction boundaries.

## 7. Executor tests — Phase 4+

Verify:

- executable receives exact planned argv;
- no shell process is spawned for normal tasks;
- selected executable identity is revalidated where required before spawn;
- stdout/stderr remain separately identifiable;
- start failure vs non-zero CLI exit are distinct;
- timeout/cancellation are deterministic;
- Windows descendant cleanup works;
- output buffering/backpressure is bounded;
- Unicode and spaces in executable paths/args/output work;
- duplicate/retry behavior cannot accidentally create a second consequential side effect without explicit semantics.

## 8. Local web security tests

Maintain tests that server binds only loopback, unexpected Host/Origin/mutation requests fail, session/CSRF/bootstrap controls hold, bootstrap URLs clean up and remain token-free in normal startup output, API/bootstrap never fall through to frontend routing, static traversal fails, dev proxy remains explicit loopback-only and strips session/auth/CSRF/cookies, CORS stays restrictive, and CSP avoids unsafe execution.

Add hostile-origin real-browser coverage when consequential state-changing run APIs arrive.

## 9. XSS/output rendering tests

When process output reaches the UI, feed HTML/script-like strings, `javascript:` text, ANSI escapes, extremely long strings, malformed encodings, and structured fields containing markup. Output must remain inert data and parsing failure must preserve raw evidence.

## 10. Redaction tests

Prove secrets are absent—not merely hidden—from future input diagnostics, invocation previews, logs, errors, run metadata, stdout/stderr persistence, structured output, and diagnostic bundles.

Current tests already cover local pack path redaction, secret-output metadata constraints, and discovery probe failures not echoing captured output.

## 11. Authentication tests

Once auth orchestration exists, use a fixture CLI for signed-out/login/signed-in, cancellation, non-zero login failure, expiry, logout, status unavailable, and MFA-style interactive behavior without CLIHarbor capturing credentials. Verify actual vendor flow separately.

## 12. Parser resilience

For each structured/custom output parser test canonical/empty/extra/missing/reordered fields, warning text, malformed JSON, unknown enums, and large data. Failure must yield raw output + warning, never fabricated success data.

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
- future Windows process-tree cancellation;
- locked/readonly config locations;
- Windows Terminal present/absent when auth arrives;
- antivirus/SmartScreen on packaged binaries.

## 16. Real Idira/CyberArk acceptance

After Phase 0 inventory, for each supported deployed version verify exact binary resolution, version parsing/constraint, auth semantics, login/logout, one read-only workflow equivalence with direct CLI output, permission/expiry recovery, structured/raw result fidelity, and absence of sensitive data from CLIHarbor diagnostics/history.

## 17. Release gates

A Windows MVP release requires all applicable unit/integration/security/E2E gates green, manual real-tool acceptance, dependency scan review, no undisposed high-severity vulnerability, redacted diagnostics, and packaged-binary testing on a clean Windows profile.

Phases 1-3 are foundations, not release qualification. Planner/executor/auth/real-tool/browser-workflow requirements intentionally remain open.
