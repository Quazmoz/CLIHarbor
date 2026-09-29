# CLI Pack Specification

## 1. Purpose

A CLIHarbor **pack** is trusted declarative configuration that turns an approved local command-line tool into a bounded browser workflow. A pack can declare executable basenames, compatibility probes, operator-only evidence probes, typed inputs, deterministic argv construction, risk, output handling, and authentication requirements.

A pack is **not** a script, plugin, shell program, executable-path source, credential store, or arbitrary command template.

The implemented format is:

```text
cliharbor.dev/v1
```

Its structural contract is `schemas/pack.v1.schema.json`; `internal/packs` applies additional semantic and security validation.

## 2. Core invariant

Every executable browser task must preserve this chain:

```text
explicitly trusted pack
  -> validated pack model
  -> trusted discovered executable
  -> validated typed inputs
  -> deterministic execution plan
  -> exact executable + argv[]
```

The browser never supplies an executable, executable path, subcommand name, flag name, shell string, or raw argv.

## 3. Top-level structure

```yaml
apiVersion: cliharbor.dev/v1
kind: CliPack
metadata:
  id: example
  name: Example Pack
  version: 1.0.0
  description: Example trusted CLI integration.

runtime:
  platforms: [windows]
  tools:
    example:
      executableNames: [example]
      versionProbe:
        args: [--version]
        parser: semver-text
        timeoutMillis: 3000
      versionConstraint: ">=1.0.0 <2.0.0"

commands:
  inspect:
    name: Inspect
    tool: example
    risk: read
    inputs: []
    argv:
      - literal: inspect
    output:
      mode: raw
    requirements:
      requiresAuth: false
```

Unknown fields and unsupported API versions fail closed.

## 4. Identifiers

Pack, tool, command, input, structured-field, and evidence-probe IDs use:

```text
^[a-z][a-z0-9-]{0,62}$
```

Pack versions are semantic-version-shaped strings. Tool and command IDs are scoped to the pack; input IDs are scoped to a command.

## 5. Platforms and executable declarations

Implemented platforms:

```text
windows
linux
darwin
```

A tool declares one or more executable **basenames**:

```yaml
tools:
  conjur:
    executableNames: [conjur]
```

Paths are not valid pack configuration. CLIHarbor rejects common shells, script extensions, general-purpose interpreters, and launcher binaries as tool executables.

On Windows, an extensionless approved basename may resolve to the exact basename, `.exe`, or `.com`; batch/script extensions are not considered.

## 6. Discovery

Discovery runs only for explicitly trusted packs.

PATH discovery:

- considers absolute PATH directory entries only;
- ignores empty/relative/current-directory entries;
- resolves candidates to absolute paths;
- de-duplicates candidates deterministically;
- fails closed when multiple candidates match;
- captures executable identity for later revalidation.

A trusted backend operator may provide:

```text
--tool-path pack-id/tool-id=/absolute/path
```

An invalid explicit override fails closed and does not fall back to PATH. The browser cannot set or alter tool paths.

Discovery states include `ready`, `missing`, `ambiguous`, `incompatible`, `probe-failed`, `invalid-override`, `identity-failed`, and `unsupported-platform`.

## 7. Version probes

A tool may declare one fixed semantic-version probe:

```yaml
versionProbe:
  args: [--version]
  parser: semver-text
  timeoutMillis: 3000
versionConstraint: ">=9.3.1 <10.0.0"
```

Rules:

- argv is fixed pack-authored data;
- no user/browser value is interpolated;
- the executable is launched directly, never through a shell;
- timeout and captured output are bounded;
- raw probe output is not retained in normal discovery state;
- `semver-text` must resolve exactly one distinct semantic version;
- a version constraint requires a version probe;
- an incompatible version cannot become executable authority.

Do not guess vendor version commands. Establish them from authoritative documentation/source or reviewed Phase 0 evidence.

## 8. Operator evidence probes

A tool may declare bounded fixed help/evidence probes:

