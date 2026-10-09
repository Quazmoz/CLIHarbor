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

The `/authentication` route (displayed as **CLI sessions**) consumes this metadata generically for every loaded tool that exposes browser-runnable `vendor-session` work. It keeps two trust boundaries explicit:

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

The browser exposes the password form only for the qualified `cyberark-conjur-v9/conjur` tool while that exact discovered tool is healthy and the current vendor configuration is eligible for the reviewed password adapter. Tool detection is independent from that adapter capability: a healthy Conjur executable remains visible on Overview and `/authentication` even when the current `.conjurrc`/authentication mode prevents browser password sign-in. In that case CLIHarbor keeps the reviewed session check available and reports the limitation as an authentication/configuration condition rather than as failed CLI detection. Both surfaces use the same loopback credential endpoint when the adapter is available and verify the resulting vendor session through the same pack-declared CLI session check.

There are two reviewed states:

- **connection ready** — local Conjur configuration is password-style `authn` or LDAP, uses HTTPS, is not SaaS, and allows credential writes; the page shows identity/password fields;
- **connection setup required** — the local configuration is missing the base server/account information and is otherwise eligible for password-style self-hosted setup; the page shows only HTTPS server URL, account, and standard or LDAP mode until that setup succeeds.

First-run connection setup is deliberately staged before credential entry. While setup is required, the browser renders only the HTTPS server/account/authentication-mode fields and does not render a password input. A successful `POST /api/v1/auth/configure` must complete before the credential form is exposed. This prevents a mistyped or rejected connection setup from receiving a password in the same submission.

The configuration endpoint remains behind the same loopback session/Origin/CSRF boundary. The backend accepts only bounded structured connection fields, revalidates the exact discovered Conjur executable identity, and invokes the official CLI directly with fixed argv equivalent to:

```text
conjur init self-hosted --url <https-url> --account <account>
```

LDAP adds only the reviewed `--authn-type ldap --service-id <id>` flags. CLIHarbor does not expose arbitrary init flags, does not pass a password to the init process, and does not add `--force`, `--insecure`, or `--self-signed`. Existing unsupported/interactive configurations and private/self-signed certificate trust cases remain vendor-owned rather than being silently overwritten or bypassed.

The credential request path is fixed at `POST /api/v1/auth/login`. It inherits the same loopback Host/Origin, HttpOnly session-cookie and CSRF boundary as other mutating APIs, uses `Cache-Control: no-store`, accepts a small strict JSON schema, rejects duplicate/unknown fields and oversized bodies, and returns only reviewed sanitized errors. HTTP 401 from the pinned Conjur API is treated as credential rejection; network/TLS failures, non-401 vendor responses, malformed responses, and local credential-storage failures are reported as authentication unavailable rather than incorrectly asking the operator to re-enter a password.

The credential is never converted into command argv. CLIHarbor calls pinned `conjur-api-go v0.15.4` in-process. The vendor library exchanges the password for a Conjur API key and stores that resulting credential using Conjur's configured storage backend. CLIHarbor does not retain the returned API-key buffer; it clears the returned byte slice after the vendor library has stored it.

The browser clears password state after every attempt. Login requests are not represented as runs, so the secret cannot enter run history, stdout/stderr capture, invocation preview or retry-with-inputs state.

After a successful handoff, the UI immediately executes the existing reviewed `whoami` session check. That check, not the optimistic login response, remains the browser-visible evidence that the vendor session is usable.

The password adapter deliberately rejects OIDC, JWT, cloud/SaaS, certificate, IAM/Azure/GCP and read-only/disabled credential-storage configurations. On Windows, OIDC, JWT, and `cloud` configurations that can persist their vendor session may instead advertise the separate vendor-owned login launcher described below. Certificate, IAM, Azure, GCP, unknown modes, and read-only/disabled credential storage remain outside CLIHarbor's guided sign-in surfaces.

The password bridge now revalidates the discovered Conjur executable's on-disk identity before connection setup, login or official vendor-login launch. A replaced, missing, or altered CLI fails closed even if earlier discovery reported it ready. After a successful password exchange, the bridge re-reads vendor configuration and refuses to report success if the endpoint, account, authentication mode, or writable credential-storage context changed during the attempt. A failed context reconciliation does not imply that a remote login was rolled back: run the reviewed session check before any task. These checks do not make external vendor configuration atomic, and do not replace real-tenant acceptance testing.

### Credential bridge invariants

- vendor code owns credential validation and durable session storage;
- secrets never enter normal logs, diagnostics, run history, URLs, command preview or process-list-visible argv;
- only the exact reviewed Conjur tool identity can use this endpoint;
- connection setup completes before the GUI renders password entry, and setup/login share one bounded single-flight gate;
- after connection init, CLIHarbor reloads and verifies the requested vendor configuration; a timeout/error is reconciled against that authoritative state before failure is reported;
- vendor error bodies/messages are not copied into browser responses;
- network duration is bounded through the vendor client HTTP timeout;
- backend policy and the normal session check remain authoritative after sign-in;
- a browser form is presentation, not authorization.

## Vendor-owned external-terminal login

CLIHarbor implements the ADR-005 external-terminal model for the reviewed Conjur 9.x modes that the official CLI itself handles through `conjur login`: OIDC, JWT, and Idira Secrets Manager SaaS/cloud.

When the backend advertises `conjur-vendor-login`, the authenticated browser may request only the trusted Conjur pack/tool identity. It cannot submit executable path, argv, identity, password, token, browser URL, environment variable, or working directory. The backend reloads the current Conjur configuration, confirms the mode remains eligible, revalidates the exact discovery-time executable identity, and launches exactly:

```text
<verified conjur executable> login
```

On Windows the presentation is selected from the already-validated Conjur authentication mode. OIDC and JWT start the exact executable without a visible console window; OIDC still owns its browser launch and loopback callback, while JWT uses its configured JWT source. Idira SaaS/cloud starts the exact executable in a separate vendor-owned console because the upstream flow may require password, MFA-mechanism, OTP/PIN, security-question, or other interactive input. CLIHarbor does not invoke PowerShell/CMD, synthesize keystrokes, redirect/capture vendor credential interaction, or elevate. Launch success alone is never treated as authentication; the existing reviewed `whoami` session check remains authoritative.

The Windows SaaS/cloud console is hosted by a private CLIHarbor child entry point (`_conjur-login-console`). The parent passes only the approved absolute Conjur path and its discovery-time SHA-256 content evidence. The helper accepts exactly these two fields, rejects other executable basenames and mismatched content, captures/revalidates file identity, opens native `CONIN$`/`CONOUT$` handles, and invokes the vendor with fixed `login` argv. The vendor receives console devices directly; the browser/backend never receives credential keystrokes or output. After the vendor exits, the host keeps the result visible until the operator closes the native window. The host never reads console input, including any keystrokes left buffered after login. This keeps errors visible instead of losing them when the process window closes. The fingerprint is local process evidence, never browser-visible, and does not replace ordinary discovery identity checks.

Console-host handoff failures and hidden login processes that exit non-zero within the bounded startup check return sanitized authentication-unavailable errors. Later vendor failures remain visible in the vendor console or detectable through the authoritative session check. Launch acknowledgement still does not prove authentication.

The launch request inherits CLIHarbor's exact loopback session, Host/Origin and CSRF boundary, strict JSON decoding, and sanitized error taxonomy. The launch action shares the Conjur authentication single-flight gate, so connection setup, password handoff, and vendor-login launch cannot race inside the adapter.

The generic read-only task executor still does not become an interactive terminal or PTY. Other vendor CLIs and Conjur authentication types require their own reviewed adapter/evidence before they may gain a launcher.

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

## macOS boundary

Existing vendor-session tasks, session checks, and the reviewed Conjur HTTPS authn/LDAP password/configuration bridge use the same runtime on macOS. The external vendor-login launcher remains Windows-only. On macOS, complete OIDC/JWT/SaaS or other interactive authentication with the approved official `conjur login` flow in your terminal, then use **Check session** in CLIHarbor. CLIHarbor does not create shell scripts or AppleScript command strings to emulate a vendor terminal.

## Installation from the supported CLI catalog

Installing a missing Conjur CLI through **Add a CLI** enables its existing
reviewed connection/sign-in and audit capabilities after binary qualification,
without restarting. The same vendor-owned credential and authoritative session
check boundaries apply. GitHub CLI and kubectl installation only adds reviewed
tasks; it does not log in, read credentials, or configure an account/cluster.
See [Supported CLI catalog](CLI_CATALOG.md).

## Actual Conjur API connection setup — SaaS

The dedicated Conjur sign-in page now presents **Conjur API connection**, displaying the effective vendor `appliance_url`, account, and environment as read through `conjur-api-go`. It does not create a browser-only Identity portal bookmark or store configuration in localStorage.

- `GET /api/v1/auth/configure` is authenticated, read-only, and returns only sanitized non-secret endpoint/account/environment plus whether safe in-app SaaS configuration is supported.
- First-run SaaS setup allows a single HTTPS `https://<tenant>.secretsmgr.cyberark.cloud` URL; the backend invokes the identity-verified vendor CLI with fixed `init saas --url <url>` arguments. The vendor persists `.conjurrc`, selects `cloud` authentication and its canonical account, and normalizes the effective endpoint to `/api`.
- Already configured SaaS-to-SaaS changes require an explicit browser acknowledgement plus the previous exact SaaS URL. The backend checks current configuration under the existing single-flight gate, refuses stale expected URLs, environment overrides, read-only storage, and other auth modes, and only then uses the vendor `--force` argument to replace the approved SaaS config. No password/MFA enters this API.
- After initialization, the backend reloads the authoritative vendor config and requires exact endpoint/account/mode matches. A vendor timeout after durable write is reconciled against readback; inconsistent state is reported as unavailable rather than falsely saved.
- If a browser API configuration request fails or its completion is ambiguous, the UI discards previously displayed endpoint and replacement-confirmation state. Use **Retry reading CLI configuration** to fetch the effective vendor configuration again before attempting another change; do not assume the previous endpoint remains active. Previously verified session evidence is invalidated before the attempt.
- The browser re-fetches the new connection and invalidates any prior authenticated session-check evidence. A new `whoami` check is required. No session token, credential, or keyring data is copied.
- The separately scoped first-run self-hosted `authn`/LDAP wizard is unchanged. Switching an existing non-SaaS profile to SaaS or replacing unsupported configuration modes is deliberately not offered.

The short Identity hostname `companyname.cyberark.cloud` is an Identity **website**, not a Secrets Manager API endpoint. The corresponding Secrets Manager SaaS tenant endpoint uses `companyname.secretsmgr.cyberark.cloud`; neither example is employer-specific. Authoritative references: `cyberark/conjur-cli-go` `pkg/cmd/initcloud.go` and `cyberark/conjur-api-go`.
