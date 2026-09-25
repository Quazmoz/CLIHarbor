# Authentication and Session Model

## Objective

CLIHarbor should orchestrate authenticated CLI workflows without becoming an authentication system or credential store.

The wrapped vendor CLI owns passwords, MFA challenges, API keys/tokens, token exchange, session persistence, profile/context, and OS-keystore behavior. CLIHarbor owns only the local workflow/orchestration boundary.

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

CLIHarbor does not:

- ask the browser for vendor passwords;
- accept MFA values;
- pass access tokens/API keys/passwords in argv;
- synthesize terminal keystrokes;
- read a vendor token merely to execute a task;
- provide interactive stdin to the task process;
- persist vendor credentials.

If no usable vendor session exists, the command is expected to fail. The operator then authenticates through the approved vendor-owned flow outside the read-only browser task.

## Conjur 9.x implementation

The official `cyberark/conjur-cli-go` source shows that authenticated command clients use the vendor configuration/authentication layer. CLIHarbor's real Conjur pack therefore uses `vendor-session` for its non-secret read commands.

Examples:

```text
conjur whoami --output json
conjur list ... --output json
conjur resource show <resource-id> --output json
conjur role members <role-id> --output json
```

The Conjur pack does not expose `login`, `authenticate`, secret retrieval, password changes, API-key rotation, or other credential-sensitive operations as browser tasks.

See [Conjur CLI 9.x Integration](CONJUR_INTEGRATION.md).

## Authentication readiness page

The browser exposes a first-class `/authentication` page. It is a session-readiness view, not a credential-entry surface.

The page keeps two trust boundaries explicit:

- **CLIHarbor local session** — the HttpOnly loopback browser session established by CLIHarbor bootstrap;
- **Conjur / Secrets Manager session** — the vendor-owned authentication state used by the official CLI.

Session verification reuses the trusted `cyberark-conjur-v9/whoami` task through the normal run planner/executor and browser run API. The browser does not choose executable paths, argv, flags, or alternate commands.

State is conservative:

- a healthy Conjur executable is only **tool readiness**, never proof of authentication;
- `whoami` exit code `0` is authenticated-session evidence;
- the pinned Conjur CLI 9.3.1 integration suite verifies that `whoami` after logout fails with `Please login again`; CLIHarbor recognizes only that reviewed phrase as signed-out/authentication-required evidence;
- every other non-zero `whoami` result remains **authentication check failed** unless a future reviewed vendor contract adds a deterministic distinction;
- timeout, cancellation, malformed response, stream failure, tool unavailability, and runtime failure remain separate states.

The page never renders raw vendor stderr as UI guidance. It retains bounded output only for this check, matches the reviewed signed-out evidence, and renders only the allowlisted non-secret `account`, `username`, and `user` scalar fields from successful `whoami` JSON. All values are ordinary escaped React text.

A failed or unknown check does not change authorization. Frontend state is presentation only; backend pack, risk, tool, and auth policy remain authoritative.

Direct refresh/navigation is supported for `/authentication`, `/tasks`, and `/diagnostics` through an explicit server-side application-route allowlist. Unknown paths still fail closed.
## Why CLIHarbor does not start with a browser username/password form

A browser credential form would materially expand the trust boundary:

- password/MFA data would enter frontend memory;
- frontend/backend transport and logging would become credential-sensitive;
- argv passing can leak secrets through process inspection;
- vendor authentication methods/MFA challenges vary;
- CLIHarbor would risk duplicating a vendor protocol already implemented by the official CLI.

Therefore direct credential input is not part of the current product contract.

## Future explicit login adapter

A future integration may add vendor-owned login orchestration if real usage requires it. A reviewed adapter would need an explicit interface such as:

```text
Detect() -> capability metadata
Status(ctx) -> AuthState
Login(ctx, approvedMode) -> LoginHandle
Logout(ctx) -> result
```

Possible non-secret auth states:

```text
unknown
signed_out
signing_in
signed_in
expired
error
```

Any such change must preserve these invariants:

- the vendor owns credential validation/token storage;
- credentials are never written to normal logs/run history/URLs;
- secret values are not process-list-visible argv;
- cancellation and challenge/MFA behavior are explicit;
- status detection is based on documented vendor behavior;
- browser UI does not become the authorization boundary.

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
