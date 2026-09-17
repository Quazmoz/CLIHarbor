# Security Model and Threat Model

## 1. Security posture

CLIHarbor is deliberately local and thin, but it is still security-sensitive because it is intended to launch powerful command-line tools and render their output in a browser.

The security objective is not merely “localhost = safe.” The browser, local processes, packs, output streams, filesystem, and user input all cross trust boundaries.

Phase 2 adds the privileged pack-definition boundary but does **not** execute packs or expose them through the browser.

## 2. Assets to protect

- Vendor credentials and MFA challenges.
- Access/session tokens managed by wrapped CLIs.
- Secrets returned by wrapped CLIs.
- Tenant/account/context identifiers.
- Local filesystem and future process execution authority of the current user.
- Integrity of CLIHarbor packs and command definitions.
- Integrity of user intent for mutating/destructive commands.
- Diagnostic/run metadata.
- CLIHarbor browser-session and CSRF material.

## 3. Trust boundaries

### Trusted with constraints

- CLIHarbor compiled runtime.
- Built-in pack bytes deliberately supplied by trusted application code.
- Explicitly approved local pack files/directories supplied by a trusted caller.
- Future resolved official CLI executables after expected-path/version verification.

### Untrusted or potentially hostile

- Browser input.
- Browser origin/request context.
- CLI stdout/stderr and error messages.
- User-provided free text.
- Environment variables.
- PATH ordering.
- Repository-local files in an untrusted checkout.
- A repository's `packs/` directory merely because CLIHarbor was launched there.
- Development frontend/Vite process and its responses.
- Future third-party packs until a separate trust decision approves them.
- Any web content opened in the same browser.

## 4. Core security invariants

### SI-1 No arbitrary shell execution

The browser must never submit a free-form command string for execution.

Allowed future execution is derived from a validated pack task:

```text
trusted pack task + typed fields -> validated plan -> executable path + args[]
```

Ordinary execution must not use `cmd.exe /c`, `powershell.exe -Command`, `bash -c`, `sh -c`, or equivalent.

Phase 2 additionally rejects common shells/general-purpose interpreters as v1 tool executable declarations.

### SI-2 No browser-selected arbitrary executable

The browser sends a tool/task identifier. The server will resolve the executable from trusted pack definitions and discovery rules. The v1 pack schema has no browser/user-controlled executable field and accepts executable basenames rather than paths.

### SI-3 Loopback only by default

Bind only to loopback interfaces. A future remote mode would be a separate product/security decision requiring authentication, TLS, authorization, and threat-model expansion.

### SI-4 Credentials remain vendor-owned

CLIHarbor must not persist passwords, MFA codes, API tokens, or access tokens. Pack v1 contains only `requiresAuth` metadata, not credential definitions.

### SI-5 Secrets never enter URLs or normal logs

Sensitive values must not be placed in:

- query strings;
- browser history;
- invocation previews;
- general application logs;
- analytics;
- crash telemetry;
- persisted run history.

The one-time local browser bootstrap token is the narrow exception to the general URL rule: it exists only in a short-lived loopback bootstrap URL, is single-use, and is immediately exchanged for a host-only HttpOnly session cookie followed by a redirect to a clean URL.

### SI-6 Packs are privileged

Pack changes are equivalent to changing future executable/argument permissions. Schema validation does not make an untrusted pack trusted.

Implemented trust sources are explicit: built-in bytes from trusted code and local paths/directories deliberately supplied by a trusted caller. CLIHarbor does not scan the current working directory, auto-trust repository-local packs, load remote URLs, auto-download packs, or execute pack/plugin code.

## 5. Threats and mitigations

### T1 — Shell/argument injection

**Threat:** user-controlled value changes the meaning of an execution or escapes into a shell.

**Current Phase 2 mitigation:** the schema admits only pack-authored literals, fixed flag names with declared scalar inputs, boolean switches, and enum-to-pack-literal maps. Unknown fields/interpolation shapes are rejected. String/enum values used as flag arguments must reject leading `-`, optional flag/value pairs must omit together, and enum maps must be complete. No executor exists yet.

**Future runtime mitigation:** direct process creation with an argument vector; server-side runtime value validation; no shell concatenation; executor accepts only an immutable validated plan.

