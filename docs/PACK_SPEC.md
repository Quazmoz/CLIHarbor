# CLI Pack Specification

## 1. Purpose

A CLIHarbor **pack** describes how a trusted local command-line tool becomes a guided browser experience.

The pack is intentionally declarative. It should describe capabilities and constraints, not provide arbitrary scripting.

The first pack targets Idira/CyberArk. Later packs may target unrelated tools without modifying CLIHarbor's core execution model.

## 2. Design goals

- human-readable and reviewable;
- strongly schema-validated;
- versioned;
- explicit allowlist of tools, commands, flags, and inputs;
- capable of describing forms, risk levels, outputs, and workflows;
- portable across Windows-first and future platforms;
- safe to render in a browser;
- resistant to becoming a general shell language.

## 3. Non-goals

The pack format is not:

- a programming language;
- a shell script format;
- an unrestricted plugin mechanism;
- a place to store credentials;
- a substitute for vendor API schemas;
- a way to execute arbitrary user-entered commands.

## 4. Proposed top-level structure

Illustrative only; implementation should formalize this in `schemas/pack.v1.schema.json` before consuming packs.

```yaml
apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: idira
  name: Idira / CyberArk
  version: 0.1.0
  description: Guided workflows over official Idira/CyberArk CLIs.

runtime:
  platforms: [windows]

  tools:
    idsec:
      executableNames: [idsec.exe, idsec]
      versionProbe:
        args: [version]
        parser: text
      versionConstraint: ">=0.0.0"

    conjur:
      executableNames: [conjur.exe, conjur]
      versionProbe:
        args: [version]
        parser: text

navigation:
  - id: identity
    label: Identity
    tasks: [identity-status]

commands:
  identity-status:
    name: Identity status
    description: Read-only status check.
    tool: idsec
    risk: read
    argv:
      - literal: status
    inputs: []
    output:
      mode: raw
```

The exact Idira command names above are placeholders until validated against the deployed CLI version.

## 5. Tool definition

A tool definition may include:

```yaml
tools:
  example:
    executableNames: [example.exe, example]
    search:
      path: true
      configuredPaths: true
    versionProbe:
      args: [--version]
      parser: semver-text
    versionConstraint: ">=1.2.0 <2.0.0"
    publisherHint: Optional publisher metadata
```

### Discovery rules

- PATH search may be enabled.
- User/admin path override may be allowed.
- Packs cannot accept an executable path from a task input.
- Multiple matches should be reported and resolved by policy/user configuration, not guessed silently.

## 6. Command/task definition

A task is the unit shown to users.

```yaml
commands:
  list-things:
    name: List things
    description: Lists accessible things.
    tool: example
    risk: read
    argv:
      - literal: thing
      - literal: list
      - flag:
          name: --profile
          valueFrom: profile
          omitWhenEmpty: true
      - flag:
          name: --limit
          valueFrom: limit
    inputs:
      - id: profile
        type: string
        label: Profile
        required: false
        validation:
          maxLength: 100
      - id: limit
        type: integer
        label: Limit
        default: 100
        validation:
          min: 1
          max: 1000
    output:
      mode: json
      renderer: table
```

## 7. Input types

Initial types:

- `string`
- `integer`
- `boolean`
- `enum`
- `path` with explicit file/directory semantics
- `multiselect`
- `secret` only for future reviewed flows; prohibited in MVP packs by default

Validation options may include:

- required;
- min/max;
- minLength/maxLength;
- enum choices;
- regex with bounded/reviewed complexity;
- allowed file extension;
- path existence/type;
- dependencies/mutual exclusions.

Validation must run server-side even when duplicated in the browser.

## 8. Argument construction primitives

The schema should keep these intentionally limited:

### Literal

```yaml
- literal: list
```

### Positional value

```yaml
- valueFrom: resourceId
```

### Flag with value

```yaml
- flag:
    name: --profile
    valueFrom: profile
    omitWhenEmpty: true
```

### Boolean flag

```yaml
- switch:
    name: --verbose
    enabledFrom: verbose
```

### Enum-mapped literal

```yaml
- map:
    valueFrom: mode
    values:
      safe: --safe
      fast: --fast
```

Do not include generic interpolation like `"--flag={{userInput}}"` if it can be represented structurally.

## 9. Environment variables

Environment mutation is privileged and must be explicit.

Example:

```yaml
environment:
  inherit: true
  set:
    SOME_NON_SECRET_MODE:
      literal: safe
```

For MVP:

- browser input should not be able to set arbitrary environment variable names;
- secret environment variables are not defined by pack files;
- packs may allowlist known non-secret context variables if needed.

## 10. Working directory

Default to CLIHarbor's neutral runtime directory unless the wrapped CLI requires another location.

If a task needs a working directory, the pack must define whether it is:

- fixed;
- repository root;
- user-selected directory with path validation.

A task must not use a user-controlled path as an executable.

## 11. Risk model

Required command risk field:

```text
read
change
destructive
credential-sensitive
interactive
```

Additional metadata:

```yaml
confirmation:
  required: true
  style: typed-target
  targetFrom: resourceId
```

`destructive` commands always require confirmation independent of frontend behavior; the backend enforces it.

## 12. Output definition

Modes:

```text
raw
json
ndjson
delimited
adapter
```

Example:

```yaml
output:
  mode: json
  renderer: table
  columns:
    - path: .name
      label: Name
    - path: .type
      label: Type
```

Output definitions must specify secret classification where a task can return sensitive values.

```yaml
sensitivity:
  containsSecrets: true
  persistRawOutput: false
  revealByDefault: false
```

Structured rendering is optional. Raw output remains the ground truth when parsing fails.

## 13. Auth definition

Auth should mostly point to adapter capabilities rather than encode credentials.

Conceptual example:

```yaml
auth:
  adapter: idsec
  statusTask: auth-status
  login:
    mode: external-interactive
    tool: idsec
    args: [login]
  logout:
    tool: idsec
    args: [logout]
```

All exact commands must be validated against the target tool version.

## 14. Composite workflows

Later versions may allow a constrained sequence of existing tasks, e.g.:

```yaml
workflows:
  inspect-resource:
    steps:
      - task: get-resource
      - task: list-permissions
```

Rules:

- each step must reference a declared task;
- no arbitrary script step;
- outputs passed between steps use typed named fields;
- every step retains its own risk/authorization policy;
- a workflow cannot downgrade a destructive task to read-only.

Composite workflows are post-MVP unless required by the first real Idira flow.

## 15. Pack compatibility

Each pack declares:

- CLIHarbor schema/API version;
- pack semantic version;
- platform support;
- tool version constraints.

CLIHarbor must reject unsupported schema major versions.

## 16. Pack validation stages

1. YAML parse.
2. JSON Schema validation.
3. semantic validation (unique IDs, references resolve, legal risk values).
4. security validation (no forbidden executable/script patterns).
5. tool discovery/version compatibility.
6. command-plan validation before each run.

## 17. Idira pack development rule

Do not invent or assume command trees from memory. Generate the initial inventory by running approved help/version commands against the exact company versions, then encode only verified commands.

The pack should initially cover a small number of high-value workflows and expand piecemeal.

## 18. Future pack marketplace/community model

A public pack ecosystem is a potential later direction, but it requires:

- signatures;
- publisher identity;
- capability declarations;
- static security linting;
- review/update policy;
- clear trust UI.

None of those are MVP dependencies.
