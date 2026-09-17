# CLI Pack Specification

## 1. Purpose

A CLIHarbor **pack** describes how a trusted local command-line tool can become a guided browser experience. Packs are privileged declarative configuration: they may describe executable basenames, fixed argument literals, typed user inputs, risk, output metadata, and authentication requirements, but they are not scripts or plugins.

The implemented Phase 2 format is `cliharbor.dev/v1`. Its executable structural contract is `schemas/pack.v1.schema.json`; `internal/packs` implements the additional semantic/security checks and trusted loading rules.

No real Idira/CyberArk command pack exists yet. `packs/example/pack.yaml` is intentionally synthetic and non-production. Real vendor commands remain blocked on Phase 0 inventory of the exact deployed CLI versions and command trees.

## 2. Design goals

- human-readable and reviewable YAML;
- strict, versioned structural validation;
- deterministic semantic validation;
- explicit allowlists of tools, tasks, flags, and mappings;
- typed inputs and explicit risk classification;
- output/auth metadata sufficient for later UI/runtime work;
- portable platform declarations;
- resistant to arbitrary-command or scripting behavior;
- deterministic, bounded, fail-closed loading.

## 3. Non-goals

The v1 pack format is not:

- a programming language or shell script format;
- an unrestricted plugin mechanism;
- a place to store credentials;
- a remote package format;
- a source of executable paths supplied by the browser;
- a generic free-form positional-command facility;
- a way to execute arbitrary user-entered commands.

Phase 2 does not execute packs at all.

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
      versionConstraint: ">=1.0.0"

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

Implemented platforms are metadata values:

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

Executable paths are not accepted. v1 also rejects known shells/general-purpose interpreters such as `cmd`, PowerShell, POSIX shells, script hosts, Python, Node, Ruby, and Perl. This is defense in depth; pack trust remains the primary control.

`versionConstraint` is retained as bounded metadata for Phase 3 discovery/version compatibility. Phase 2 does not probe binaries or interpret vendor version output.

The browser must never choose an executable or executable path.

## 7. Commands and risk

Each executable command requires:

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

The risk value is metadata in Phase 2. Backend enforcement of destructive confirmation belongs to the later planner/executor milestone and must not rely on frontend behavior.

## 8. Implemented input types

v1 supports:

- `string`
- `integer`
- `boolean`
- `enum`
- `multiselect`

Supported validation metadata includes numeric bounds, string length bounds, RE2-compatible patterns, enum values, and `disallowLeadingDash`.

Semantic validation rejects incompatible combinations, such as numeric bounds on strings or regex constraints on integers. Enum and multiselect inputs require predefined values.

`path` and `secret` input types are deliberately deferred. Their trust, path-normalization, disclosure, and credential-handling semantics require separate reviewed designs rather than being added speculatively.

## 9. Implemented argument primitives

v1 intentionally supports only four argument shapes.

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

A map must reference a declared enum and define exactly one pack-authored literal for every allowed enum value. Extra/missing mapping keys fail validation.

### Deliberately absent in v1

Free-form positional `valueFrom`, shell strings, templated argument strings, browser-selected flag names, browser-selected subcommands, and browser-selected executables are not part of v1. A later positional-value primitive may be added only with planner/runtime semantics that prove one validated input becomes exactly one intended argv element without creating an undeclared flag/subcommand surface.

## 10. Output metadata

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

If `containsSecrets` is true, Phase 2 semantic validation rejects `persistRawOutput: true` and `revealByDefault: true`.

The future executor/renderer must still treat process output as untrusted data and implement redaction/escaping; pack metadata alone is not a security boundary.

`adapter` output mode and executable parser/plugin code are deliberately not implemented in v1.

## 11. Authentication requirement metadata

A command may declare:

```yaml
requirements:
  requiresAuth: true
```

This is declarative metadata only. Phase 2 does not capture credentials or implement vendor auth adapters. Vendor-owned authentication/session storage remains the architectural rule in `AUTHENTICATION.md`.

## 12. Structural validation

Phase 2 uses the embedded Draft 2020-12 schema to enforce, among other things:

- exact API/kind values;
- required fields;
- ID syntax;
- supported risk/input/output enums;
- collection/field length bounds;
- strict unknown-field rejection;
- executable-basename syntax;
- constrained argument object shapes;
- valid platform values;
- typed object/array/scalar structure.

Before JSON Schema validation, the YAML boundary also rejects:

- invalid UTF-8;
- files larger than 256 KiB;
- multiple YAML documents;
- aliases and anchors;
- merge keys;
- custom/unsupported YAML tags;
- non-string mapping keys;
- duplicate mapping keys;
- excessive YAML depth/node count.

## 13. Semantic/security validation

After structural validation, deterministic checks enforce:

- every command references a declared tool;
- input IDs are unique within a command;
- validation constraints match the input type;
- regex patterns compile under Go/RE2 semantics;
- argv mappings reference declared inputs of the expected type;
- optional flag/value pairs cannot leave malformed layouts;
- enum maps are complete and contain no undeclared enum keys;
- user-derived string/enum flag values cannot begin with `-`;
- executable declarations are basenames, not paths;
- known shells/interpreters cannot be v1 tool executables;
- secret-bearing output cannot request raw persistence/default revelation.

Validation errors expose codes and schema/object paths where useful but avoid echoing supplied values. Explicit-local load errors display only the pack basename, not its directory path.

## 14. Trust and loading model

Validation is not trust. Packs are privileged configuration.

Phase 2 supports two explicit source classes:

1. `builtin`: bytes supplied directly by trusted application code;
2. `explicit-local`: paths/directories deliberately supplied by a trusted caller.

The loader does **not**:

- scan the current working directory;
- automatically trust repository-local `packs/` content;
- recurse through arbitrary directories;
- follow pack-file/directory symlinks;
- load HTTP/HTTPS URLs;
- auto-download packs;
- execute plugin code.

Local file reads are size-bounded and verify the opened file identity/size around the read. Directory entries are sorted, only direct `.yaml`/`.yml` regular files are considered, and duplicate input paths/pack IDs fail the whole load.

## 15. Registry/runtime representation

A successful load returns an effectively immutable `Registry`:

- packs are deterministically sorted by stable pack ID;
- duplicate pack IDs are rejected;
- pack/tool/command lookups use stable IDs;
- tool/command enumerations are sorted;
- accessors return deep copies so callers cannot mutate authoritative validated state through returned slices/maps/pointers.

There is no global mutable pack registry.

## 16. Validation stages

Implemented now:

1. bounded UTF-8/YAML parsing;
2. v1 JSON Schema validation;
3. semantic cross-reference/type validation;
4. execution-shape/security validation;
5. trusted-source deterministic loading;
6. immutable/effectively immutable registry creation.

Deferred:

7. tool discovery/version compatibility (Phase 3);
8. typed request validation and deterministic execution-plan construction;
9. process execution;
10. output parsing/rendering and auth orchestration.

## 17. Idira/CyberArk development rule

Do not invent or assume command trees from memory. Generate the initial inventory by running approved help/version commands against the exact deployed company versions, then encode only verified commands. The synthetic example pack must never be treated as vendor evidence.

## 18. Future extensions

Potential later additions include path/secret inputs, working-directory/environment policies, constrained positional values, richer output column metadata, auth adapters, composite workflows, signatures/publisher identity, and a reviewed pack distribution model.

Each extension must preserve the central invariant:

```text
trusted validated pack -> validated typed inputs -> deterministic plan -> exact executable + argv[]
```

A future feature must not turn packs or the browser into a generic arbitrary-command web shell.