```yaml
helpProbes:
  root:
    args: [--help]
    timeoutMillis: 3000
  resource:
    args: [resource, --help]
    timeoutMillis: 3000
```

These are not browser tasks. An operator invokes one explicitly through the Phase 0 inventory/evidence path. The selector identifies a trusted pack/tool/probe; it never carries executable path or arbitrary argv.

Evidence probe execution is shell-free, non-interactive, time/output bounded, lifecycle-contained, and revalidates the discovered executable identity immediately before execution.

## 9. Risk classes

Declared risk values are:

```text
read
change
destructive
credential-sensitive
interactive
```

The current browser planner/executor admits only `read` commands. Other risk classes remain metadata until an explicit backend confirmation/approval contract is implemented. A frontend confirmation dialog alone is not sufficient authorization for change/destructive execution.

## 10. Input types

Implemented input types:

- `string`
- `integer`
- `boolean`
- `enum`
- `multiselect`

Validation metadata includes numeric bounds, string-length bounds, RE2-compatible patterns, enum values, and `disallowLeadingDash`.

Runtime input is untrusted. The planner validates exact JSON type and semantic bounds before any argv construction.

`secret` and general filesystem `path` inputs remain deliberately absent.

## 11. Argument primitives

CLIHarbor v1 supports five deterministic argument shapes.

### 11.1 Literal

```yaml
- literal: resource
```

The entire argv element is trusted pack-authored text.

### 11.2 Flag with value

```yaml
- flag:
    name: --limit
    valueFrom: limit
    omitWhenEmpty: true
```

The flag name is trusted pack text. `valueFrom` must reference a declared string, integer, or enum input. Optional values must use `omitWhenEmpty: true`.

String/enum values used after flags must declare `disallowLeadingDash: true`; enum values beginning with `-` are rejected. This prevents a user value from becoming an undeclared flag.

### 11.3 Boolean switch

```yaml
- switch:
    name: --verbose
    enabledFrom: verbose
```

The input must be boolean. The browser controls only the boolean; it never supplies switch text.

### 11.4 Enum-mapped literal

```yaml
- map:
    valueFrom: mode
    values:
      safe: --safe
      detailed: --detailed
```

The input must be a required enum. The mapping must define exactly one trusted literal for every enum choice.

### 11.5 Constrained positional value

```yaml
- positional:
    valueFrom: resource-id
```

This primitive exists because verified CLIs such as Conjur use command forms like:

```text
conjur resource show <resource-id>
```

Security contract:

- one validated scalar input becomes **exactly one argv element**;
- no whitespace splitting occurs;
- no templating/substitution occurs;
- no shell parsing occurs;
- only string, integer, or enum inputs are accepted;
- optional positional values require `omitWhenEmpty: true`;
- string/enum positional values must declare `disallowLeadingDash: true`;
- enum positional values beginning with `-` are invalid.

A positional value cannot introduce a new subcommand or flag boundary because its location is fixed by the trusted pack and leading-dash values are refused.

## 12. Deliberately absent execution shapes

v1 does not support:

- arbitrary shell command strings;
- browser-selected executable/path;
- browser-selected flag/subcommand names;
- arbitrary argv arrays;
- string templates that produce multiple arguments;
- shell/interpreter expansion;
- user-controlled environment-variable names;
- arbitrary working directories;
- plugin/parser executables.

## 13. Authentication requirements

A command may declare:

```yaml
requirements:
  requiresAuth: true
```

Generic auth-required commands are still blocked from browser execution unless an approved auth mode exists.

### Vendor-owned existing session

The implemented narrow auth mode is:

```yaml
requirements:
  requiresAuth: true
  authMode: vendor-session
```

`vendor-session` means the command may run using authentication/configuration already owned by the vendor CLI or OS-backed keystore.

CLIHarbor:

- does not accept username/password/token/MFA inputs;
- does not inject credential argv;
- does not provide interactive stdin to the child process;
- does not read vendor session tokens merely to execute the command;
- preserves normal read-only risk and output restrictions.

If the vendor CLI cannot use an existing session, it must fail and the operator authenticates using the approved vendor-owned flow.

