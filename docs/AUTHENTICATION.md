# Authentication and Session Model

## Objective

CLIHarbor should orchestrate authenticated CLI workflows without becoming an authentication system or credential store.

The vendor authentication stack owns credential validation, token/API-key exchange, durable session persistence, profile/context, and credential-storage behavior. CLIHarbor owns only the local workflow/orchestration boundary. A reviewed adapter may transiently carry a credential from the authenticated loopback browser to that vendor stack, but CLIHarbor must not persist it or reinterpret the vendor protocol.

## Current authentication capabilities

CLIHarbor distinguishes two states in pack metadata:

### Generic authentication requirement

```yaml
requirements:
  requiresAuth: true
```

This alone does **not** grant executable browser authority. A generic auth-required task remains fail-closed because CLIHarbor has no general authentication adapter or credential-input contract.

### Existing vendor-owned session

A read-only pack command may explicitly declare:

```yaml
requirements:
  requiresAuth: true
  authMode: vendor-session
```

This mode is implemented.

It means CLIHarbor may launch the verified read-only vendor command and let that command use its existing vendor configuration/session/OS-keystore behavior.

For ordinary `vendor-session` task execution, CLIHarbor does not:

- pass access tokens/API keys/passwords in argv;
- synthesize terminal keystrokes;
- read a vendor token merely to execute a task;
- provide interactive credential stdin to the task process;
- persist vendor credentials.

If no usable vendor session exists, the command fails or the Authentication page can use a separately reviewed vendor credential adapter when one is advertised.

## Conjur 9.x implementation

The official `cyberark/conjur-cli-go` source shows that authenticated command clients use the vendor configuration/authentication layer. CLIHarbor's real Conjur pack therefore uses `vendor-session` for its non-secret read commands.

Examples:

```text
conjur whoami --output json
conjur list ... --output json
conjur resource show <resource-id> --output json
conjur role members <role-id> --output json
```

The Conjur pack still does not expose `login`, `authenticate`, secret retrieval, password changes, API-key rotation, or other credential-sensitive operations as browser tasks. Credential handoff is implemented only through the narrow backend adapter described below, never as a pack command.

See [Conjur CLI 9.x Integration](CONJUR_INTEGRATION.md).

## Authentication readiness metadata and page

The pack/runtime contract now supports declarative, presentation-only session-check metadata. A tool that has browser-runnable `vendor-session` commands is reported by the backend as requiring a vendor session. A pack may additionally declare one reviewed check:

```yaml
runtime:
  tools:
    conjur:
      sessionCheck:
        commandId: whoami
        unauthenticatedStderrContains: "please login again"
```

The declared command must belong to the same tool, be read-only, have no browser inputs, return no secret-bearing output, and require `authMode: vendor-session`. Invalid declarations fail pack loading. The optional stderr marker is bounded trusted metadata intended only to distinguish one reviewed signed-out condition from otherwise unknown vendor failures.

This metadata is exposed through the sanitized tool diagnostics API so the browser can become pack-driven without gaining executable, argv, or credential authority.

The `/authentication` page consumes this metadata generically for every loaded tool that exposes browser-runnable `vendor-session` work. It keeps two trust boundaries explicit:

- **CLIHarbor local session** — the HttpOnly loopback browser session established by CLIHarbor bootstrap;
- **vendor CLI session** — authentication state owned by the official CLI, its configuration, and its OS/vendor credential facilities.

Session verification reuses only the pack-declared session-check task through the normal run planner/executor and browser run API. The browser does not choose executable paths, argv, flags, or alternate commands, and it additionally requires the exposed task metadata to remain zero-input before enabling the check.

State remains conservative:

- a healthy executable is only **tool readiness**, never proof of authentication;
- a declared session-check exit code `0` is authenticated-session evidence;
- a non-zero result is **authentication required** only when stderr contains the optional pack-reviewed marker;
- every other non-zero result remains **authentication check failed**;
- timeout, cancellation, malformed response, stream failure, tool unavailability, and runtime failure remain separate states;
- a vendor-session tool with no declared safe check is shown as **Session check unavailable** and CLIHarbor does not invent one from context files, arbitrary commands, or unrelated failures.

The current Conjur pack declares `whoami` as its check. The pinned Conjur CLI 9.3.1 integration evidence establishes `Please login again` as the reviewed signed-out marker. kubectl deliberately has no generic check because kubeconfig presence, current-context visibility, API reachability, authentication, and authorization are distinct states.