### T2 — Malicious local web page attacks localhost

**Threat:** an unrelated page in the user's browser issues requests to CLIHarbor on loopback.

**Mitigation:**

- unpredictable per-launch bootstrap/session secret;
- SameSite/HttpOnly session cookie where applicable;
- strict Origin/Host validation;
- CSRF token for state-changing requests if cookie auth is used;
- reject requests without expected browser session context;
- restrictive CORS (normally no cross-origin access);
- bind to an unpredictable ephemeral port when practical.

### T3 — DNS rebinding / Host-header abuse

**Mitigation:** only accept expected loopback Host values and bound port; never trust arbitrary Host headers for security decisions.

### T4 — XSS through CLI output

**Threat:** a CLI prints HTML/script-like content that the UI renders.

**Mitigation:** treat all output as text/data, never raw HTML; use framework escaping; sanitize any rich rendering; define a restrictive Content Security Policy.

### T5 — Secret leakage through output

**Threat:** the wrapped CLI legitimately returns secret data.

**Current Phase 2 mitigation:** pack output can declare `containsSecrets`; such a command is rejected if it simultaneously requests raw persistence or default reveal.

**Future runtime mitigation:** UI requires deliberate reveal/copy interactions; secret output is not persisted in history; diagnostics redact; clipboard behavior is explicit.

### T6 — Secret leakage through arguments

**Threat:** a CLI accepts passwords/secrets as command-line arguments that may be visible in process listings.

**Mitigation:** v1 does not implement a `secret` input type. Avoid secret command-line forms where stdin/env/vendor login is available. Any future secret-input support requires explicit security review.

### T7 — PATH hijacking

**Threat:** a malicious binary earlier on PATH impersonates `idsec.exe` or another tool.

**Mitigation:** Phase 2 accepts only executable basenames in trusted pack metadata and performs no discovery. Phase 3 must show/retain resolved path/version, allow explicit pinning policy, refuse ambiguous resolution, and consider publisher/signature/hash verification where required.

### T8 — Malicious pack

**Threat:** a pack points to dangerous executables/flags or abuses parser features/resource consumption.

**Implemented Phase 2 mitigations:**

- pack source trust is explicit and separate from validation;
- 256 KiB per-pack input bound;
- valid UTF-8 required;
- a single YAML document only;
- YAML aliases, anchors, merge keys, custom tags, non-string mapping keys, duplicate keys, excessive nesting, and excessive node counts are rejected;
- strict JSON Schema with unknown fields rejected;
- unsupported schema versions fail closed;
- executable paths are rejected;
- common shells/interpreters are rejected as v1 tools;
- cross-references/type semantics and argument mappings are validated deterministically;
- local pack files/directories may not be symlinks; directory loads are explicit, non-recursive, regular-file-only, and deterministic;
- local load error strings expose the basename rather than the full directory path;
- remote URL loading and plugin code are absent.

Future signatures/publisher identity may strengthen distribution trust but are not MVP dependencies.

### T9 — Destructive command confusion

**Threat:** user clicks a familiar-looking action against the wrong account/tenant/profile.

**Mitigation:** v1 requires an explicit risk class. Future execution must show active context and enforce backend confirmation for destructive actions; frontend behavior alone is insufficient.

### T10 — Long-running/noisy process DoS

**Future mitigation:** timeouts, cancellation, output size limits/backpressure, bounded in-memory history, process-tree cleanup. Phase 2 spawns no processes.

### T11 — Browser bootstrap token exposure

**Mitigation:** short-lived single-use secret; exchange immediately for session state; redirect to clean URL; do not print the token on successful automatic browser launch. Print the bootstrap URL only as an explicit local recovery path when browser launch fails.

### T12 — Local privilege boundary confusion

CLIHarbor executes as the current user once execution exists. It must not silently elevate. If an underlying CLI requires elevation, surface that clearly and fail rather than attempting hidden privilege escalation.

### T13 — Development frontend proxy receives session authority

**Threat:** a local Vite/development frontend process receives CLIHarbor's HttpOnly browser-session cookie, authorization headers, CSRF material, or sets cookies onto CLIHarbor's authenticated origin through the reverse proxy.

