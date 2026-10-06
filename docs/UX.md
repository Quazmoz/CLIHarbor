# UX Specification

## 1. UX objective

CLIHarbor should make powerful CLI workflows feel like a deliberate operator console, not a web terminal.

The UI should preserve the transparency and precision of a CLI while reducing memorization, typo risk, and context mistakes.

## 2. Core navigation

The application uses a persistent left sidebar grouped into Workspace, Security, and Manage:

```text
CLIHarbor
├─ Workspace: Overview, Tasks, Runs
├─ Security: Authentication
├─ Manage: Add a CLI, Diagnostics
└─ Tools: categories from the authorized task catalog; Conjur includes Security audit
```

The top bar shows the current page, runtime connection state, and a **Sign in** button linking to Authentication. This button opens tool sign-in; it never claims a vendor session is authenticated. On narrow windows, **Menu** toggles the sidebar. Navigation preserves native links, page titles, and focus to main content.

Tool categories filter only the current authorized catalog by exact pack/tool identity. Each executable has its own category, including when a reviewed pack contains several tools or different packs use the same tool ID. Labels show the pack name and executable tool ID. Selecting a category resets the form to a task in that category, and **All tools** restores the full catalog. Search, Favorites, and Recently used obey the same category filter. Category changes are disabled while a task is starting or running. These filters are transient navigation state and create no execution authority.

## 3. Persistent context bar

Every page that can execute a command should show compact context:

- selected pack;
- resolved CLI/tool and version;
- active profile/account/tenant when available;
- authentication state;
- local-only status.

For mutating/destructive operations, target context must be more prominent.

## 4. Home page

Home answers four questions immediately:

1. Is CLIHarbor running safely on this computer?
2. Which wrapped tools were found?
3. Am I authenticated?
4. What should I do next?

The implemented Overview is a dedicated operator dashboard rather than a second copy of the task runner. It summarizes tool readiness, task availability, and the local-only boundary; chooses a conservative next step from authoritative runtime/tool state; exposes one-click Favorites/Recently used task entry; and keeps tool sign-in available below the readiness summary without inventing an authentication verdict. Ready vendor-session CLIs remain visible on Overview independently from whether a browser credential adapter is currently available. When the backend advertises the reviewed Conjur password adapter, the same real sign-in card exposes browser login; otherwise the card still reports the detected CLI and allows the reviewed session check without misrepresenting a configuration/authentication limitation as failed CLI detection. Task configuration/execution lives on `/tasks`, diagnostics on `/diagnostics`, and retained history on `/runs`.

When at least one tool has available tasks, Overview recommends Tasks even if another optional CLI needs setup. The readiness counts continue to show unavailable tools. If no tasks are available, tool setup remains the recommended next step.

Example cards:

```text
Idira Identity CLI
Detected: Yes
Path: C:\...\idsec.exe
Version: x.y.z
Authentication: Signed in
[Open tasks] [Refresh]

Idira Secrets Manager CLI
Detected: Yes
Version: x.y.z
[Open tasks]
```

If a tool is missing, incompatible, ambiguous, or otherwise unavailable, show sanitized remediation rather than an empty state. The browser diagnostics view must not expose resolved executable paths or ambiguous candidate paths; exact filesystem evidence remains in the local `cliharbor doctor` output.

## 5. Task browser

Tasks should be grouped by outcome, not by raw command syntax where possible.

Each task shows:

- human name;
- one-line purpose;
- tool;
- risk badge (`Read`, `Change`, `Destructive`, `Interactive`);
- auth requirement;
- optional tags.

Search should match task names, descriptions, and CLI terminology. While a query is active, the browser shows one non-duplicated Search results section instead of repeating the same match under Favorites, Recently used, and All tasks. Empty Favorites/Recently used groups stay hidden until they contain useful shortcuts, and a catalog count keeps the operator oriented without exposing execution authority.

