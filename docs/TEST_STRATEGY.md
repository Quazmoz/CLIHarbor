# Test Strategy

## 1. Testing philosophy

CLIHarbor sits between a browser and powerful local CLIs. Tests must focus on preserving execution intent, preventing unexpected process execution, and failing safely when external tool behavior changes.

The highest-risk code is not the visual UI; it is pack validation/trust, execution planning, auth orchestration, output handling, and Windows process lifecycle.

### Current Phase 1 automated checkpoint

The implemented local-runtime/browser foundation verifies:

- IPv4 loopback-only binding and exact Host rejection;
- bootstrap expiry, invalid-token behavior, one-time consumption, clean post-bootstrap navigation, and session-cookie flags;
- Origin + CSRF enforcement for state-changing requests without exposing the CSRF value to the current frontend API payload;
- authenticated `/api/v1/status` behavior;
- `/bootstrap` and `/api/*` remaining server-owned instead of falling through to frontend handling;
- restrictive browser security headers/CSP;
- embedded production asset serving, unknown-path handling, and traversal rejection;
- loopback-only frontend development proxy configuration;
- browser-launch URL validation, exact bootstrap handoff, token-free normal startup output, and usable fallback when launch fails;
- React status loading, unauthenticated/session-unavailable behavior, and transient retry behavior;
- frontend TypeScript, lint, component tests, and production Vite build;
- generated frontend asset synchronization;
- Go format/vet/tests and final embedded executable build on both Windows and Linux CI;
- Go race detector on Linux.

### Current Phase 2 pack checkpoint

`internal/packs/packs_test.go` now covers the versioned pack parser/validator/loader/registry boundary, including:

- known-good minimal and richer v1 packs;
- unsupported schema version;
- duplicate tool/task/pack IDs;
- missing tool references;
- malformed/unsupported input definitions;
- unknown risk classification and invalid IDs;
- undeclared input references;
- unknown fields and browser-selectable executable-shaped fields;
- arbitrary/templated flag structure attempts;
- missing leading-dash protection for user-derived flag values;
- leading-dash enum values used as flag arguments;
- optional flag/value layout safety;
- executable-path and shell/interpreter declarations;
- YAML anchors/aliases, multiple documents, excessive nesting, invalid UTF-8, and oversized input;
- secret-bearing output requesting unsafe persistence;
- deterministic built-in/directory ordering;
- fail-closed mixed-validity loads;
- duplicate pack IDs;
- explicit local symlink rejection and non-recursive directory loading;
- registry deep-copy/immutability behavior and deterministic lookups;
- explicit-local error-string directory redaction.

The schema additionally bounds fields/collections and rejects unknown fields by default. Phase 2 still does not prove process execution, runtime input-value enforcement, discovery/version compatibility, or HTTP pack exposure because those features do not exist yet.

A green CI build proves the Windows code path compiles/tests and the embedded executable builds there; it does **not** replace manual desktop acceptance of the real default-browser launch on a supported Windows workstation.

## 2. Test layers

### Unit tests

Cover deterministic logic:

- pack parsing/schema/semantic/security validation;
- trusted-source loader behavior and registry immutability;
- version constraints once Phase 3 interprets them;
- typed runtime field validation once the planner exists;
- argument-vector construction;
- risk classification/confirmation rules;
- redaction;
- output parsers;
- auth-state mapping;
- API request validation.

### Integration tests

Use fixture executables rather than real Idira/CyberArk credentials in CI.

Fixtures should eventually simulate:

- stdout/stderr interleaving;
- specific exit codes;
- JSON output;
- malformed output;
- long-running command;
- child process spawning;
- large output;
- interactive-required signal;
- secret-like values for redaction tests.

### End-to-end tests

Once execution exists, exercise browser -> API -> planner -> fixture process -> streamed output -> UI.

### Real-tool acceptance tests

Run manually or in an approved secure environment against actual `idsec`/`conjur` versions. Never require production secrets in public CI.

## 3. Pack validation matrix

