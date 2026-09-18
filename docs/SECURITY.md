# Security Model and Threat Model

## 1. Security posture

CLIHarbor is deliberately local and thin, but it is security-sensitive because it discovers and is intended to launch powerful local CLIs while rendering future output in a browser.

“Localhost” is not a security boundary by itself. Browser requests, pack files, PATH, local executables, process output, filesystem state, and user input all cross trust boundaries.

Phases 1-4 implement the browser/session boundary, trusted pack boundary, fail-closed tool-discovery/version-probe boundary, and the read-only planner/executor boundary. Phase 4c-A permits browser-triggered execution only through authenticated loopback create/get/cancel APIs that accept pack/command IDs plus typed values; executable/path/argv authority remains server-owned. Phase 5 adds bounded post-execution structured parsing without granting parsed output any execution authority.

## 2. Assets to protect

- Vendor credentials/MFA challenges and CLI-owned tokens.
- Secrets returned by wrapped CLIs.
- Tenant/account/context identifiers.
- Current-user filesystem/process authority.
- Integrity of pack/tool/task definitions.
- Integrity of executable selection and user intent.
- Diagnostic/run metadata.
- Browser session/bootstrap/CSRF material.

## 3. Trust boundaries

### Trusted with constraints

- CLIHarbor compiled runtime.
- Built-in pack bytes deliberately supplied by trusted code.
- Explicitly approved local pack files/directories.
- A discovered tool only after it satisfies the declared name/path/version discovery policy; this proves compatibility, not publisher identity.

### Untrusted or potentially hostile

- Browser input and browser request context.
- CLI stdout/stderr/error text.
- User free text and environment variables.
- PATH contents/order and binaries found through PATH.
- Repository/cwd files merely because CLIHarbor runs there.
- Development frontend/Vite process and responses.
- Third-party packs until explicitly approved.
- Web content open in the browser.

## 4. Core invariants

### SI-1 No arbitrary shell execution

Browser task input must never become a free-form command string. Normal execution is:

```text
trusted pack task + validated typed values + ready discovery state
  -> immutable plan
  -> exact executable path + argv[]
```

CMD/PowerShell/POSIX shell command-string execution is forbidden for normal tasks. Pack v1 also rejects common shells, general interpreters, Windows script extensions, and several launcher binaries as tool declarations.

Phase 3 version probes use fixed pack-authored argv and no shell. They now share the platform process-lifecycle controller used by execution/evidence probes, run from a neutral temporary directory with a minimal inherited environment, and fail closed on timeout, non-zero exit, oversized/truncated output, invalid UTF-8, or ambiguous/no semantic version. Phase 4 task planning validates typed values against trusted command definitions and the executor invokes only the resulting executable path plus exact argv; it does not reinterpret values through a shell.

### SI-2 No browser-selected executable

The browser cannot provide executable names or paths. Tool names come from a trusted pack. PATH discovery and `--tool-path` configuration happen in the backend/operator boundary. An explicit override must reference an existing `pack/tool` and match its executable basename allowlist.

### SI-2A Structured output is data, never authority

Structured parsing runs only after the authoritative executor invocation finishes. Pack v1 can declare only a strict top-level JSON object with bounded scalar fields; it cannot declare scripts, executable templates, reflection, nested transformation logic, or arbitrary adapters. The parser caps structured stdout at 64 KiB, caps scalar strings at 8 KiB, rejects duplicate/unknown fields, invalid UTF-8, nested values, numeric overflow, and unsafe control characters, and does not parse a non-zero execution as success.

Raw stdout/stderr events and the executor's run/exit state remain authoritative evidence. Parser failure produces a stable sanitized parser status while leaving raw evidence accessible. Structured results are attached only to the same in-memory run record that captured their stdout. Completed results are cloned into that run's `run-complete` SSE payload, preserving the run ID/status association without a second normal-completion lookup. Reconnect recovery may still use the authenticated snapshot endpoint. This prevents parser output from becoming a new execution request or being associated by browser input with another run.

Commands whose output is declared secret-bearing cannot enable structured rendering in this phase, and structured fields marked sensitive are rejected at pack validation. CLI-like output remains untrusted even when valid JSON.

### SI-3 Loopback only

The server binds to IPv4 loopback by default. Remote access requires a separate reviewed product/security design.

### SI-4 Credentials remain vendor-owned

