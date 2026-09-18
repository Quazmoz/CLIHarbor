# Authentication and Session Model

## 1. Objective

CLIHarbor should make authentication feel integrated without becoming an authentication system.

The wrapped CLI owns credentials, MFA challenges, token exchange, session persistence, and keystore behavior. CLIHarbor owns only orchestration and status presentation.

## 2. Initial Idira/CyberArk facts

Current upstream documentation indicates:

- `idsec` is the official CLI for Idira Identity Security Platform operations.
- `idsec login` can prompt for passwords and MFA as required by the configured authentication method.
- after successful login, `idsec` stores access tokens in the computer keystore for their lifetime.
- the current `conjur-cli-go` project is the supported Go CLI for Idira Secrets Manager.

These upstream behaviors are the basis for the initial design, but implementation must test the exact versions deployed in the target company environment before relying on particular flags/status commands.

## 3. MVP authentication UX

The UI should present a clear status card:

```text
Idira CLI: detected
Version: x.y.z
Profile/context: <value if safely discoverable>
Authentication: Signed out | Signed in | Expired | Unknown
[Sign in] [Refresh status] [Sign out]
```

Selecting **Sign in** should invoke a vendor-owned login flow.

Preferred MVP order:

1. If the CLI has a safe documented browser/device-code login flow, invoke it and monitor status.
2. If login requires interactive terminal prompts, launch the CLI in a separate terminal window owned by the user's session.
3. Once that process completes, re-query auth status and update the browser.
4. If no reliable status command exists, run a safe read-only probe defined by the pack and interpret only documented outcomes.

## 4. Why not start with a browser username/password form?

A browser form can look seamless, but it expands CLIHarbor's security responsibility substantially:

- the password enters frontend memory;
- frontend/backend transport must handle it;
- accidental logs/devtools/error capture become possible;
- command-line argument passing can leak into process listings;
- MFA and challenge flows differ by provider;
- CLIHarbor risks duplicating a vendor authentication protocol that the CLI already handles.

Therefore direct credential entry is **not an MVP requirement**.

## 5. Future credential-form exception

A future pack may define a browser credential flow only if all conditions are met:

- the vendor CLI officially supports an appropriate non-interactive credential input mechanism;
- credentials can be supplied through stdin or another channel that does not expose them in process listings;
- the value is never persisted;
- frontend and runtime logs demonstrably exclude it;
- the feature has explicit threat-model review and tests;
- MFA/challenge semantics remain vendor-controlled or are implemented via a documented supported interface;
- there is a concrete UX need that justifies the additional attack surface.

Even then, the preferred state is for the vendor CLI to cache only its own session token in its existing OS-backed keystore.

## 6. Auth adapter interface

Conceptual adapter contract:

```text
Detect() -> tool capability metadata
Status(ctx) -> AuthState
Login(ctx, mode) -> LoginHandle
Logout(ctx) -> result
```

`AuthState` should avoid carrying secret token material:

```text
unknown
signed_out
signing_in
signed_in
expired
error
```

Optional non-secret fields:

- username/display name if the CLI exposes it safely;
- active profile/context;
- expiration timestamp if documented;
- human-readable remediation.

## 7. External terminal login

For Windows MVP, an interactive login can be launched in a new terminal process when required.

Requirements:

- exact command comes from a trusted pack/adapter;
- CLIHarbor does not synthesize password keystrokes;
- terminal process runs as the current user;
- terminal title/instructions make it clear which tool is authenticating;
- browser shows “Waiting for sign-in…” and provides cancel/recheck controls;
- completion triggers a status refresh;
- output from the auth terminal is not blindly captured into normal run history.

The implementation should evaluate Windows Terminal (`wt.exe`) availability but must have a fallback compatible with standard Windows environments. Do not make a third-party terminal a hard dependency.

## 8. Embedded PTY — later capability

A future embedded terminal could make authentication more seamless, but it introduces:

- keystroke/input handling;
- secret input masking;
- terminal escape sequence parsing;
- potential clipboard concerns;
- a larger browser/runtime attack surface;
- significantly more platform-specific code.

PTY support should be added only after a real workflow requires it.

## 9. Logout

If the wrapped CLI provides a documented logout command, the pack/adapter may expose it.

Logout should clearly state scope: profile, service, or global CLI session. CLIHarbor must not delete keystore files directly as a substitute for vendor logout behavior.

## 10. Multiple profiles/contexts

CLIHarbor should model profile/context as explicit execution context, not global invisible state where possible.

The UI should show the active profile/tenant/account before mutating operations. If a CLI supports selecting a profile via explicit flags, the pack may prefer those flags over hidden global state provided credentials remain vendor-managed.

## 11. Authentication failure behavior

CLIHarbor should distinguish:

- binary missing;
- profile missing;
- signed out;
- token expired;
- MFA/user cancellation;
- permission denied after successful auth;
- network/service error;
- unknown CLI error.

Do not flatten all failures into “login failed.” Preserve sanitized vendor error details.

## 12. Acceptance tests

- signing in through the vendor CLI causes CLIHarbor status to become authenticated without CLIHarbor reading the token;
- passwords/MFA values do not appear in CLIHarbor logs, run metadata, URLs, or frontend persistence;
- cancelled vendor login returns the UI to a recoverable state;
- expired sessions are detected or represented as unknown with a safe re-login path;
- logout uses the vendor command and updates the UI;
- wrong-profile/context risk is visible before change/destructive workflows.

## Phase 0 evaluation authentication behavior

The Phase 0 work-laptop workflow does not add an authentication adapter and does not call vendor login/logout.

`version`, `self-test`, and discovery-only `inventory` require no vendor credential input. Operator-selected evidence probes are allowed only when their fixed read-only argv is explicitly declared in a trusted pack; they receive no interactive stdin and CLIHarbor never supplies username/password/token/MFA values.

The supplied Idira/CyberArk Phase 0 inventory pack contains no evidence probes and therefore cannot invoke vendor authentication accidentally. Existing vendor-owned authentication/profile/keystore semantics remain out of scope until exact deployed-command evidence is collected.

Browser bootstrap/session/CSRF tokens are CLIHarbor-local credentials and are explicitly excluded from Phase 0 evidence exports.