The catalog opens for initial discovery, then collapses after explicit selection so configuration stays within reach. **Change task** reopens it; `/` also opens the catalog and focuses search. Selection moves focus to the configuration heading. Mobile runtime counts stay in one compact row.

## 6. Task form

A task page contains:

- task purpose;
- required context;
- typed fields;
- inline validation;
- optional advanced fields collapsed by default;
- risk/side-effect explanation;
- sanitized command preview;
- Run button.

The implemented task workbench presents the normal path as four explicit operator steps: **1 · Select**, **2 · Configure**, **3 · Verify**, **4 · Result**. The result panel remains beside the task form on desktop and stacks below it on narrower layouts; on desktop it stays sticky while the operator moves through longer task forms. This is presentation-only—planner/executor authority and run lifecycle semantics are unchanged.

The command preview is valuable for power users but must not expose secret fields. The normal UI now says **See what CLIHarbor will run** and confirms that validation succeeded first. Exact executable-name + argv text remains available under **Show exact command** rather than dominating the form.

The preview is a representation generated by the trusted execution plan, not executable text copied back into the runtime or reparsed for execution.

Preview uses the same native required/type/range validation as Run. **Reset inputs** restores the selected task's initial values and clears any preview or validation failure. Task selection and inputs are locked while a run is starting or remains active, and rapid duplicate submissions produce only one start request. A run no longer retained by the backend does not lock the operator out of starting another task.

## 7. Authentication flow

Authentication is a first-class operator page at `/authentication`, not a generic SaaS login card.

Current behavior:

- discover every browser-visible vendor-session tool from sanitized backend metadata;
- show tool readiness independently from vendor-session readiness;
- run **Check session** / **Re-check session** only when the trusted pack declares a reviewed zero-input non-secret `sessionCheck`;
- show `Authenticated` only after that declared check exits successfully;
- show `Authentication required` only when a reviewed pack marker matches the bounded stderr evidence;
- keep every other vendor failure unknown/failed rather than guessing that permission, network, configuration, or runtime failure means signed out;
- show safe allowlisted identity context from successful JSON only when the reviewed result provides it;
- show **Session check unavailable** for vendor-session tools such as kubectl that deliberately declare no reliable generic check;
- keep unavailable tools actionable through Diagnostics and allow ready no-check tools to continue to Tasks without inventing an auth verdict;
- guide non-zero auth-required task runs back to Authentication without asserting that authentication caused the failure;
- support direct browser refresh on `/authentication`, `/tasks`, and `/diagnostics`.

CLIHarbor exposes a dedicated Conjur sign-in card only when the backend advertises the exact reviewed Conjur password adapter. On an already configured computer, the primary path is simply **Identity**, **Password**, then **Sign in and verify**. When the backend marks first-run connection setup as required, the same card becomes a two-step form: **Connection** (HTTPS server, account, standard/LDAP mode and LDAP service ID when needed) followed by **Credentials**. **Save connection and continue** must succeed before password entry appears; a separate **Sign in and verify** submission hands the password to the local credential bridge and runs the authoritative session check.

Connection metadata is non-secret and is sent only to the authenticated loopback configuration endpoint. The backend delegates it to the exact discovered Conjur CLI using a fixed reviewed `init self-hosted` argv; the UI cannot choose arbitrary flags or request insecure/self-signed bypasses. Identity/password are sent only to the authenticated loopback credential endpoint for that attempt, never enter command argv or run history, and are not persisted by CLIHarbor. The pinned vendor API owns credential exchange/storage behavior.

