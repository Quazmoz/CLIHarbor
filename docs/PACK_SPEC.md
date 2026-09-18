# CLI Pack Specification

## 1. Purpose

A CLIHarbor **pack** describes how a trusted local command-line tool can become a guided browser experience. Packs are privileged declarative configuration: they may describe executable basenames, fixed version probes, fixed argument literals, typed user inputs, risk, output metadata, and authentication requirements, but they are not scripts or plugins.

The implemented format is `cliharbor.dev/v1`. Its structural contract is `schemas/pack.v1.schema.json`; `internal/packs` implements additional semantic/security checks and trusted loading rules. `internal/discovery` consumes already-validated tool metadata for executable discovery and version compatibility.

No real Idira/CyberArk command pack exists yet. `packs/example/pack.yaml` is intentionally synthetic and non-production. Real vendor commands remain blocked on Phase 0 inventory of the exact deployed CLI versions and command trees.

## 2. Design goals

- human-readable and reviewable YAML;
- strict, versioned structural validation;
- deterministic semantic validation;
- explicit allowlists of tools, tasks, flags, and mappings;
- safe, fixed version-probe representation;
- typed inputs and explicit risk classification;
- output/auth metadata sufficient for later UI/runtime work;
- portable platform declarations;
- resistant to arbitrary-command or scripting behavior;
- deterministic, bounded, fail-closed loading and discovery.

## 3. Non-goals

The v1 pack format is not:

- a programming language or shell script format;
- an unrestricted plugin mechanism;
- a place to store credentials;
- a remote package format;
- a source of executable paths supplied by the browser;
- a generic free-form positional-command facility;
- a way to execute arbitrary user-entered commands.

Phase 3 executes only the narrow fixed version probe of an explicitly configured trusted pack tool. Pack task commands are still not executable.

## 4. Implemented top-level structure

```yaml
apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: example
  name: Synthetic Example Pack
  version: 0.1.0
  description: Non-production example.

runtime:
  platforms: [windows, linux, darwin]
  tools:
    fixture:
      executableNames: [cliharbor-fixture]
      versionProbe:
        args: [--version]
        parser: semver-text
        timeoutMillis: 1500
      versionConstraint: ">=1.0.0 <2.0.0"

commands:
  inspect:
    name: Inspect fixture data
    tool: fixture
    risk: read
    inputs: []
    argv:
      - literal: inspect
    output:
      mode: raw
    requirements:
      requiresAuth: false
```

Unknown fields are rejected by the v1 JSON Schema. Unsupported schema versions fail closed before they can become runtime-authoritative.

## 5. Identifiers and metadata

Pack, tool, command, and input IDs use:

```text
^[a-z][a-z0-9-]{0,62}$
```

Pack versions are semantic-version-shaped strings. A pack contains a display name and optional description. Tool and command IDs are scoped to their pack; input IDs are scoped to their command. Duplicate YAML mapping keys are rejected before schema decoding, and duplicate input IDs are rejected semantically.

## 6. Platforms and tools

Implemented platforms are:

```text
windows
linux
darwin
```

Each tool declares one or more executable **basenames**, for example:

```yaml
tools:
  fixture:
    executableNames: [fixture-cli, fixture-cli.exe]
```

Executable paths are not accepted in a pack. v1 also rejects known shells/general-purpose interpreters and script/launcher forms such as CMD, PowerShell, POSIX shells, Windows script extensions, Python, Node, Ruby, Perl, `mshta`, `rundll32`, `regsvr32`, and WSL. This is defense in depth; explicit pack trust remains the primary control.

The browser never chooses an executable or executable path.

## 7. Version probes and compatibility

A tool may declare one fixed probe:

```yaml
versionProbe:
  args: [--version]
  parser: semver-text
  timeoutMillis: 1500
versionConstraint: ">=1.0.0 <2.0.0"
```

Rules:

- `versionProbe.args` is pack-authored fixed argv; no browser/user value is interpolated;
- `parser` is currently only `semver-text`;
- `timeoutMillis`, when provided, is bounded by schema to 100-10000 ms; runtime default is 3 seconds;
- probe stdout and stderr are captured separately into bounded buffers and raw output is not retained in discovery state;
- the probe executable is started directly, never through a shell;
- a `versionConstraint` requires a `versionProbe` and must parse as a valid `Masterminds/semver` constraint;
- the `semver-text` parser accepts exactly one distinct valid semantic version from combined probe text; no version or multiple distinct versions is a fail-closed probe error;
- incompatible versions produce an unavailable discovery state rather than being silently accepted.

Do not encode guessed vendor version arguments. Verify the exact deployed CLI behavior during Phase 0 before adding real vendor probes.

