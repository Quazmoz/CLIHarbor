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
7. `docs/DECISIONS.md`
8. `docs/DEVELOPMENT_PLAN.md`
9. `docs/TEST_STRATEGY.md`
10. `docs/ROADMAP.md`
11. `docs/RESEARCH.md`

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
- Keep Idira/CyberArk-specific behavior in a pack plus its dedicated platform package (`internal/platforms/conjur`, ADR-034) rather than leaking it into the generic core or `internal/app`.
- Add tests with every security-sensitive or parsing change.
- Treat stdout/stderr as untrusted data; escape it before rendering.
- Avoid telemetry by default. Any future telemetry must be opt-in and documented.
- Never commit credentials, tenant URLs, internal hostnames, tokens, user identifiers, or example secrets.

## GitHub Actions execution policy (explicit user authorization required)

**Do not run GitHub Actions automatically during routine CLIHarbor development.** Repository workflows must be manual-only (`workflow_dispatch`); do not add `push`, `pull_request`, merge, tag, scheduled, or other automatic triggers, including temporary qualification workflows. Do not manually dispatch a workflow via GitHub UI, API, CLI, or automation unless the user **specifically authorizes GitHub Actions for that operation** (for example, production release qualification or a named exceptional CI check). Ordinary implementation, commits, PRs, merges, local validation failures, and a generic request to "test" or "continue" are **not** authorization to spend GitHub Actions minutes.

During normal development, run the relevant repository-native checks locally and report which checks actually ran and which platform/runtime checks remain unverified. Preserve all release quality/security gates: when a production release is specifically requested and GitHub Actions are authorized, manually dispatch the necessary qualification workflow against the intended commit. Never claim release qualification from unexecuted checks. Do not create a new automatic CI workflow as a shortcut to run tests.

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

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->

<!-- ponytail:start -->
# Ponytail, lazy senior dev mode

You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.

Before writing any code, stop at the first rung that holds:

1. Does this need to be built at all? (YAGNI)
2. Does it already exist in this codebase? Reuse the helper, util, or pattern that's already here, don't re-write it.
3. Does the standard library already do this? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency solve it? Use it.
6. Can this be one line? Make it one line.
7. Only then: write the minimum code that works.

The ladder runs after you understand the problem, not instead of it: read the task and the code it touches, trace the real flow end to end, then climb.

Bug fix = root cause, not symptom: a report names a symptom. Grep every caller of the function you touch and fix the shared function once — one guard there is a smaller diff than one per caller, and patching only the path the ticket names leaves a sibling caller still broken.

Rules:

- No abstractions that weren't explicitly requested.
- No new dependency if it can be avoided.
- No boilerplate nobody asked for.
- Deletion over addition. Boring over clever. Fewest files possible.
- Shortest working diff wins, but only once you understand the problem. The smallest change in the wrong place isn't lazy, it's a second bug.
- Question complex requests: "Do you actually need X, or does Y cover it?"
- Pick the edge-case-correct option when two stdlib approaches are the same size, lazy means less code, not the flimsier algorithm.
- Mark deliberate simplifications that cut a real corner with a known ceiling (global lock, O(n²) scan, naive heuristic) with a `ponytail:` comment naming the ceiling and upgrade path.

Not lazy about: understanding the problem (read it fully and trace the real flow before picking a rung, a small diff you don't understand is just laziness dressed up as efficiency), input validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs (the platform is never the spec ideal, a clock drifts, a sensor reads off), anything explicitly requested. Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind, the smallest thing that fails if the logic breaks (an assert-based demo/self-check or one small test file; no frameworks, no fixtures). Trivial one-liners need no test.

> **Ponytail + Graft precedence.** Ponytail governs how much code to write,
> never whether to keep a safeguard. Repository-specific instructions win over
> Ponytail defaults. No Ponytail rule authorizes weakening security,
> trust-boundary validation, error handling that prevents data loss,
> accessibility, or anything explicitly requested. Before writing new code,
> answer ladder rung 2 by querying this repository's locked Graft launcher.
<!-- ponytail:end -->

<!-- ponytail-graft-local:start -->
## Repository-local agent tools

This repository pins Ponytail and Graft under
`.agent-tools/ponytail-graft/`. Run every Graft command as
`node .agent-tools/ponytail-graft/bin/graft.cjs ...`; any bare `graft ...`
example in generated Graft guidance is shorthand for that repository-local
launcher. Never substitute a global `graft` or an unpinned `npx` invocation.
Ponytail governs implementation economy; Graft supplies repository evidence,
especially for Ponytail ladder rung 2 (reuse what already exists).
<!-- ponytail-graft-local:end -->