A pack that merely declares `requiresAuth: true` without a supported auth mode remains fail-closed and is not surfaced as an executable browser task.

## 14. Output metadata

Output modes:

```text
raw
json
ndjson
delimited
```

Renderer metadata:

```text
raw
table
cards
```

Sensitivity metadata:

```yaml
sensitivity:
  containsSecrets: true
  persistRawOutput: false
  revealByDefault: false
```

Secret-bearing output cannot request raw persistence, default reveal, or structured rendering. The current executor refuses secret-bearing browser plans entirely.

### Structured JSON cards

For bounded simple JSON objects, a command may declare scalar fields:

```yaml
output:
  mode: json
  renderer: cards
  structured:
    fields:
      - key: exists
        label: Exists
        type: boolean
        required: true
```

Current structured fields are only `string`, `integer`, or `boolean`; nested values and sensitive structured fields are rejected. Raw stdout/stderr and the authoritative process exit state remain available even when structured parsing fails.

## 15. YAML/schema hardening

Before schema decoding, pack loading enforces:

- maximum 256 KiB input;
- valid UTF-8;
- one YAML document only;
- no aliases/anchors/merge keys/custom tags;
- string-only unique mapping keys;
- bounded YAML depth/node count.

The embedded JSON Schema then applies strict object shapes, field bounds, enums, ID patterns, and unknown-field rejection. Semantic validation adds cross-reference, type, version-probe, argument-injection, and output-sensitivity checks.

## 16. Trust and loading

Validation does not create trust.

Supported source classes:

1. `builtin` — bytes supplied deliberately by trusted application code;
2. `explicit-local` — files/directories explicitly named by a trusted operator.

The loader does not implicitly trust cwd/repository files, recurse arbitrary directories, follow pack symlinks, load remote URLs, auto-download packs, or execute pack code. Explicit directory loading is streamed in bounded batches and fails closed above 4,096 scanned entries or 256 YAML pack files. Authoring commands additionally reject more than 256 explicit source paths or more than 256 aggregate packs across those sources, preventing chained bounded inputs from becoming an unbounded resource path. For `serve` and `doctor`, explicit local sources are additive to the embedded first-party set unless the operator supplies `--no-default-packs`; duplicate pack IDs across any source fail the whole registry.

## 17. Registry immutability

A successful registry is deterministic and defensive:

- packs/tools/commands enumerate in stable order;
- duplicate pack IDs fail the whole load;
- returned slices/maps/pointers are cloned;
- argument mappings, including positional metadata, cannot mutate authoritative registry state through caller aliases.

## 18. Pack authoring commands

CLIHarbor includes a narrow onboarding surface for additional CLIs:

```text
cliharbor pack init --id <pack-id> --name <name> --tool <tool-id> --executable <basename> <output.yaml>
cliharbor pack validate <pack.yaml-or-directory> [...]
cliharbor pack lint [--cases <cases.json>] <pack.yaml-or-directory> [...]
cliharbor pack generate-tests --output <cases.json> <pack.yaml-or-directory>
cliharbor pack test --cases <cases.json> <pack.yaml-or-directory>
```

`pack init` creates a valid discovery-only scaffold. It intentionally emits:

- one declared executable basename;
- explicit platform metadata;
- metadata version `0.1.0`;
- `commands: {}`;
- no version constraint;
- no version probe;
- no help/evidence probe;
- no authentication behavior.

This is intentional: CLIHarbor does not infer command trees or security-sensitive argv from an executable name.

`pack validate` runs only the hardened pack loader and cross-pack registry construction. It does **not** discover tools or execute version probes, help probes, or tasks. Multiple supplied files/directories are validated together so duplicate IDs and other registry conflicts fail closed before runtime.

`pack lint` starts from the same hardened validated registry, then applies deterministic static authoring-quality and security rules. It never executes a vendor CLI, performs executable discovery, runs version/help probes, downloads dependencies, reads authentication/session state, or uses an LLM. Diagnostics are sorted and carry a severity, stable code, quoted source basename, semantic object path, and fixed explanation. Lint errors make the command non-zero; warnings do not.