The implemented Phase 2 suite must continue rejecting:

- unknown/unsupported schema version;
- duplicate YAML keys and duplicate pack/input IDs;
- missing tool references;
- illegal risk/input/output values;
- arbitrary executable supplied through pack/browser-shaped fields;
- executable paths and known shells/general-purpose interpreters;
- undeclared input references;
- user-controlled/templated flag names or argument structure;
- malformed optional argument layouts;
- malformed regex/constraint combinations;
- unknown fields;
- invalid UTF-8;
- multiple YAML documents, aliases/anchors/merge/custom-tag behavior;
- excessive pack size/nesting/node counts;
- unsafe secret-output persistence/default-reveal combinations;
- symlink/non-regular explicit local pack entries;
- duplicate pack IDs across sources.

The suite must continue accepting known-good minimal and richer packs and proving deterministic load order independent of caller/filesystem enumeration order.

Phase 3 must add incompatible CLI version/discovery ambiguity tests because Phase 2 stores version constraints but does not discover binaries.

## 4. Pack loader/registry tests

For every trusted-source expansion, verify:

- source type is explicit;
- cwd/repository contents do not become authoritative implicitly;
- remote URLs are not accepted through a local-source API;
- directories are non-recursive unless a future design explicitly changes that;
- symlinks and unsupported file types fail closed;
- each file read is bounded;
- partial/mixed-validity sets produce no partial registry;
- duplicate paths and duplicate pack IDs are deterministic errors;
- ordering is stable across input order;
- returned registry values cannot mutate authoritative state;
- errors exposed outside internal diagnostics do not disclose sensitive values/paths.

## 5. Execution planner tests

For every future input type, verify:

- user value becomes exactly one intended argv element unless schema explicitly maps otherwise;
- whitespace is preserved as data rather than reparsed;
- quotes do not change argument boundaries;
- metacharacters such as `& | ; > < $ ( ) % ! ^` remain data;
- values beginning with `-` cannot create undeclared flags/subcommands;
- omitted optional fields do not create malformed flags;
- enum mappings only produce predefined literals;
- values outside constraints fail before process launch;
- executable selection remains entirely outside browser-controlled input.

Property/fuzz testing is appropriate for argument construction and validation boundaries when the planner is implemented.

## 6. Executor tests

Verify once implemented:

- executable receives exact argv expected;
- no shell process is spawned for ordinary tasks;
- stdout/stderr remain separately identifiable;
- non-zero exit is preserved;
- process start failure is distinguishable from CLI exit failure;
- timeout works;
- cancellation works;
- Windows descendant process cleanup works;
- output buffers remain bounded;
- Unicode paths/arguments/output work on Windows;
- spaces in executable paths work correctly.

## 7. Local web security tests

Automate where practical:

- server listens only on loopback;
- unexpected Host rejected for both API and frontend assets;
- unexpected Origin rejected;
- state-changing requests require valid session/CSRF protection;
- bootstrap token is unpredictable, short-lived, and single-use;
- bootstrap URL is cleaned after session establishment;
- `/api/*` and `/bootstrap` cannot be swallowed by frontend routing;
- frontend static paths reject traversal and unknown files safely;
- frontend development proxy accepts only an explicit `http://127.0.0.1:<port>` origin;
- CORS does not allow arbitrary websites;
- CSP/header expectations present and do not require `unsafe-inline` or `unsafe-eval`;
- normal startup output does not disclose the bootstrap token;
- browser-launch failure exposes the bootstrap URL only as the intentional interactive recovery path.

Include a small hostile-origin test page in integration tests when state-changing APIs arrive to attempt localhost requests through a real browser security model.

## 8. XSS/rendering tests

Feed future stdout/stderr/JSON fields containing:

```text
<script>alert(1)</script>
<img src=x onerror=alert(1)>
javascript:...
ANSI escape sequences
very long strings
invalid UTF-8 replacement scenarios
```

Verify output is displayed as inert data and the app remains usable.