The page never renders raw vendor stderr as UI guidance. It retains bounded output only while evaluating a reviewed check and renders only the allowlisted non-secret `account`, `username`, and `user` scalar fields when successful JSON happens to provide them. All values are ordinary escaped React text.

A failed or unknown check does not change authorization. Frontend state is presentation only; backend pack, risk, tool, and execution policy remain authoritative.

Direct refresh/navigation is supported for `/authentication`, `/tasks`, and `/diagnostics` through an explicit server-side application-route allowlist. Unknown paths still fail closed.

## Reviewed Conjur password bridge

CLIHarbor now implements one explicit credential adapter for the qualified Conjur integration. It is **not** a generic secret input type and it is not pack-authored command authority.

The browser exposes the form only when:

- the qualified `cyberark-conjur-v9/conjur` tool is healthy;
- local Conjur configuration can be loaded;
- the configured authentication type is password-style `authn` or LDAP;
- Conjur credential storage is enabled for writes.

The request path is fixed at `POST /api/v1/auth/login`. It inherits the same loopback Host/Origin, HttpOnly session-cookie and CSRF boundary as other mutating APIs, uses `Cache-Control: no-store`, accepts a small strict JSON schema, rejects duplicate/unknown fields and oversized bodies, and returns only reviewed sanitized errors.

The credential is never converted into command argv. CLIHarbor calls pinned `conjur-api-go v0.15.4` in-process. The vendor library exchanges the password for a Conjur API key and stores that resulting credential using Conjur's configured storage backend. CLIHarbor does not retain the returned API-key buffer; it clears the returned byte slice after the vendor library has stored it.

The browser clears password state after every attempt. Login requests are not represented as runs, so the secret cannot enter run history, stdout/stderr capture, invocation preview or retry-with-inputs state.

After a successful handoff, the UI immediately executes the existing reviewed `whoami` session check. That check, not the optimistic login response, remains the browser-visible evidence that the vendor session is usable.

The adapter deliberately rejects or does not advertise OIDC, JWT, certificate, IAM/Azure and read-only/disabled credential-storage configurations. MFA/challenge flows and other interactive modes remain vendor-owned.

### Credential bridge invariants

- vendor code owns credential validation and durable session storage;
- secrets never enter normal logs, diagnostics, run history, URLs, command preview or process-list-visible argv;
- only the exact reviewed Conjur tool identity can use this endpoint;
- only one login attempt is admitted at a time;
- vendor error bodies/messages are not copied into browser responses;
- network duration is bounded through the vendor client HTTP timeout;
- backend policy and the normal session check remain authoritative after sign-in;
- a browser form is presentation, not authorization.

## External-terminal login

If a future vendor workflow truly requires interactive terminal authentication, the preferred model is a separate vendor-owned terminal process in the current user's session rather than a password form in CLIHarbor.

Requirements would include:

- exact command from a trusted pack/adapter;
- no synthesized password keystrokes;
- no silent elevation;
- clear terminal ownership/title;
- bounded wait/cancellation;
- no blind capture of interactive credential output into run history.

This is not currently implemented by the generic read-only task executor.

## Embedded PTY

An embedded PTY remains deferred because it would introduce secret keystroke handling, masking, escape-sequence parsing, clipboard concerns, and substantial platform-specific attack surface.

## Logout

If/when logout is exposed, it must use a documented vendor command and accurately state its scope. CLIHarbor must never delete vendor keystore/session files directly as a substitute for vendor logout behavior.

## Profiles and contexts

Profile/tenant/account context should be explicit where the vendor CLI exposes it safely. CLIHarbor must not infer authorization from a displayed profile name. For future mutations, exact target/context will need to be bound into backend confirmation.

## Failure behavior

Authentication-related failures should remain distinguishable where the vendor contract permits safe classification:

- signed out / no cached session;
- expired session;
- user/MFA cancellation in a vendor-owned flow;
- permission denied after authentication;
- network/service failure;
- unknown sanitized vendor failure.

Do not flatten every failure into a misleading generic success/failure state, and do not expose credential material in diagnostics.

## Phase 0

The discovery-only Phase 0 pack still performs no vendor login/logout and contains no credential authority. Version/help evidence probes are fixed read-only argv and receive no interactive stdin.

Browser bootstrap/session/CSRF tokens are CLIHarbor-local credentials and remain excluded from Phase 0 evidence exports.
