# CLIHarbor

CLIHarbor is a thin, local browser interface for command-line tools.

The product starts with a concrete internal need: provide a substantially better operator experience for Palo Alto Networks Idira / CyberArk command-line workflows, especially `idsec` and `conjur`, without replacing those CLIs, duplicating their APIs, or becoming a new credential store.

The long-term product is broader: a reusable local UI engine that can expose many existing CLIs through declarative **packs**. Each pack describes commands, parameters, output rendering, safety rules, and authentication behavior. CLIHarbor remains the orchestration and presentation layer; the underlying CLI remains the source of truth.

## Product principles

- **Thin by design.** CLIHarbor invokes installed CLIs rather than reimplementing them.
- **Local-first.** The default server binds only to loopback and the UI runs in the user's browser.
- **No credential vault.** Authentication should remain owned by the wrapped CLI and operating-system facilities whenever possible.
- **No shell-string execution.** Commands are represented as executable + argument arrays and started directly.
- **Useful before generic.** The first pack is Idira/CyberArk. The generic pack system evolves from real workflows rather than speculative abstraction.
- **Easy to adopt.** A developer should be able to clone the repository, run one development command, and open the UI. A packaged release should be a single local executable where practical.
- **Safe for enterprise use.** Local binding, command allowlists, input validation, output redaction, auditability, and explicit handling of destructive operations are first-class requirements.

## Initial scope

Windows is the first supported platform. Users may normally launch the wrapped tools from PowerShell or CMD, but CLIHarbor should execute the actual program directly (for example `idsec.exe`) rather than launching PowerShell/CMD for ordinary commands.

The first product slice will:

1. Discover supported CLI binaries on `PATH` and/or configured locations.
2. Detect version/capabilities.
3. Present a browser UI for curated Idira/CyberArk workflows.
4. Execute allowlisted commands through a local backend.
5. Stream stdout/stderr and surface exit state.
6. Render structured results as tables/cards when reliable structured output exists; otherwise preserve terminal-style output.
7. Delegate login/session persistence to the official CLI rather than storing passwords or tokens itself.
8. Provide an escape hatch to view the exact executable and argument vector before execution.

## Planned stack

The default implementation direction is:

- **Backend / launcher:** Go
- **Frontend:** React + TypeScript + Vite
- **Distribution:** frontend embedded into the Go binary for release builds
- **Transport:** loopback HTTP plus WebSocket or Server-Sent Events for streaming execution events
- **Pack format:** versioned YAML with JSON Schema validation
- **Execution:** Go `os/exec` using executable + argument arrays; never concatenate untrusted input into a shell command

Go is chosen for the initial standalone implementation because it produces a small self-contained Windows executable, has strong process/HTTP primitives, is easy to embed into an existing CLI, and keeps the local runtime footprint low. If CLIHarbor is later embedded into an existing internal CLI implemented in another language, the protocol and pack model should remain portable.

## Development entry points

Read these before implementation:

- [`docs/PRD.md`](docs/PRD.md) — product requirements and acceptance criteria
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and runtime boundaries
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model and security invariants
- [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) — credential/session ownership model
- [`docs/PACK_SPEC.md`](docs/PACK_SPEC.md) — declarative CLI-pack design
- [`docs/UX.md`](docs/UX.md) — browser UI and interaction model
- [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) — staged implementation plan
- [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md) — automated/manual verification
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — sequence from Idira-specific MVP to generic platform
- [`docs/RESEARCH.md`](docs/RESEARCH.md) — current ecosystem and upstream CLI notes
- [`AGENTS.md`](AGENTS.md) — repository rules for coding agents

## Upstream Idira/CyberArk notes

As of September 2026, CyberArk's `idsec-cli-golang` repository describes `idsec` as the official CLI for Idira Identity Security Platform operations. Its login flow can prompt for password/MFA and stores access tokens in the computer keystore for their lifetime. CyberArk's current `conjur-cli-go` repository is the Go CLI for Idira Secrets Manager; the older Python `cyberark-conjur-cli` repository is deprecated and archived.

Those properties reinforce CLIHarbor's core boundary: **invoke the official CLI and let it own authentication/session material rather than copying credentials into CLIHarbor.**

## Status

Specification/foundation stage. No implementation is claimed yet.