Current repository-grounded rules detect terminal/control characters in trusted presentation/argv/probe text, browser-visible commands without descriptions, duplicate command display names, declared inputs never consumed by argv, one input reused across multiple argv construction steps, duplicate trusted flag/switch names, string values placed into argv without an explicit `maxLength`, auth modes declared while authentication is disabled, renderer metadata that the current runtime ignores without structured output, and command metadata that the current planner will deliberately block because of risk/auth/secret-output policy. Lint does **not** reject ordinary shell metacharacters solely because they occur in a trusted literal: the runtime launches the selected executable directly with an argv vector, so those characters do not gain shell semantics.

If `--cases` is supplied explicitly, lint reuses the hardened `cliharbor.packtest/v1` reader and adds static fixture diagnostics without running the planner. It checks unintended references to unknown packs/commands/inputs and reports coverage gaps for planner-runnable commands, consumed inputs, positive boolean-switch behavior, bounded integer rejection below/above declared limits, constrained-positional leading-dash rejection, enum rejection, and each enum-to-literal map branch. Explicit contract cases whose declared purpose is to assert `unknown_pack`, `unknown_command`, or `unknown_input` planner rejection remain valid. CLIHarbor does not auto-discover nearby fixture files.

`pack generate-tests` creates a deterministic, no-clobber starter `cliharbor.packtest/v1` fixture from the validated pack model. It uses only synthetic local executable identity and the production planner; it does not perform executable discovery, run version/help probes, execute tasks, download dependencies, or inspect authentication/session state. For planner-runnable commands it emits a success case with exact planner-produced argv, positive boolean-switch coverage, enum-map branches, bounded-integer rejection cases, enum rejection cases, and constrained-positional leading-dash rejection where those contracts apply. Commands already blocked by the current risk/auth/output policy receive the corresponding planner-rejection case instead. The generator self-verifies every case through the production planner before writing, refuses to overwrite an existing output file, observes the existing 256-case fixture bound, and fails closed rather than inventing a value when a declared string constraint cannot be satisfied by its bounded deterministic sample set. Generated argv remains a reviewable scaffold: authors must compare it with authoritative vendor documentation/source before treating it as a semantic contract.\n\n`pack test` adds a deterministic planner-contract layer without granting execution authority. The cases file uses schema `cliharbor.packtest/v1`; each case supplies a pack ID, command ID, typed JSON values, and exactly one expectation:

- `expectArgs`: the exact argument vector the production planner must build; or
- `expectError`: the planner error `code` and, optionally, exact `path`.

Example:

```json
{
  "schemaVersion": "cliharbor.packtest/v1",
  "cases": [
    {
      "name": "safe detailed inspection",
      "packId": "example",
      "commandId": "inspect",
      "values": {"limit": 5, "verbose": true, "mode": "detailed"},
      "expectArgs": ["inspect", "--limit", "5", "--verbose", "--detailed-mode"]
    },
    {
      "name": "reject out-of-range limit",
      "packId": "example",
      "commandId": "inspect",
      "values": {"limit": 0, "mode": "safe"},
      "expectError": {"code": "invalid_input", "path": "values.limit"}
    }
  ]
}
```

The cases file is bounded, strict JSON: unknown fields, duplicate keys, excessive nesting, invalid UTF-8, multiple JSON documents, symlinks, oversized files, duplicate case names, malformed pack/command/input identifiers, unsupported error codes, and ambiguous expectations fail closed. The runner loads the target pack through the normal hardened loader and invokes the real production planner against synthetic temporary discovery identity. It does **not** execute the declared CLI, version probes, help/evidence probes, or tasks. Failure output reports case metadata and mismatch class but deliberately does not echo input values or argv. Test fixtures should still never contain credentials or secrets.

