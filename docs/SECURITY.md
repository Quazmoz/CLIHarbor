# Security Model and Threat Model

## 1. Security posture

CLIHarbor is deliberately local and thin, but it is still security-sensitive because it launches powerful command-line tools and renders their output in a browser.

The security objective is not merely “localhost = safe.” The browser, local processes, packs, output streams, and user input all cross trust boundaries.

## 2. Assets to protect

- Vendor credentials and MFA challenges.
- Access/session tokens managed by wrapped CLIs.
- Secrets returned by wrapped CLIs.
- Tenant/account/context identifiers.
- Local filesystem and process execution authority of the current user.
- Integrity of CLIHarbor packs and command definitions.
- Integrity of user intent for mutating/destructive commands.
- Diagnostic/run metadata.
- CLIHarbor browser-session and CSRF material.

## 3. Trust boundaries

### Trusted with constraints

- CLIHarbor compiled runtime.
- Built-in pack definitions shipped with the runtime.
- Explicitly approved local pack files.
- Resolved official CLI executables after expected-path/version verification.

### Untrusted or potentially hostile

- Browser input.
- Browser origin/request context.
- CLI stdout/stderr.
- CLI error messages.
- User-provided free text.
- Environment variables.
- PATH ordering.
- Repository-local files in an untrusted checkout.
- Development frontend/Vite process and its responses.
- Future third-party packs.
- Any web content opened in the same browser.

## 4. Core security invariants

### SI-1 No arbitrary shell execution

The browser must never submit a free-form command string for execution.

Allowed execution is derived from a validated pack task:

```text
pack task + typed fields -> validated plan -> executable path + args[]
```

Ordinary execution must not use `cmd.exe /c`, `powershell.exe -Command`, `bash -c`, `sh -c`, or equivalent.

### SI-2 No browser-selected arbitrary executable

The browser sends a tool/task identifier. The server resolves the executable from trusted pack definitions and discovery rules.

### SI-3 Loopback only by default

Bind only to loopback interfaces. A future remote mode would be a separate product/security decision requiring authentication, TLS, authorization, and threat-model expansion.

### SI-4 Credentials remain vendor-owned

CLIHarbor must not persist passwords, MFA codes, API tokens, or access tokens.

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

Pack changes are equivalent to changing executable permissions. They require review and schema validation.

## 5. Threats and mitigations

### T1 — Shell/argument injection

**Threat:** user-controlled value changes the meaning of an execution or escapes into a shell.

**Mitigation:** direct process creation with an argument vector; strong field typing; allowlisted flags/subcommands; no shell concatenation.

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

**Mitigation:** packs classify secret-returning tasks/fields; UI requires deliberate reveal/copy interactions; secret output is not persisted in history; diagnostics redact; clipboard behavior is explicit.

### T6 — Secret leakage through arguments

**Threat:** a CLI accepts passwords/secrets as command-line arguments that may be visible in process listings.

**Mitigation:** avoid such command forms where stdin/env/vendor login is available. Mark secret-argument forms unsupported by default. Any exception requires explicit security review.

### T7 — PATH hijacking

**Threat:** a malicious binary earlier on PATH impersonates `idsec.exe` or another tool.

**Mitigation:** show resolved path/version; allow admin/user pinning to known paths; optionally validate publisher/signature/hash in enterprise mode; refuse ambiguous resolution.

### T8 — Malicious pack

**Threat:** a pack points to dangerous executables/flags.

**Mitigation:** trust-source controls, schema restrictions, built-in allowlist semantics, code review, future signatures. Pack loading from arbitrary URLs is forbidden in MVP.

### T9 — Destructive command confusion

**Threat:** user clicks a familiar-looking action against the wrong account/tenant/profile.

**Mitigation:** always show active context; pack declares risk; destructive actions display target/context and require explicit confirmation. For high-impact actions, require typed confirmation or re-entry of a key identifier.

### T10 — Long-running/noisy process DoS

**Mitigation:** timeouts, cancellation, output size limits/backpressure, bounded in-memory history, process-tree cleanup.

### T11 — Browser bootstrap token exposure

**Mitigation:** short-lived single-use secret; exchange immediately for session state; redirect to clean URL; do not print the token on successful automatic browser launch. Print the bootstrap URL only as an explicit local recovery path when browser launch fails.

### T12 — Local privilege boundary confusion

CLIHarbor executes as the current user. It must not silently elevate. If an underlying CLI requires elevation, surface that clearly and fail rather than attempting hidden privilege escalation.

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

- run ID;
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

The redaction engine should be defense-in-depth, not the only protection. Prefer never collecting sensitive fields in the first place.

## 8. Local configuration

Configuration files must contain non-secret preferences only unless a future secure-storage feature is separately designed.

Candidate safe settings:

- binary path overrides;
- chosen pack;
- UI preferences;
- run-history retention setting;
- browser auto-open setting.

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
- use lockfiles;
- enable dependency/security scanning in CI;
- build reproducibly where practical;
- generate release checksums/SBOM in a later release milestone;
- sign Windows release binaries when distribution matures.

## 11. Security test gates

Required before MVP release:

- attempt shell metacharacter injection through every field type;
- attempt arbitrary tool/task ID substitution;
- attempt cross-origin localhost POST from another origin;
- attempt forged Host/Origin headers;
- verify bootstrap token expiry/single use;
- verify development proxy strips CLIHarbor session/auth/CSRF headers and response cookies;
- feed script/HTML payloads through stdout/stderr and parsed fields;
- verify secret fields are absent from logs/history/errors;
- verify pack schema rejects arbitrary executable/argument injection patterns;
- verify process cancellation and timeout cleanup;
- verify unexpected structured output fails safely to raw output.

## 12. Security review triggers

A new review is mandatory before adding:

- remote/network access beyond loopback;
- arbitrary community pack installation;
- embedded interactive terminal/PTY;
- direct credential entry in the browser;
- browser-to-filesystem upload/download flows involving secrets;
- plugin code execution;
- privilege elevation;
- cloud telemetry;
- auto-update of executable code or packs.
