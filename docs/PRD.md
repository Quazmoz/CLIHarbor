# Product Requirements Document

## 1. Product summary

CLIHarbor is a local browser UI that turns approved command-line workflows into approachable, auditable graphical workflows without replacing the underlying CLI.

The first production use case is Palo Alto Networks Idira / CyberArk tooling, particularly `idsec` and `conjur`. The broader product direction is a generic engine that can support additional CLIs through declarative packs.

CLIHarbor is not a terminal emulator, remote shell, credential manager, cloud service, or API replacement.

## 2. Problem

Many capable enterprise tools expose their best or only automation surface through a CLI. That can create avoidable friction for users who:

- do not remember complex subcommand trees and flags;
- need discoverable forms, tables, filters, and guided workflows;
- want safer confirmation around destructive operations;
- need repeatable workflows without writing scripts;
- are forced into poor or incomplete vendor GUIs;
- already have an approved CLI but would face lengthy approval cycles for a separate third-party GUI.

For the initial Idira/CyberArk use case, the user already works with the vendor CLI from PowerShell/CMD. The desired outcome is a better local UX over that existing trusted execution path.

## 3. Product thesis

The fastest, safest path is to keep the wrapped CLI as the authority and add only a thin local presentation/orchestration layer.

The initial product should be deliberately narrow: solve real Idira/CyberArk workflows first, then extract a reusable pack model. This avoids building a speculative universal abstraction before real command patterns and failure modes are understood.

## 4. Goals

### G1 — One-command local launch

A developer or operator should be able to run a single CLIHarbor command and have a browser open to the local UI.

Development target:

```text
git clone ...
<bootstrap command>
<run command>
# browser opens on loopback
```

Packaged target:

```text
cliharbor
```

or, when embedded in an internal company CLI:

```text
<company-cli> ui
```

### G2 — Thin execution layer

For ordinary commands, CLIHarbor directly launches the target executable with an explicit argument vector. It does not invoke PowerShell/CMD merely because the user normally runs the command there.

### G3 — Secure auth delegation

CLIHarbor should not persist or own vendor credentials. Initial authentication should use the wrapped CLI's supported login/session mechanisms. If an interactive login is required, CLIHarbor may launch/attach an approved interactive flow while the vendor CLI remains responsible for credentials and session storage.

### G4 — Better UX than raw CLI

Users should receive:

- discoverable workflows;
- validated fields and sensible defaults;
- context/profile visibility;
- structured results where possible;
- progress and streaming logs;
- exact error/exit-state visibility;
- warnings and confirmation for risky actions;
- copyable equivalent CLI representation where safe.

### G5 — Generic architecture

The Idira/CyberArk implementation should sit on a generic runtime capable of loading versioned CLI packs. New CLI support should usually require a pack plus optional narrowly-scoped adapter/parser code, not a fork of the application.

## 5. Non-goals for MVP

- Automatic support for every installed CLI.
- Arbitrary shell access from the browser.
- Remote multi-user access.
- Centralized credential storage.
- Cloud-hosted execution.
- Reimplementation of Idira/CyberArk REST APIs.
- Replacement of vendor authorization, MFA, keystore, or profile semantics.
- Full embedded terminal/PTY unless a required auth/workflow cannot be handled safely without it.
- Cross-platform parity at launch. Windows is first.

## 6. Primary personas

### Operator

Uses a vendor CLI but prefers a guided UI for repeatable tasks. Needs speed, correctness, and clear context.

### Power user / engineer

Comfortable with the CLI and wants CLIHarbor to accelerate common operations while retaining transparency into the actual command invocation.

### Pack author

Adds support for another CLI or new command family using declarative definitions, schemas, parsers, and tests.

### Security/reviewer

Needs confidence that CLIHarbor is local-only by default, cannot become an arbitrary shell, does not store credentials, and preserves sufficient evidence for troubleshooting/audit without leaking secrets.

## 7. Initial Idira/CyberArk experience

The initial pack should expose a curated set of high-value workflows after command discovery against the versions used in the target environment.

Before hard-coding command names, implementation must inventory:

- installed `idsec` version and command tree;
- installed `conjur` version and command tree;
- available structured-output flags;
- profile/context commands;
- login/status/logout semantics;
- commands that prompt interactively;
- read-only vs mutating/destructive operations;
- values that can contain secrets and therefore require redaction.

The first UI should include:

- environment/tool status;
- binary discovery and version display;
- authentication/session status;
- login entry point that delegates to the CLI;
- profile/context selection when supported;
- curated task navigation;
- generated forms from pack definitions;
- execution stream/results;
- run history for non-secret metadata in the current local session;
- raw-output fallback.

## 8. Functional requirements

### FR-1 Tool discovery

The runtime shall locate pack-declared executables using Windows PATH and approved configured locations.

It shall report:

- resolved executable path;
- version where detectable;
- whether the version satisfies pack constraints.