`validate` establishes structural/schema/semantic/security validity; `lint` adds deterministic static authoring-quality/security diagnostics; `generate-tests` scaffolds reviewable planner contracts; `test` verifies planner behavior against declared contracts. None of these commands proves that a vendor CLI is installed, compatible beyond declared evidence, or semantically correct. After those authoring checks, use `doctor --pack-file ...` or `doctor --pack-dir ...` for actual executable discovery and only add commands supported by reviewed vendor documentation/source or captured evidence.

## 19. Vendor-session readiness metadata

A tool may declare one reviewed presentation-only session check:

```yaml
runtime:
  tools:
    example:
      executableNames: [example]
      sessionCheck:
        commandId: session-status
        unauthenticatedStderrContains: "sign in required"
```

The referenced command must:

- belong to the same tool;
- use risk `read`;
- declare no browser inputs;
- return no secret-bearing output;
- require `authMode: vendor-session`.

The optional `unauthenticatedStderrContains` marker is bounded trusted pack metadata. It may classify one reviewed vendor error as authentication-required in the browser, but it is not an authorization signal. Leading/trailing whitespace and control characters are rejected. If no marker is declared, non-zero execution remains an unknown/failed check rather than being guessed as signed out.

Tools may use `vendor-session` tasks without declaring a `sessionCheck`. In that case the Authentication page reports that no reviewed check exists and does not invent one from help text, exit codes, kubeconfig files, or arbitrary commands.

The session check uses the same planner/executor and executable-identity protections as every other browser task. It grants no credential input, shell, executable-selection, or extra command authority.

## 20. Phase 0 evidence

A discovery/evidence-only pack may use:

```yaml
commands: {}
```

`packs/phase0/idira-cyberark-inventory.yaml` remains deliberately separate from executable vendor packs. It establishes discovery evidence without granting vendor task authority.

The typed export schema `cliharbor.phase0/v1` is inert review data. Evidence inspection never converts captured prose/help/argv into a trusted executable pack automatically.

Promotion from evidence/documentation into a real pack remains an explicit source change with human-reviewable provenance.

## 21. Portable current-user install metadata

A tool may optionally declare an immutable portable artifact contract:

```yaml
install:
  version: 1.2.3
  artifacts:
    windows-amd64:
      url: https://vendor.example/releases/tool.exe
      sha256: <64 lowercase hex characters>
      sizeBytes: 12345678
      format: executable
      executableName: tool.exe
```

ZIP artifacts additionally declare one exact `archivePath`, the extracted executable SHA-256, and extracted executable size. Redirect hosts must be explicitly declared when the authoritative release endpoint redirects to another download origin.

Install metadata grants only this narrow authority:

- download one HTTPS artifact declared by a trusted pack;
- enforce bounded size and redirect count;
- verify exact bytes before activation;
- extract at most one exact reviewed ZIP member when applicable;
- write only beneath CLIHarbor's current-user managed-tool cache;
- mark the managed file executable for that user;
- re-verify a previously installed managed copy before selecting it on a later startup.

It does **not** grant shell, package-manager, arbitrary URL, arbitrary archive extraction, installer execution, PATH mutation, registry/service, elevation, or machine-wide filesystem authority. The browser request contains only `packId` and `toolId`; artifact details are never browser-controlled.

A successful browser install deliberately requires a CLIHarbor restart before execution. Runtime discovery and execution authority stay immutable for the lifetime of the current server/run-manager instance.

## 22. Current Conjur implementation

`packs/conjur/conjur-v9.yaml` is the first real vendor pack derived from authoritative upstream evidence.

It is version-gated to the documented Conjur CLI 9.x contract and exposes only verified read-only/non-secret workflows using `vendor-session` authentication. See [Conjur CLI 9.x Integration](CONJUR_INTEGRATION.md) for provenance, included commands, and the managed-laptop qualification boundary.

## 22. Extension rule

Future pack features must preserve the central invariant:

```text
trusted validated pack -> trusted discovered tool -> validated typed inputs -> deterministic exact argv -> bounded direct execution
```

If a feature would turn the pack/browser into a generic shell or move credential/authorization authority into untrusted browser input, it does not belong in this contract.