CLIHarbor does not persist passwords, MFA values, API tokens, or access tokens. Pack v1 has no secret input type and no credential scripts.

### SI-5 Secrets do not enter URLs or normal diagnostics

Credentials/secrets must not enter query strings, browser history, normal logs, invocation previews, analytics, crash telemetry, or persisted run history.

The one-time browser bootstrap token is the narrow exception: it exists in a short-lived loopback bootstrap URL, is single-use, is exchanged for an HttpOnly host-only session cookie, then is removed from navigation history by redirect.

Version-probe raw output is not retained in discovery state/doctor output.

### SI-6 Pack trust is explicit

Schema/semantic validation does not make a pack trusted. CLIHarbor does not scan cwd, auto-load repository `packs/`, load remote URLs, auto-download packs, or execute pack/plugin code. Supported sources are trusted built-in bytes or explicitly named local files/directories.

## 5. Threats and mitigations

### T1 — Shell/argument injection

**Threat:** user-controlled values alter argv structure or escape into a shell.

**Current controls:** v1 task arguments are only trusted literals, fixed flags fed by typed scalar inputs, boolean switches, and enum-to-pack-literal maps. The Phase 4 planner validates exact runtime types/constraints and constructs argv server-side. Executables/flag names/subcommands cannot be supplied by browser input. String/enum values used as flag values reject NUL and, where declared, leading `-`. Optional flag/value pairs omit together. The executor directly starts the planned executable with its argv and never concatenates a shell command.

### T2 — Malicious web page attacks localhost

Mitigations: unpredictable launch/session material, SameSite+HttpOnly cookie, exact Host validation, rejection of every request that carries a non-empty foreign `Origin`, mandatory exact same-origin plus CSRF validation for mutations, restrictive CORS, and an unpredictable ephemeral loopback port. Origin-less reads remain valid for non-browser/local clients but still require the authenticated session where applicable.

### T3 — DNS rebinding / Host abuse

Only the exact bound loopback Host is accepted. Host headers are not trusted as authority.

### T4 — XSS through CLI output

Future CLI output is untrusted text/data. React escaping, restrictive CSP, no raw-HTML rendering, and sanitation of any later rich renderer are required.

### T5 — Secret leakage through output

Pack metadata can classify secret-bearing output and cannot simultaneously request raw persistence/default reveal. Future execution/history/UI must enforce deliberate reveal/copy and no persistence of secret output.

### T6 — Secret leakage through argv

Pack v1 intentionally has no `secret` input. Future support requires explicit security design; credentials should remain in vendor-owned login/session mechanisms rather than process-list-visible argv.

### T7 — PATH hijacking / executable ambiguity

**Threat:** a malicious or unintended binary satisfies a declared basename.

**Phase 3 controls:**

- discovery starts only after an explicitly trusted pack is loaded;
- only absolute PATH directory entries are searched; empty/relative/cwd entries are ignored;
- candidate paths are resolved to absolute targets and exact paths are surfaced by `doctor`;
- multiple matches are `ambiguous`; no first-PATH-hit guessing;
- operator may pin one absolute path with `--tool-path pack/tool=...`;
- invalid explicit override is fail-closed and does not fall back to PATH;
- selected basename must match the pack allowlist;
- version probes/constraints can block incompatible binaries.

**Executable identity control:** discovery captures an opaque in-memory identity for the selected regular file. When a version probe runs, discovery rechecks that identity after the probe before accepting version evidence, so replacement during probing fails closed. Planning requires the same identity; execution rechecks filesystem identity, size/modification metadata, and a SHA-256 content fingerprint immediately before process creation. Same-path replacement and same-size content mutation between discovery and execution are rejected, including metadata-collision cases observed on Windows.

**Residual risk:** name/path/version/file identity does not prove vendor publisher identity. Enterprise publisher/signature/hash validation may be added where required.

### T8 — Malicious pack / parser abuse

Controls include explicit source trust, 256 KiB bound, UTF-8 requirement, single YAML document, no aliases/anchors/merge/custom tags, duplicate/non-string key rejection, depth/node bounds, strict schema/unknown-field rejection, supported API-version check, executable-path/shell/interpreter rejection, semantic cross-reference checks, deterministic non-recursive directory loading, pack symlink/non-regular rejection, and no remote/plugin loading.

### T9 — Malicious version probe