The current React shell does not use raw-HTML rendering. When CLI output rendering is introduced, add these fixtures before considering that path complete.

## 9. Redaction tests

Test known secret shapes in:

- future user inputs;
- invocation preview;
- runtime logs;
- errors;
- run metadata;
- stdout/stderr;
- structured output;
- diagnostic bundle.

Assertions should prove secrets are absent, not merely visually hidden.

Phase 2 already tests that explicit-local `LoadError.Error()` does not expose the directory portion of a pack path and that secret-bearing output metadata cannot request raw persistence/default reveal.

## 10. Authentication tests

Using a fixture CLI once auth orchestration exists:

- signed-out -> login process -> signed-in state;
- login cancellation;
- login non-zero failure;
- expired state;
- logout;
- status command unavailable/unknown;
- MFA-style interactive prompt without CLIHarbor capturing credentials.

Real-tool acceptance must verify the actual deployed vendor flow separately.

## 11. Parser resilience tests

For each future custom/structured output parser:

- canonical output;
- empty output;
- extra fields;
- missing fields;
- reordered fields;
- warning text mixed with output if vendor does that;
- malformed JSON;
- new/unknown enum value;
- huge data set.

Parser failure must yield raw output + warning, not fabricated structured data.

## 12. Risk/confirmation tests

Backend tests must prove once execution exists:

- read task executes without destructive confirmation;
- destructive task cannot execute without valid confirmation even if frontend is bypassed;
- confirmation is bound to the intended run/target/context;
- stale confirmation cannot be replayed against a changed target.

## 13. UI tests

The current component tests cover authenticated status loading, browser-session loss, transient API failure/retry, and ensure non-consumed API fields are not rendered. Expand component/unit coverage as the product adds:

- pack/task navigation;
- task form generation;
- validation errors;
- auth gating;
- risk banners;
- command preview redaction;
- run state transitions;
- raw/structured output switching;
- missing/incompatible tool states.

Use browser E2E for the critical happy path and destructive-confirmation path once those user flows exist. Do not add browser E2E that merely re-tests static markup without exercising a consequential contract.

## 14. Accessibility tests

Automated checks plus manual keyboard/screen-reader smoke test:

- tab order;
- focus visibility;
- form label/error association;
- live run-status announcements;
- modal/confirmation focus management;
- no color-only state communication.

## 15. Windows matrix

At minimum test the supported corporate Windows baseline and latest supported Windows version.

Windows CI is a first-class gate for the frontend build, embedded-asset contract, Go tests, platform-specific browser-launch compilation, and final executable build. Manual Windows acceptance is still required before a release for desktop integration that headless CI cannot prove.

Windows-specific future cases:

- PATH discovery;
- `.exe` resolution and case-insensitive explicit-path identity;
- spaces/Unicode paths;
- browser launch through the default-handler mechanism;
- Windows Terminal absent/present when interactive auth arrives;
- CMD/PowerShell not used for ordinary execution;
- process-tree cancellation;
- locked/readonly config directories;
- antivirus/SmartScreen behavior during packaged testing.

## 16. Real Idira/CyberArk acceptance checklist

For each supported CLI version after Phase 0 inventory:

- binary detected correctly;
- version parsed correctly;
- auth status behavior documented;
- login works through vendor-owned flow;
- at least one read-only command matches direct CLI output;
- structured renderer matches source data;
- permission failure is represented correctly;
- expired auth is recoverable;
- no sensitive data lands in CLIHarbor logs/history.

## 17. Release gates

A Windows MVP release requires:

- all unit/integration tests green;
- security test suite green;
- browser E2E happy path green;
- manual real-tool acceptance complete;
- dependency scan reviewed;
- no high-severity known vulnerability without explicit disposition;
- diagnostic output verified redacted;
- packaged binary tested on a clean Windows machine/profile.

Phases 1-2 are foundation gates, not release qualification: discovery/planner/executor/auth/real-tool release criteria above intentionally remain unmet until those features exist.