## 8. Discovery semantics

Phase 3 discovery operates only on already-validated pack tools.

PATH discovery:

- only absolute PATH directory entries are considered;
- empty, relative, and current-directory PATH entries are ignored so cwd contents do not silently gain execution authority;
- on Windows, an extensionless declared basename may resolve to the exact basename, `.exe`, or `.com`; batch/PowerShell/script extensions are not considered;
- discovered candidates are resolved to exact paths, de-duplicated, and sorted deterministically;
- zero matches -> `missing`;
- one match -> selected candidate;
- multiple matches -> `ambiguous`; CLIHarbor does not choose the first PATH hit.

Explicit overrides use:

```text
--tool-path pack/tool=/absolute/path
```

An override is backend/operator configuration, not browser input. It must reference an already-declared pack/tool and resolve to a regular executable whose basename matches that tool's allowlist. An invalid explicit override is authoritative and fails closed; CLIHarbor does not silently fall back to PATH.

Discovery states currently include:

```text
ready
missing
ambiguous
incompatible
probe-failed
invalid-override
unsupported-platform
```

Exact resolved path/version/candidate evidence is available through `cliharbor doctor`. Browser tool-status UI is deferred.

## 9. Commands and risk

Each task command requires:

- display name;
- declared tool reference;
- explicit risk classification;
- at least one constrained argv mapping;
- output metadata.

Risk values are:

```text
read
change
destructive
credential-sensitive
interactive
```

The risk value remains metadata until the planner/executor phase. Backend enforcement of destructive confirmation must not rely on frontend behavior.

## 10. Implemented input types

v1 supports:

- `string`
- `integer`
- `boolean`
- `enum`
- `multiselect`

Supported validation metadata includes numeric bounds, string length bounds, RE2-compatible patterns, enum values, and `disallowLeadingDash`.

Semantic validation rejects incompatible combinations, such as numeric bounds on strings or regex constraints on integers. Enum and multiselect inputs require predefined values.

`path` and `secret` input types remain deliberately deferred. Their trust, path-normalization, disclosure, and credential-handling semantics require separate reviewed designs.

## 11. Implemented argument primitives

v1 intentionally supports only four task-argument shapes.

### Literal

```yaml
- literal: inspect
```

Literals are trusted pack-authored argv elements.

### Flag with value

```yaml
- flag:
    name: --limit
    valueFrom: limit
    omitWhenEmpty: true
```

The flag name is schema-constrained. It must reference a declared string, integer, or enum input. Optional values must use `omitWhenEmpty: true`. String/enum inputs used as flag values must declare `disallowLeadingDash: true`; enum choices that themselves begin with `-` are rejected.

### Boolean switch

```yaml
- switch:
    name: --verbose
    enabledFrom: verbose
```

A switch must reference a declared boolean input. The browser controls only the boolean value; it does not supply the flag text.

### Enum-mapped literal

```yaml
- map:
    valueFrom: mode
    values:
      safe: --safe-mode
      detailed: --detailed-mode
```

A map must reference a required enum and define exactly one pack-authored literal for every allowed enum value. Extra/missing mapping keys fail validation.

### Deliberately absent in v1

Free-form positional `valueFrom`, shell strings, templated argument strings, browser-selected flag names, browser-selected subcommands, and browser-selected executables are not part of v1. A later positional-value primitive may be added only with planner/runtime semantics that prove one validated input becomes exactly one intended argv element without creating an undeclared flag/subcommand surface.

## 12. Output metadata

Implemented modes:

```text
raw
json
ndjson
delimited
```

Optional renderer metadata is limited to:

```text
raw
table
cards
```

Sensitivity metadata is:

```yaml
sensitivity:
  containsSecrets: true
  persistRawOutput: false
  revealByDefault: false
```

If `containsSecrets` is true, semantic validation rejects `persistRawOutput: true` and `revealByDefault: true`.

For `mode: json`, Phase 5 can optionally declare a bounded structured result contract:

```yaml
output:
  mode: json
  renderer: cards
  structured:
    fields:
      - key: name
        label: Name
        type: string
        required: true
      - key: count
        label: Count
        type: integer
```

The implemented structured contract is intentionally narrow:

- the JSON root must be one object;
- at most 32 pack-declared fields are allowed;
- field types are only `string`, `integer`, or `boolean`;
- unknown and duplicate JSON keys fail parsing;
- nested arrays/objects are not accepted as field values;
- required fields must be present;
- integer values must fit signed 64-bit range and are normalized to decimal text before reaching the browser;
- structured input is capped at 64 KiB and each string value at 8 KiB;
- invalid UTF-8 and unsafe control characters fail parsing;
- only the `cards` structured renderer is supported in this phase;
- `sensitive: true` structured fields are rejected;
- output with `containsSecrets: true` cannot enable structured rendering.