**Threat:** a pack uses discovery as a general execution hook or a tool emits sensitive/unbounded output.

**Controls:** only an explicitly trusted pack may define a probe; probe argv is fixed pack-authored data with max-item/string schema bounds; only `semver-text` parser is supported; timeout is bounded (100-10000 ms, default 3 s); stdout/stderr use bounded buffers and truncation/invalid UTF-8 fail closed; the process is launched directly without a shell from a neutral temporary directory with a minimal environment; the shared lifecycle controller owns timeout/cancellation and Windows descendants through a Job Object; non-zero exit/timeouts produce sanitized states; raw probe text is not emitted by normal diagnostics.

Version probing remains privileged execution of the selected binary and therefore depends on explicit pack trust plus discovery policy.

### T10 — Destructive command confusion

Pack v1 requires a risk class. The current planner and executor reject every risk class except `read`; there is therefore no mutating/destructive execution path to confirm yet. Before those classes are enabled, backend confirmation must be bound to exact target/context; frontend confirmation alone is insufficient.

### T11 — Long-running/noisy task process DoS

Version probes have timeout/buffer bounds. Task execution has a total deadline, explicit cancellation, per-stream output limits, `WaitDelay` protection for inherited handles, and on Windows a per-run Job Object established before the process resumes so descendants cannot outlive the run. Phase 4c-A adds bounded active-run count, bounded retained-run count, bounded in-memory event bytes, bounded request bodies, and root-context shutdown cancellation. Phase 4c-B streams only from that bounded manager state: no executor sink writes to HTTP, there are no per-client output queues, manager locks are released before network writes, concurrent long-lived stream handlers are capped (default 16) with excess requests rejected as `429 stream_capacity`, ordinary server write timeouts are overridden only for SSE, and each SSE write/flush has its own finite deadline. SSE observers are owned by the server lifecycle and are cancelled on shutdown or any `Server.Run` exit so graceful shutdown does not depend on a client disconnect. The browser also bounds automatic EventSource recovery to five consecutive failures per subscription, resets that budget after a successful reopen, performs one run-status/snapshot reconciliation when the budget is exhausted, and requires an explicit operator action for another live-stream attempt.

### T12 — Browser bootstrap exposure

Bootstrap token is short-lived/single-use, exchanged immediately, redirected away, and not printed on successful browser launch. It is shown only for explicit local recovery after automatic launch failure.

### T13 — Local privilege confusion

CLIHarbor runs as the current user and must not silently elevate. Underlying CLI elevation requirements must be explicit failures/remediation.

### T14 — Development frontend receives session authority

The dev proxy only targets explicit `http://127.0.0.1:<port>`, strips Cookie/Authorization/Proxy-Authorization/CSRF before forwarding, drops `Set-Cookie`, and never owns `/bootstrap` or `/api/*` routes.

## 6. Authentication rules

See `AUTHENTICATION.md`. Vendor CLI login/session ownership remains the rule. Browser password forms and embedded PTY remain deferred security-sensitive capabilities.

## 7. Logging and diagnostics

Safe non-secret evidence may include pack/tool IDs/versions, resolved executable path where policy allows, compatibility state, future run ID/timestamps/exit code/duration, and redacted invocation shape.

Never log passwords/MFA, access/refresh tokens, browser-session/CSRF material, secret values, full environments, secret-bearing output, or sensitive clipboard data.

Pack validation errors avoid echoing supplied values; local pack load errors redact directory context. Discovery/probe errors report stable remediation text instead of probe stdout/stderr.

## 8. Local configuration

Non-secret configuration may eventually contain explicitly approved pack paths, binary overrides, UI preferences, and bounded history settings. Repository/cwd contents must never become trusted configuration by implication.

Current CLI configuration is process-local via explicit `--pack-file`, `--pack-dir`, and `--tool-path`; no persistent config file is implemented yet.

## 9. Frontend hardening

- strict CSP;
- no eval/dynamic remote scripts;
- no production CDN dependencies/analytics by default;
- untrusted output rendered as data;
- dependency pinning/scanning;
- embedded frontend source/build drift checks;
- dev proxy never receives CLIHarbor session authority;
- explicit secret/destructive UX when those features arrive.

## 10. Dependency/supply chain