**Mitigation:** development proxy targets are restricted to an explicit `http://127.0.0.1:<port>` origin; CLIHarbor strips cookies, authorization/proxy-authorization, and its CSRF header before forwarding; `Set-Cookie` is removed from development responses. `/bootstrap` and `/api/*` remain server-owned and never fall through to the frontend proxy.

## 6. Authentication-specific rules

See `AUTHENTICATION.md`.

Key rules:

- prefer vendor CLI interactive login;
- do not mirror a password form unless a formally reviewed vendor-supported non-interactive mechanism can receive credentials without command-line/process-list leakage;
- never store the password;
- never expose vendor tokens to frontend JavaScript;
- treat embedded PTY support as a later security-sensitive capability.

## 7. Logging and diagnostics

### Safe-by-default fields

- run ID once runs exist;
- task ID;
- pack ID/version;
- CLI executable basename and version;
- resolved path if policy allows;
- start/end timestamps;
- exit code;
- duration;
- redacted argument names/shape.

### Never log by default

- passwords/MFA codes;
- access/refresh tokens;
- browser-session or CSRF tokens;
- raw secret values;
- full environment blocks;
- secret-bearing stdout/stderr;
- sensitive clipboard content.

Pack parse/validation errors should report stable error category/path rather than echoing supplied values. Explicit-local `LoadError` strings redact directory context.

The redaction engine should be defense-in-depth, not the only protection. Prefer never collecting sensitive fields in the first place.

## 8. Local configuration

Configuration files must contain non-secret preferences only unless a future secure-storage feature is separately designed.

Candidate safe settings:

- explicit approved pack paths;
- binary path overrides;
- chosen pack;
- UI preferences;
- run-history retention setting;
- browser auto-open setting.

Repository-local packs must not be inferred from cwd without an explicit trusted configuration decision.

## 9. Frontend hardening

- strict CSP;
- no `eval`/dynamic script injection;
- no remote CDN dependencies in production build;
- no third-party analytics by default;
- output rendered as escaped text/data;
- dependencies pinned and scanned;
- production assets embedded locally and checked for source/build drift in CI;
- development frontend proxy never receives CLIHarbor session/auth/CSRF credentials;
- minimize dangerous clipboard auto-copy behavior;
- visually distinguish secret values and destructive actions.

## 10. Dependency/supply-chain controls

- keep dependency count low;
- use lockfiles/checksums;
- pack parsing uses pinned `gopkg.in/yaml.v3` and `github.com/santhosh-tekuri/jsonschema/v6` versions;
- enable dependency/security scanning in CI;
- build reproducibly where practical;
- generate release checksums/SBOM in a later release milestone;
- sign Windows release binaries when distribution matures.

## 11. Security test gates

Implemented Phase 2 regression coverage includes:

- supported minimal/richer packs;
- unsupported schema versions;
- duplicate tool/task/pack IDs;
- invalid IDs/types/risk classes;
- missing tool/input references;
- unknown fields;
- executable-path and shell/interpreter attempts;
- arbitrary execution/flag-shape attempts;
- leading-dash input injection policy;
- malformed optional flag layouts;
- YAML anchors/aliases and multiple documents;
- invalid UTF-8, size, and nesting bounds;
- secret-output persistence policy;
- deterministic load ordering and fail-closed mixed validity;
- explicit local symlink rejection;
- registry immutability and lookup ordering;
- explicit-local error path redaction.

Still required before MVP release:

- runtime value-level injection tests for every planner field type;
- arbitrary tool/task substitution through HTTP;
- cross-origin localhost mutation attempts;
- forged Host/Origin requests;
- bootstrap token expiry/single use;
- development proxy credential stripping;
- XSS payloads through actual execution output;
- process cancellation/timeout cleanup;
- parser-failure raw-output fallback.

## 12. Security review triggers

A new review is mandatory before adding:

- remote/network access beyond loopback;
- arbitrary community pack installation;
- embedded interactive terminal/PTY;
- direct credential entry in the browser;
- browser-to-filesystem upload/download flows involving secrets;
- path/secret input types;
- plugin code execution or adapter-defined arbitrary commands;
- privilege elevation;
- cloud telemetry;
- auto-update of executable code or packs.