For reviewed Conjur OIDC, JWT, and SaaS/cloud modes on Windows, the same card instead shows **Start official Conjur sign-in**. That action sends only pack/tool identity to the local backend. CLIHarbor revalidates the exact executable and starts fixed `conjur login` argv. OIDC/JWT avoid an unnecessary console window; OIDC may open the vendor browser flow. SaaS/cloud uses an isolated console host with explicit native console handles for vendor-owned challenges. The result stays visible until the operator closes the window after the vendor exits. Fast non-zero hidden-process exits are surfaced as sanitized launch failures. CLIHarbor does not capture credentials or vendor interaction. After the user completes the vendor flow, **Check session** remains the authoritative verification step. Certificate, IAM, Azure, GCP, and unknown modes stay on the organization's external flow rather than being guessed.

CLIHarbor local browser-session state and vendor-owned CLI session state remain explicitly separate. A healthy executable is never displayed as proof of authentication.

## 8. Run view

A run has states:

```text
Planning -> Running -> Succeeded | Failed | Cancelled | Timed out
```

The page should contain:

- task name and run ID;
- start time/duration;
- active context;
- sanitized invocation;
- structured result panel if available;
- raw stdout/stderr tabs;
- exit code;
- warnings/parser status;
- Cancel while running;
- Retry with inputs after completion.

Stdout and stderr should remain distinguishable.

Accepting a new run moves focus to its result heading, including on narrow windows. The result shows the executed task's name even if the operator later selects another task. Output already present in the create response is rendered immediately, including when the run finished before streaming could begin. UTF-8 decoding preserves characters split across chunks independently for stdout and stderr; incomplete bytes are held while running and flushed when the run ends.

Live replay is deduplicated by run identity and event sequence. Five failures without a new validated event stop automatic recovery; opening another empty connection does not reset that budget. A permanently closed connection reconciles immediately. CLIHarbor reconciles against the retained snapshot and offers explicit recovery. Authentication checks replace partial evidence with the authoritative snapshot rather than appending replayed evidence twice. Cancellation responses apply only to the run that requested them.

## 9. Structured results

Phase 5 implements a minimal cards renderer for validated scalar structured results. The browser consumes only the backend's normalized DTO, validates its fixed shape again, and renders labels/values as ordinary React text. HTML/script-looking field values are data, not markup.

If parsing is invalid or unavailable, show the stable parser status/error and explicitly keep raw stdout/stderr accessible. A non-zero CLI exit never becomes a structured success. Raw output remains evidence even when structured parsing succeeds.

Implemented structured-result conveniences:

- client-side filtering across validated field labels, keys, and displayed values;
- stable source-order, label, and key sorting without changing backend data;
- explicit per-field copy for present validated values only;
- an expandable normalized JSON inspection view built from the validated structured DTO rather than raw process output.

Still deferred:

- export of non-secret results.

Do not add export to secret-bearing results without explicit classification and review. Copy behavior must also be revisited before any secret-bearing browser workflow is enabled.

## Managed CLI installation

**Add a CLI** at `/tools` provides a searchable catalog of configured supported CLIs with readiness, pinned install versions, and **Open tasks**. Overview links to it. Diagnostics retains the same install controls. **Install <tool>** appears only for a missing tool with a trusted portable artifact for the current OS/architecture.

The install card includes an optional **Install base directory** field. Blank means CLIHarbor's default current-user cache. A custom value must be an absolute path beneath the current user's home. The UI states that this is a current-user install and requires no administrator credentials. Successful installation qualifies the binary and populates Tasks and the tool sidebar without a restart. Installation and vendor sign-in stay separate. See [supported CLI catalog](CLI_CATALOG.md).

The browser never chooses the downloaded artifact, executable filename, hash, archive member, redirect host, or task execution path. Invalid custom locations return a field-specific validation error instead of a generic policy failure.

## 10. Error UX

The implemented local browser contract separates task-start failures, run failures, live-stream failures, cancellation, timeout, and retained-run eviction. Browser API errors carry a stable code, category, reviewed safe message, optional remediation, retryability, and an optional validated task-field association. The frontend branches on the typed code; it does not parse backend prose.

Current generic categories cover:

- CLIHarbor request/input validation;
- browser security/session boundary rejection;
- unavailable or changed discovered tools;
- current execution-policy blocks;
- run/stream capacity and lifecycle state;
- local process/output-limit failure;
- internal local runtime failure.

Task-field failures are associated with the affected control, mark it invalid, expose an accessible description, and move focus to that control. Declarative integer/string/enum/multiselect/boolean constraints also provide inline help before failure when the existing task metadata supports it. Material runtime-load failures receive focus. Run status and live-stream connection state use targeted live regions rather than making raw stdout/stderr one large live region. Cancellation and timeout remain visible text states, and retained-run eviction removes stale cancel/retry controls. Stable error codes/categories remain available under **Technical details** instead of leading the normal failure message.

Raw vendor stderr remains untrusted run evidence and is not promoted into the typed error DTO. Vendor-specific permission/network/auth remediation remains gated on documented managed-laptop evidence rather than guessed strings. Unknown or malformed future error DTOs degrade to a generic bounded local-response failure.

## 11. Destructive commands

Destructive tasks require deliberate friction:

- warning banner;
- exact context/target;
- description of effect;
- typed target confirmation for high-impact actions;
- final confirmation enforced by backend.

Color alone must not convey risk.

## 12. Run history

The browser now exposes a first-class `/runs` page backed by the existing bounded in-memory run manager.

History is intentionally process-local:

- retained runs are shown newest-first;
- restarting CLIHarbor clears the history;
- completed runs are evicted at the manager retention bound while active runs are preserved;
- the list endpoint returns metadata only: run/task/tool identifiers, tool version, status, timestamps and exit code;
- list responses do **not** include stdout/stderr events, structured result payloads, failure prose, task inputs, argv, executable paths or credentials;
- selecting a run explicitly fetches that one retained snapshot through the existing single-run endpoint;
- retained structured output and raw stdout/stderr remain inert browser text and preserve their existing output boundaries;
- an already-evicted run produces the normal stable `run_not_found` lifecycle error rather than a stale detail view.

No persistence or history-retention setting has been added. That remains a separate policy decision, especially before secret-bearing workflows are ever enabled.

Initial list/detail requests announce loading and expose their busy state. Active history polling permits only one request per surface at a time, ignores responses from abandoned selections, and refreshes immediately when the page becomes visible again. Completed selected evidence is not polled merely because another run is active, and nonretryable failures stop automatic polling for that surface. Selecting the currently displayed run preserves its evidence. Background refresh leaves existing evidence readable through temporary connection failures; authoritative eviction clears it.

## 13. Settings

Initial settings:

- binary path overrides;
- browser auto-open on/off;
- pack details/version;
- diagnostics view;
- history retention preference if persistence exists.

Settings should include a clear statement that the server is listening only on loopback.

## 14. `doctor` experience

A CLI command such as `cliharbor doctor` should diagnose:

- OS/platform;
- CLIHarbor version;
- pack load/validation;
- supported CLI discovery;
- resolved path/version;
- port binding capability;
- browser launch capability;
- auth state only if safely queryable.

Output should be copyable for support and pre-redacted.

## 15. Accessibility

MVP requirements:

- full keyboard navigation;
- visible focus;
- semantic labels;
- accessible form errors;
- no risk/state communication by color alone;
- screen-reader-compatible run status changes;
- sufficient text contrast;
- logical heading structure.

The current task/run UI implements semantic labels, visible focus, field-linked validation errors, keyboard-operable native controls, focused material load/task failures, targeted `aria-live`/status regions for asynchronous run/stream state, text descriptions for cancellation/timeout/failure, and keyboard-focusable stdout/stderr regions. Continue qualifying new auth/confirmation/dialog surfaces as they are introduced.

Route changes update the browser title and move focus to main content, including browser back/forward navigation. Search result counts have a targeted live announcement and Clear returns focus to search. Native controls use the dark color scheme, and task-row focus outlines remain visible outside their borders.