Keep dependencies narrow and pinned/checksummed. Current pack/discovery dependencies include YAML v3, jsonschema v6, and Masterminds semver v3.5.0. CI verifies `go.sum` module integrity, audits the locked frontend dependency tree, and runs pinned `govulncheck@v1.8.0` against reachable Go code. Ordinary local builds emit the compatibility checksum `bin/SHA256SUMS`. Windows evaluation builds instead invalidate that generated compatibility manifest and emit one authoritative `EVALUATION_SHA256SUMS` covering both the evaluation executable and the explicitly trusted Phase 0 pack. Checksum manifests are staged in the destination directory, synced, and activated with platform-specific atomic no-replace semantics; callers must explicitly invalidate a stale generated manifest before rebuilding, so concurrent generators cannot silently overwrite one another. The same Go verifier rejects malformed/aliased entries, unexpected entry counts, non-regular privileged files, a present compatibility manifest, and digest mismatches; CI reruns it immediately before uploading exactly the covered privileged files plus the root manifest. Reproducible release artifacts, SBOM generation, and eventual Windows signing remain release-hardening work.

## 11. Security verification

Implemented regression coverage includes pack structural/semantic/trust/resource-bound cases plus Phase 3 discovery cases for:

- one valid candidate;
- multiple PATH candidates failing as ambiguous;
- relative PATH entries ignored;
- explicit invalid override failing without PATH fallback;
- explicit override resolving ambiguity;
- unknown override references rejected;
- incompatible semantic versions;
- ambiguous version output failing closed;
- probe failures not exposing captured output;
- unsupported platform not probing;
- discovery snapshot defensive-copy behavior;
- CLI override parsing and mixed pack-source rejection.

Phase 4 regression coverage now includes typed/malformed runtime values, exact argv/metacharacter handling, zero values, policy gating, executable identity/replacement detection, cancellation before/after output, timeout, non-zero exit preservation, output exhaustion, sink failure, setup-failure cleanup, neutral temporary-directory cleanup, Unicode/spaces, double cancellation, and Windows Job Object descendant cleanup including inherited stdout/stderr handles.

Phase 4b adds integration proof across the real trust chain: an explicitly named local pack is parsed/validated into the registry, a backend-only absolute executable override is resolved and version-probed, the planner derives executable/argv authority exclusively from that state, and the executor output/exit behavior is compared to direct fixture invocation.

Phase 4c-A regression coverage adds authenticated browser execution without widening authority: exact Host/session/Origin/CSRF controls, strict UTF-8 JSON, duplicate-key/unknown-field rejection, request-size limits, stable sanitized error codes, server-generated run IDs, bounded concurrency/retention/events, explicit cancellation, shutdown cancellation, and application-level bootstrap → CSRF → run execution coverage. Browser-visible snapshots omit executable path and argv; output bytes are Base64-encoded as untrusted data.

Phase 4c-B adds manager-backed replay cursor tests, authenticated SSE framing, malformed/impossible cursor rejection, disconnect-without-cancellation and server-shutdown ownership coverage, safe task-catalog filtering, sanitized authenticated tool-status diagnostics, bounded browser reconnect/reconciliation tests, and React coverage showing that CSRF stays out of rendered UI while CLI output containing markup is rendered as inert text. Browser tool diagnostics derive fixed remediation from discovery status and omit executable names/paths, candidate paths, executable identity, argv, environment, and pack source paths. Stream reconnect or manual retry observes the same run ID and cannot create another process.

The production embedded-server browser gate adds real Chrome/Chromium proof of one-time bootstrap, clean redirect, Host/Origin/CSRF rejection, authenticated task metadata, fixture execution, SSE replay, forced stream interruption, `Last-Event-ID` reconnect, bounded reconnect exhaustion plus retained-snapshot reconciliation, explicit retry/cancellation, bounded run eviction, single execution, and inert hostile markup/control-like output. Any request carrying a foreign `Origin` is rejected before session/API handling, including read/SSE requests; mutations still require the exact application origin and CSRF token.

Still required before MVP release:

- broader XSS corpus coverage for malformed/very-long output and future structured parser fallback;
- stronger policy-managed publisher/signature/expected-hash verification if enterprise policy requires trusted provenance beyond replacement detection;
- manual real vendor-path/version/auth/workflow verification on supported Windows environments.

## 12. Security review triggers

Require a new review before remote access, community/remote pack installation, embedded PTY, direct browser credential entry, secret/path input types, arbitrary plugin/adapter execution, privilege elevation, cloud telemetry, auto-update, or any feature that broadens who may choose pack sources/executables/argv/side effects.

