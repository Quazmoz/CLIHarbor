# AGENTS.md

This repository is the source of truth for CLIHarbor product and implementation work.

## Mission

Build a thin, secure, local browser UI over existing command-line tools. The first production use case is Idira/CyberArk (`idsec` and `conjur`), but the architecture must support additional CLIs through versioned declarative packs.

## Non-negotiable invariants

1. **Do not reimplement wrapped services unless explicitly required.** Prefer invoking the installed official CLI.
2. **Do not become a credential store.** Passwords, MFA challenges, tokens, certificates, and other secrets must remain owned by the wrapped CLI / OS keystore whenever possible.
3. **Do not execute arbitrary shell strings.** Ordinary execution must use an executable path plus an argument vector. Do not invoke `powershell.exe`, `cmd.exe /c`, `sh -c`, or equivalent merely to run a normal CLI command.
4. **Bind locally by default.** The web server must bind to loopback only unless a future explicitly reviewed remote-access feature is added.
5. **Packs are allowlists, not arbitrary scripting.** A pack may declare approved executables, subcommands, flags, validation rules, output adapters, and workflow composition. It must not silently become a general remote shell.
6. **Preserve exact execution evidence.** Every run should have a stable run ID, executable identity/version, sanitized argument representation, timestamps, exit code, and stdout/stderr boundaries. Never log secret values.
7. **Destructive operations require explicit UX.** Commands marked destructive/high-risk require confirmation and must clearly display the target/context.
8. **Fail closed on ambiguity.** If a binary, version, pack, parameter, or output parser is not understood, degrade to safe raw output or refuse execution rather than guessing.
9. **Windows first, portable core.** The first supported OS is Windows. Avoid gratuitous platform-specific coupling in the pack/runtime model.
10. **Do not claim implementation that does not exist.** Keep docs honest about current state.

## Canonical document order

Before implementation, read:

1. `docs/PRD.md`
2. `docs/ARCHITECTURE.md`
3. `docs/SECURITY.md`
4. `docs/AUTHENTICATION.md`
5. `docs/PACK_SPEC.md`
6. `docs/UX.md`
7. `docs/DEVELOPMENT_PLAN.md`
8. `docs/TEST_STRATEGY.md`
9. `docs/ROADMAP.md`
10. `docs/RESEARCH.md`

If these documents conflict, security invariants win over convenience; the PRD wins over lower-level implementation notes unless an ADR deliberately supersedes it.

## Preferred implementation shape

- Backend/launcher: Go.
- Frontend: React + TypeScript + Vite.
- Release asset: single Go executable with embedded frontend where practical.
- Browser transport: loopback HTTP; SSE/WebSocket only where streaming requires it.
- Process execution: Go `os/exec` with explicit executable + args.
- Pack format: versioned YAML validated against a schema.
- Initial adapter/pack: Idira/CyberArk.

Do not introduce Electron/Tauri, a cloud backend, a database server, container runtime, or browser extension unless a concrete requirement justifies it.

## Repository hygiene

- Keep the runtime small and dependency-light.
- Use small packages with explicit boundaries: server, executor, pack loader/validator, discovery, redaction, runs/events, and frontend API.
- Keep Idira/CyberArk-specific behavior in a pack and minimal adapter code rather than leaking it throughout the engine.
- Add tests with every security-sensitive or parsing change.
- Treat stdout/stderr as untrusted data; escape it before rendering.
- Avoid telemetry by default. Any future telemetry must be opt-in and documented.
- Never commit credentials, tenant URLs, internal hostnames, tokens, user identifiers, or example secrets.

## Definition of done for a change

A change is not complete until:

- affected tests pass;
- security invariants remain true;
- pack/schema changes are versioned and documented;
- user-visible behavior has acceptance coverage;
- docs are updated when architecture/product behavior changes;
- the change is tested on Windows if it touches process execution, PATH discovery, browser launch, terminal behavior, or filesystem paths.

## Initial development priority

Do not begin by implementing generic automatic CLI scraping. Build the smallest production-quality vertical slice for the Idira/CyberArk use case first, with the generic engine underneath it. Real usage should drive abstraction.