## 16. Responsive behavior

Primary target is enterprise Windows laptops. Support narrow browser windows without horizontal layout failure. Production browser E2E explicitly exercises the task workflow at 1440, 1024, 768, 390, and 320 CSS pixels. The catalog grid constrains its column so long tool labels cannot widen forms on small screens. Large result tables may scroll within their result region rather than forcing page-wide overflow.

## 17. Design tone

The visual style should be clean, restrained, technical, and trustworthy. Avoid heavy animation, consumer-game styling, AI gradients, or visual effects that distract from operational context.

The implemented operator workspace keeps the local-only boundary and build identity in a compact shell, summarizes runtime/tool/task readiness before the primary workflow, places task configuration beside the active run, treats validated structured results as primary, keeps raw stdout/stderr available through native disclosure, and keeps sanitized tool diagnostics collapsed by default. The design uses native controls and disclosure semantics so keyboard and screen-reader behavior do not depend on a component framework.

## 18. MVP UX acceptance criteria

A first-time user can, without reading documentation:

1. launch the app;
2. identify whether the required CLI exists;
3. understand authentication status;
4. initiate sign-in;
5. locate a supported read-only task;
6. complete its form correctly;
7. see what will run;
8. execute it;
9. understand success/failure and exit state;
10. access raw output when structured rendering is insufficient.

## Phase 0 operator evaluation UX

The first work-laptop evaluation is intentionally terminal-led:

1. verify the executable checksum;
2. run `version`;
3. run `self-test`;
4. run sanitized `inventory` against an explicitly trusted Phase 0 pack;
5. optionally select only approved named help/version probes;
6. export a reviewed `cliharbor.phase0/v1` bundle;
7. optionally start `serve` to validate the normal browser handoff.

Inventory output shows stable pack/tool IDs, readiness state, parsed version when available, candidate count, and sanitized remediation. Exact candidate/executable paths remain in operator-only `doctor` output. The browser continues to expose only the safe task/tool DTOs established by earlier phases.

If default-browser launch fails, the terminal prints the one-time local bootstrap URL. The URL is a short-lived credential and must not be included in evidence or support transcripts.


## 19. Task discovery preferences

The `/tasks` route provides client-side search across the backend-authorized task catalog, plus distinct **Favorites**, **Recently used**, and **All tasks** sections. Search covers task name/description, pack name/ID, tool ID, and command ID only; it does not inspect run output, task values, executable paths, argv, credentials, or arbitrary filesystem content.

Favorites and recently used tasks are browser-local navigation preferences. The persisted structure is versioned and contains only bounded `packId` + `commandId` identities. It does **not** persist task form values, vendor credentials/session material, stdout/stderr, structured run results, failure text, argv, or executable paths.

Browser persistence is treated as untrusted input. Malformed, oversized, or unavailable storage fails closed. Persisted identities are always reconciled against the current trusted backend catalog before display; stale identities are removed and never create execution authority. Recently used tasks are deduplicated, newest-first, and bounded to eight entries.

Selecting a task from Favorites, Recently used, or All tasks feeds the same existing task form and backend execution path. Auth-required catalog entries are labeled **Sign-in required**; the task browser does not claim the vendor session is currently authenticated. Pack/tool/command identifiers remain searchable and available in technical task details, but they no longer dominate each task row. The Authentication page remains authoritative for session readiness checks.

The task search supports keyboard operation and a page-local `/` focus shortcut that is ignored while typing in editable controls. Favorite toggles use native buttons with `aria-pressed`, task selection uses native buttons, focus remains visible, and the compact row layout is qualified for the 1366 × 768 enterprise-laptop target and narrow windows.
## Local testing on Windows and macOS

The operator pages and responsive layout are shared across Windows and macOS. Normal startup always uses the embedded product packs; there is no demo launcher or fallback to synthetic tasks. The fixture CLI and example pack are retained only for automated development checks.