## Phase 0 inventory and evidence security

Phase 0 inventory/evidence preserves the existing authority model:

- only explicitly trusted packs may declare tools or evidence probes;
- the browser has no inventory/evidence API and therefore no executable/path/argv authority;
- `--probe` selects only a declared `pack/tool/probe` identity;
- resolved executable and ambiguous candidate paths stay operator/backend-side and are not serialized in Phase 0 evidence;
- executable identity is revalidated immediately before an evidence probe;
- version and help/evidence probes use direct process launch, no shell, no interactive stdin, a neutral temporary working directory, the shared process-tree lifecycle controller, a minimal child environment, and strict timeout/output bounds;
- output is normalized to valid UTF-8, unsafe controls are replaced, obvious Authorization credentials/common secret assignments/JWT-shaped material are redacted, and user-home/temp/resolved-executable paths are replaced before display/export;
- evidence files are strongly typed, size bounded, staged in the target directory, permission-restricted where supported, synced, then activated with platform-specific atomic create-without-replacement semantics; Windows uses a same-directory no-replace move instead of requiring hard-link support, and concurrent exports still cannot overwrite an existing destination;
- selected probe records carry the sanitized fixed trusted argument vector for engineering provenance while excluding the executable path; raw environment dumps, PATH dumps, browser bootstrap/session/CSRF material, vendor credential stores, passwords, tokens, MFA values, cookies, and unrelated file enumeration are outside the evidence schema.

Redaction is defense in depth rather than proof that arbitrary vendor prose is safe. Operators must review the exported JSON before sharing it.

The Windows evaluation executable is intentionally unsigned. CLIHarbor does not attempt to evade application control, SmartScreen, EDR, antivirus, proxy policy, or browser policy. An environment that blocks the binary requires the organization's approved allowlisting/signing process.

The evaluation artifact's root `EVALUATION_SHA256SUMS` is its sole packaged checksum authority and covers the executable and the shipped trusted Phase 0 pack. `bin/SHA256SUMS` is not part of the evaluation artifact. This closes an intra-bundle substitution gap and removes duplicate checksum authority: changing either privileged file after qualification is detectable when the manifest is retained with the qualified artifact. It does not authenticate GitHub, a signer, a developer, or the target laptop; the GitHub artifact archive digest remains separate archive-level integrity evidence, and code signing/attestation remains out of scope until an approved identity/key model exists.

## Imported Phase 0 evidence

Imported evidence is untrusted data even when it was originally emitted by CLIHarbor. `cliharbor evidence inspect <file>` is CLI/operator-only and grants no browser, executable, argv, pack, or workflow authority.

The importer fails closed on oversized/non-regular/symlink inputs, observed file replacement or mutation while reading, invalid JSON/UTF-8, duplicate JSON keys, unknown fields, malformed identifiers/versions, duplicate identities, inconsistent discovery/probe states, invalid provenance/timestamps, unsupported control characters, common unsanitized credential patterns, and identity-bearing path/environment material excluded by the evidence contract. Captured stdout/stderr is shown only as a bounded quoted preview after validation.

A successful inspection establishes only that the file satisfies the internal evidence contract and is internally consistent/sanitized. It does **not** authenticate the file, attest that it came from the claimed build or host, prove current machine state, establish authentication semantics or command safety, or grant permission to promote arbitrary captured text into a pack. Human factual review and trusted handling of the returned artifact remain mandatory before any vendor command gains execution authority.

## Phase 0 evidence transfer integrity

Phase 0 export prints a detached SHA-256 for the exact JSON bytes written. The operator should retain that value independently from the JSON and supply it to `cliharbor evidence inspect --sha256 <digest> <file>` after transfer. Expected digests must be exactly 64 hexadecimal characters; comparison is performed on decoded bytes in constant time and mismatch fails before any review output is rendered.

This is a tamper-detection mechanism, not authentication. An attacker able to replace both the evidence and the independently trusted expected digest can still substitute data. A checksum does not prove signer identity, build identity, host identity, or truth of captured vendor output. Signed/attested provenance remains a separate future release/governance problem.

`evidence checksum <file>` validates the Phase 0 document and reports its current SHA-256, but a digest calculated only after receiving the same file cannot by itself establish transfer integrity.