Unknown/multiple ambiguous binaries must be surfaced rather than silently guessed.

### FR-2 Pack loading

The runtime shall load signed/trusted repository-local packs initially and validate them against a versioned schema.

Invalid packs shall not execute.

### FR-3 Command construction

A UI action shall resolve to:

- executable identifier;
- subcommand/constant arguments;
- validated user-supplied argument values;
- optional working directory/environment entries from an allowlisted definition;
- execution policy metadata.

User input shall never be concatenated into a shell command string.

### FR-4 Execution

The runtime shall:

- launch the process as the current user;
- capture stdout/stderr separately;
- stream output to the UI;
- capture exit code and duration;
- support cancellation;
- enforce configurable execution timeout where appropriate;
- terminate child process trees safely on cancellation where feasible on Windows.

### FR-5 Output presentation

Packs may declare output modes:

- raw text;
- JSON;
- line-delimited JSON;
- delimited table;
- custom adapter/parser.

If parsing fails, CLIHarbor must preserve the raw output and clearly mark structured rendering as unavailable.

### FR-6 Authentication

CLIHarbor shall support auth states such as unknown, unauthenticated, authenticated, expired, and error where the wrapped CLI exposes enough information.

The MVP shall not save passwords/MFA codes/tokens.

### FR-7 Risk classification

Every command shall have a risk class such as:

- `read`;
- `change`;
- `destructive`;
- `credential-sensitive`;
- `interactive`.

`destructive` commands require explicit confirmation and target context.

### FR-8 Run metadata

For troubleshooting, CLIHarbor shall capture non-secret run metadata including run ID, pack version, CLI version, start/end timestamps, exit code, and a redacted invocation representation.

### FR-9 Browser lifecycle

The local server should choose an available loopback port, issue a short-lived per-launch browser bootstrap token or equivalent anti-cross-origin mechanism, open the default browser, and reject untrusted origins/requests.

### FR-10 Clean shutdown

Closing CLIHarbor should stop accepting new work, cancel or gracefully complete running commands according to policy, and release the local port.

## 9. Security/privacy requirements

See `SECURITY.md` for the threat model. Product-level requirements include:

- bind to `127.0.0.1` / `::1` only by default;
- do not expose arbitrary executable paths from browser input;
- origin/CSRF protection even on loopback;
- browser-visible output HTML-escaped/safely rendered;
- redact secret fields and known secret output patterns from persisted diagnostics;
- do not send telemetry by default;
- do not write auth secrets to disk;
- never put passwords/tokens in URLs, command-history-like logs, analytics, crash reports, or invocation previews;
- treat pack files as privileged code/configuration.

## 10. UX requirements

The UI should feel like an operator console rather than a terminal skin.

Key pages:

1. **Home / Tool status** — installed CLIs, versions, auth state, active context.
2. **Tasks** — grouped pack-defined workflows.
3. **Task form** — validated inputs, explanation, risk notice, preview.
4. **Run view** — status, structured results, stdout/stderr, cancel/retry.
5. **History** — local redacted run metadata for the current configured retention period.
6. **Settings** — binary overrides, pack selection, diagnostics, local-only assurances.

The UI must work at common enterprise laptop widths, keyboard navigation must be first-class, and controls should not require pointer-only interaction.

## 11. Packaging and adoption

MVP development should use ordinary source workflows. Release builds should minimize external runtime dependencies.

Preferred Windows distribution:

- one signed `cliharbor.exe` where possible;
- embedded frontend assets;
- repository-local/default pack bundled into executable or alongside in a clear trusted directory;
- optional `cliharbor doctor` command for environment diagnosis.

The architecture must also support embedding the same local server/pack engine into a larger internal CLI in the future.

## 12. Success criteria

The first milestone is successful when a Windows user can:

1. install/clone CLIHarbor;
2. launch it with one command;
3. see whether the supported Idira/CyberArk CLI is installed and authenticated;
4. initiate vendor-owned login if needed;
5. execute at least one read-only real workflow from the browser;
6. view structured or faithful raw output;
7. see the exact sanitized invocation and exit status;
8. complete the workflow without CLIHarbor ever persisting their password or token.

A second milestone is successful when the same runtime loads a second, materially different CLI pack without Idira-specific code changes to the core execution path.

## 13. Open questions to resolve during implementation

- What language and extension mechanism does the internal company CLI use, and should CLIHarbor embed directly or ship as a companion binary?
- Which exact Idira/CyberArk workflows provide the highest internal value for the first vertical slice?
- Which installed versions are authoritative in the company environment?
- Does the current `idsec`/`conjur` version expose reliable auth/status and structured-output commands for those workflows?
- Is any interactive PTY required after the MVP auth experiment, or can login safely remain an external vendor-owned terminal flow?
- What local run-history retention is acceptable in the company environment (memory-only vs encrypted/local file metadata)?
