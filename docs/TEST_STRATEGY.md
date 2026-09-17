# Test Strategy

## 1. Testing philosophy

CLIHarbor sits between a browser and powerful local CLIs. Tests must focus on preserving execution intent, preventing unexpected process execution, and failing safely when external tool behavior changes.

The highest-risk code is not the visual UI; it is pack validation, execution planning, auth orchestration, output handling, and Windows process lifecycle.

### Current Phase 1 automated checkpoint

The implemented local-runtime/browser foundation currently verifies:

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

A green CI build proves the Windows code path compiles/tests and the embedded executable builds there; it does **not** replace manual desktop acceptance of the real default-browser launch on a supported Windows workstation.

## 2. Test layers

### Unit tests

Cover deterministic logic:

- pack parsing/schema/semantic validation;
- version constraints;
- typed field validation;
- argument-vector construction;
- risk classification/confirmation rules;
- redaction;
- output parsers;
- auth-state mapping;
- API request validation.

### Integration tests

Use fixture executables rather than real Idira/CyberArk credentials in CI.

Fixtures should simulate:

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

Exercise browser -> API -> planner -> fixture process -> streamed output -> UI.

### Real-tool acceptance tests

Run manually or in an approved secure environment against actual `idsec`/`conjur` versions. Never require production secrets in public CI.

## 3. Pack validation matrix

Test rejection of:

- unknown schema major version;
- duplicate IDs;
- missing tool references;
- illegal risk values;
- arbitrary executable supplied through task input;
- undeclared flags;
- malformed regex/constraints;
- invalid output definitions;
- unsupported platform;
- incompatible CLI version.

Test success for known-good minimal and complex packs.

## 4. Execution planner tests

For every input type, verify:

- user value becomes exactly one intended argv element unless schema explicitly maps otherwise;
- whitespace is preserved as data rather than reparsed;
- quotes do not change argument boundaries;
- metacharacters such as `& | ; > < $ ( ) % ! ^` remain data;
- omitted optional fields do not create malformed flags;
- enum mappings only produce predefined literals;
- values outside constraints fail before process launch.

Property/fuzz testing is appropriate for argument construction and validation boundaries.

## 5. Executor tests

Verify:

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

## 6. Local web security tests

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

## 7. XSS/rendering tests

Feed stdout/stderr/JSON fields containing:

```text
<script>alert(1)</script>
<img src=x onerror=alert(1)>
javascript:...
ANSI escape sequences
very long strings
invalid UTF-8 replacement scenarios
```

Verify output is displayed as inert data and the app remains usable.

The Phase 1 React shell does not use raw-HTML rendering. When CLI output rendering is introduced, add these fixtures before considering that path complete.

## 8. Redaction tests

Test known secret shapes in:

- user inputs;
- invocation preview;
- runtime logs;
- errors;
- run metadata;
- stdout/stderr;
- structured output;
- diagnostic bundle.

Assertions should prove secrets are absent, not merely visually hidden.

## 9. Authentication tests

Using a fixture CLI:

- signed-out -> login process -> signed-in state;
- login cancellation;
- login non-zero failure;
- expired state;
- logout;
- status command unavailable/unknown;
- MFA-style interactive prompt without CLIHarbor capturing credentials.

Real-tool acceptance must verify the actual deployed vendor flow separately.

## 10. Parser resilience tests

For each custom/structured parser:

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

## 11. Risk/confirmation tests

Backend tests must prove:

- read task executes without destructive confirmation;
- destructive task cannot execute without valid confirmation even if frontend is bypassed;
- confirmation is bound to the intended run/target/context;
- stale confirmation cannot be replayed against a changed target.

## 12. UI tests

The current Phase 1 component tests cover authenticated status loading, browser-session loss, transient API failure/retry, and ensure non-consumed API fields are not rendered. Expand component/unit coverage as the product adds:

- task form generation;
- validation errors;
- auth gating;
- risk banners;
- command preview redaction;
- run state transitions;
- raw/structured output switching;
- missing/incompatible tool states.

Use browser E2E for the critical happy path and destructive-confirmation path once those user flows exist. Do not add browser E2E that merely re-tests static markup without exercising a consequential contract.

## 13. Accessibility tests

Automated checks plus manual keyboard/screen-reader smoke test:

- tab order;
- focus visibility;
- form label/error association;
- live run-status announcements;
- modal/confirmation focus management;
- no color-only state communication.

## 14. Windows matrix

At minimum test the supported corporate Windows baseline and latest supported Windows version.

Windows CI is a first-class gate for the frontend build, embedded-asset contract, Go tests, platform-specific browser-launch compilation, and final executable build. Manual Windows acceptance is still required before a release for desktop integration that headless CI cannot prove.

Windows-specific cases:

- PATH discovery;
- `.exe` resolution;
- spaces/Unicode paths;
- browser launch through the default-handler mechanism;
- Windows Terminal absent/present;
- CMD/PowerShell not used for ordinary execution;
- process-tree cancellation;
- locked/readonly config directories;
- antivirus/SmartScreen behavior during packaged testing.

## 15. Real Idira/CyberArk acceptance checklist

For each supported CLI version:

- binary detected correctly;
- version parsed correctly;
- auth status behavior documented;
- login works through vendor-owned flow;
- at least one read-only command matches direct CLI output;
- structured renderer matches source data;
- permission failure is represented correctly;
- expired auth is recoverable;
- no sensitive data lands in CLIHarbor logs/history.

## 16. Release gates

A Windows MVP release requires:

- all unit/integration tests green;
- security test suite green;
- browser E2E happy path green;
- manual real-tool acceptance complete;
- dependency scan reviewed;
- no high-severity known vulnerability without explicit disposition;
- `doctor` output verified redacted;
- packaged binary tested on a clean Windows machine/profile.

Phase 1 CI is a foundation gate, not a release qualification: pack/executor/auth/real-tool release criteria above intentionally remain unmet until those features exist.
