# Contributing

CLIHarbor is currently an early-stage project. Changes should preserve the product's thin/local/security-first boundary.

## Before coding

Read `AGENTS.md` and `docs/AGENT_INDEX.md`.

For Idira/CyberArk work, verify command syntax against the exact upstream/deployed CLI version. Do not invent commands from memory.

## Development principles

- Keep the runtime small.
- Prefer official CLI delegation over API reimplementation.
- Represent execution as executable + argument array.
- Keep vendor-specific logic out of the generic executor/planner.
- Treat packs as privileged configuration.
- Never commit credentials, tenant-specific data, secrets, or internal endpoints.
- Add tests around security-sensitive boundaries.

## Proposed local workflow

The concrete commands will be added with the implementation, but the intended interface is:

```text
# start backend + frontend development environment
<task> dev

# run all tests
<task> test

# validate packs/schemas
<task> validate

# build a release binary
<task> build

# diagnose local wrapped-tool environment
cliharbor doctor
```

Windows support is mandatory for developer tooling. Do not make a GNU-only build tool the sole entry point.

## Pull request expectations

A substantive PR should explain:

- problem/outcome;
- affected product requirement or ADR;
- security impact;
- tests run;
- Windows verification when process/browser/path behavior changed;
- pack/schema compatibility implications;
- documentation updates.

## Pack contributions

A pack change should include:

- source/version of the wrapped CLI used for verification;
- help/docs evidence for the command/flags;
- risk classification;
- input validation;
- output sensitivity classification;
- parser fixtures where structured output is used;
- tests proving generated argv.

## Security-sensitive changes

Changes touching any of these require extra review:

- process execution;
- auth/session flows;
- browser bootstrap/session security;
- pack loading/trust;
- remote networking;
- secret handling/redaction;
- file access;
- destructive command confirmation;
- PTY/terminal support;
- update/distribution mechanisms.

## Documentation discipline

When behavior changes, update the canonical document identified in `docs/AGENT_INDEX.md`. If an accepted architecture decision changes, add a superseding entry to `docs/DECISIONS.md` rather than silently rewriting history.