The parser runs after execution and cannot influence executable/argv construction or create another run. Raw stdout/stderr and the original exit state remain available even when structured parsing fails. `adapter` output mode and executable parser/plugin code remain deliberately unimplemented.

## 13. Authentication requirement metadata

A command may declare:

```yaml
requirements:
  requiresAuth: true
```

This is declarative metadata only. CLIHarbor does not capture credentials or implement vendor auth adapters yet. Vendor-owned authentication/session storage remains the architectural rule in `AUTHENTICATION.md`.

## 14. Structural validation

The embedded Draft 2020-12 schema enforces, among other things:

- exact API/kind values;
- required fields;
- ID syntax;
- supported risk/input/output enums;
- collection/field length bounds;
- strict unknown-field rejection;
- executable-basename syntax;
- bounded version-probe fields;
- constrained argument object shapes;
- valid platform values;
- typed object/array/scalar structure.

Before JSON Schema validation, the YAML boundary also rejects invalid UTF-8, files larger than 256 KiB, multiple documents, aliases/anchors/merge keys, custom tags, non-string/duplicate mapping keys, and excessive YAML depth/node count.

## 15. Semantic/security validation

Deterministic checks enforce:

- every command references a declared tool;
- input IDs are unique within a command;
- validation constraints match the input type;
- regex patterns compile under Go/RE2 semantics;
- argv mappings reference declared inputs of the expected type;
- optional flag/value pairs cannot leave malformed layouts;
- enum maps are complete and contain no undeclared keys;
- user-derived string/enum flag values cannot begin with `-`;
- executable declarations are basenames, not paths;
- known shells/interpreters/script launchers cannot be v1 tool executables;
- version constraints parse and require a version probe;
- version probe arguments cannot contain NUL;
- secret-bearing output cannot request raw persistence/default revelation or structured rendering;
- structured field keys are unique and sensitive structured fields are refused.

Validation errors avoid echoing supplied values. Explicit-local load errors display only the pack basename, not its directory path.

## 16. Trust and loading model

Validation is not trust. Packs are privileged configuration.

Supported source classes are:

1. `builtin`: bytes supplied directly by trusted application code;
2. `explicit-local`: paths/directories deliberately supplied by a trusted caller.

The loader does **not** scan the current working directory, automatically trust repository-local `packs/`, recurse through arbitrary directories, follow pack-file/directory symlinks, load HTTP/HTTPS URLs, auto-download packs, or execute plugin code.

Local file reads are size-bounded and verify opened file identity/size around the read. Directory entries are sorted, only direct `.yaml`/`.yml` regular files are considered, and duplicate input paths/pack IDs fail the whole load.

## 17. Registry/runtime representation

A successful load returns an effectively immutable `Registry`:

- packs are deterministically sorted by stable pack ID;
- duplicate pack IDs are rejected;
- pack/tool/command lookups use stable IDs;
- tool/command enumerations are sorted;
- accessors return deep copies, including version-probe argv, so callers cannot mutate authoritative validated state through returned slices/maps/pointers.

Discovery returns an independent immutable-style snapshot with defensive copies of candidate lists.

## 18. Validation/runtime stages

Implemented:

1. bounded UTF-8/YAML parsing;
2. v1 JSON Schema validation;
3. semantic cross-reference/type validation;
4. execution-shape/security validation;
5. trusted-source deterministic loading;
6. effectively immutable registry creation;
7. explicit tool discovery/path resolution;
8. bounded direct version probe and compatibility state.

Deferred:

9. typed request validation and deterministic task execution-plan construction;
10. task process execution/streaming/cancellation;
11. output parsing/rendering and auth orchestration.

## 19. Idira/CyberArk development rule

Do not invent or assume command trees from memory. Generate the initial inventory by running approved help/version commands against the exact deployed company versions, then encode only verified commands and version probes. The synthetic example pack must never be treated as vendor evidence.

## 20. Future extensions

Potential later additions include path/secret inputs, working-directory/environment policies, constrained positional values, richer output column metadata, auth adapters, composite workflows, signatures/publisher identity, persistent configured tool paths, and a reviewed pack distribution model.

Each extension must preserve the central invariant:

```text
trusted validated pack -> trusted discovered tool -> validated typed inputs -> deterministic plan -> exact executable + argv[]
```

A future feature must not turn packs, discovery, or the browser into a generic arbitrary-command web shell.
