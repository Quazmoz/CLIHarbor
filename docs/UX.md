# UX Specification

## 1. UX objective

CLIHarbor should make powerful CLI workflows feel like a deliberate operator console, not a web terminal.

The UI should preserve the transparency and precision of a CLI while reducing memorization, typo risk, and context mistakes.

## Conjur migration planning and templates

The Conjur dedicated home has a collapsible **Migration playbooks & templates**
workbench (not another global navigation destination). It groups pre-built,
backend-advertised tasks into four operator-driven stages: inventory, access/LDAP
comparison, destination preparation and cutover verification. Missing or
risk-mismatched tasks remain visibly unavailable. These are shortcuts to the
existing task form, not new browser execution authority.

The Template gallery offers category-filtered curated starters as responsive
cards. Selecting a policy starter resets environment-specific identifiers and
moves keyboard focus to the existing policy builder. Identity-mapping cards
open only matching backend-advertised approval-gated LDAP forms, never invent
new commands or collect identity details in gallery state.

The workbench also constructs review-only, non-secret `!variable` and `!permit`
policy fragments from strict input fields. It clearly distinguishes the policy
branch from policy YAML, exposes one manual copy action, and links into the
existing approval-gated create/grant task forms with validated, prefilled
inputs. No task runs without an explicit operator action on the task page,
backend preview and authorization. Secret values are never accepted by the
template builder, cached in a migration plan, or exported.

### Conjur workspace

The dedicated CyberArk Conjur home starts with a compact environment summary
(CLI readiness/version, server endpoint, account and an explicitly unverified
vendor session). It then offers four keyboard-accessible tabs: **Secrets**,
**Access**, **Audit** and **Tools**. Changing the discovered tool/pack context
invalidates the prior endpoint/account evidence; an external configuration
change with unchanged discovery context still needs a fresh API read and must
never be treated as authentication proof.

**Secrets** groups the guarded create flow, variable-ID browsing, write-only
value update and destructive delete. **Access** links to the read-only Access
Explorer and backend-approved grant/revoke tasks. **Audit** links to the regex
pattern explorer and execution/mutation history. **Tools** groups reviewed
inventory commands and a collapsible migration/template workbench. Hidden tabs
stay mounted so switching sections does not destroy an in-progress guarded
create flow.

Every task shortcut is derived from the backend-advertised pack/tool task
catalog, respects runtime availability and risk classification, and opens
an in-workspace Conjur form rather than executing or approving anything.
Grant/revoke operations require backend preview, explicit approval and mutation
auditing. `!deny` only revokes grants created in the same policy branch;
permission changes are not presented as atomic. Secrets are never displayed
by the regular variable-management surfaces.

## 2. Core navigation

The left sidebar is reserved for the standard **CLI workspace** routes. **Built-in CLIs** appears only in the top bar alongside **Other CLIs**; it must never be duplicated in the left navigation:

```text
Top bar: [Find task search] [Built-in CLIs] [Other CLIs] [Activity] [CLI attention only when needed] [Connecting/error only when applicable] [Sign in] [CLI sessions]
Main content: [Breadcrumbs] above each page
Left sidebar:
  CLI workspace
    Work: Overview, Command Builder (/tasks), Execution History (/runs)
    Set up & manage: Add a CLI, Diagnostics
```

**Built-in CLIs** opens the `/dedicated` directory: one card per registered dedicated integration showing its readiness, summary, approved task count and features, each opening that integration's home. The home's reviewed feature cards reach sign-in, Access Explorer, security audit, and approved tasks without a second sidebar or execution surface. While inside an integration, the top-bar link stays current and names it (`Built-in CLIs · CyberArk Conjur`). Without any dedicated integration, the directory says so and points to Other CLIs. A new integration registers its custom home in `web/src/platforms/index.ts` (`dedicatedWorkspace`); unregistered ones get the generic feature-card home. A removed/unknown dedicated deep link must never silently resolve to another integration.

**Other CLIs** opens Add a CLI: the reviewed installation catalog and the custom-pack draft flow. The latter downloads a locally generated, discovery-only YAML draft through **Create a custom CLI pack**; it does not register, trust, validate, download binaries, or execute tasks. Operator review, `pack validate`, `pack lint`, and an explicit `--pack-file` restart remain required. Conjur workspace actions stay in dedicated forms; the general `/tasks` runner remains available separately for operators who explicitly choose it. Active built-in context is reflected in the top bar and breadcrumbs.

Clickable breadcrumbs at the top of the main content show **CLI workspace** or **Built-in CLIs → selected platform** and the current page; the top bar links to Diagnostics only when a configured CLI needs attention, with connection status displayed only while connecting or when unavailable. Build version remains in Diagnostics. The top-right **Sign in** control opens the universal sign-in page at `/authentication` (ADR-038). Every task, diagnostics, tool, and built-in-CLI sign-in link leads there; legacy `/dedicated/<id>/sign-in` links open it too. Native link modifiers, browser history, page titles, keyboard focus, and the narrow-window **Menu** sidebar toggle must continue working.

Beside **Sign in**, a compact **CLI sessions** disclosure becomes **N signed in** after reviewed session checks succeed. Opening it lists CLI names, text/symbol statuses, and last-check times, with **Manage sign-ins & check sessions** opening the universal page. Results survive page navigation in memory; reload, runtime/context changes and connection edits invalidate evidence. Unchecked and unavailable checks never count as signed in. The disclosure uses native keyboard behavior, Escape closes it and restores focus, and the panel fits a 320 px viewport. It performs no background commands; external account/session changes need a fresh session check.

Tool filtering lives in the task catalog rather than being duplicated as a second set of sidebar navigation buttons. Each executable has its own category, including when a reviewed pack contains several tools or different packs use the same tool ID. Labels show the pack name and executable tool ID. Choosing a filter selects a matching task; **All tools** restores the full catalog. A contextual scope banner on Tasks identifies the selected CLI and offers **Show all CLIs**. Integrations without dedicated task forms use the shared runner for their approved-task feature card, identified by tool context in breadcrumbs. Search, Favorites, and Recently used obey the same category filter; filters are transient and create no execution authority.

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

The implemented Overview starts with one primary next action, an Add a CLI alternative, a brief explanation, and fast favorite/recent task shortcuts before deep vendor-session controls. It is a dedicated operator dashboard rather than a second copy of the task runner. It shows only tools requiring attention and the five most recent retained executions; chooses a conservative next step from authoritative runtime/tool state; exposes one-click Favorites/Recently used task entry; and keeps tool sign-in available below the dashboard without inventing an authentication verdict. Ready vendor-session CLIs remain visible on Overview independently from whether a browser credential adapter is currently available. When the backend advertises the reviewed Conjur password adapter, the same real sign-in card exposes browser login; otherwise the card still reports the detected CLI and allows the reviewed session check without misrepresenting a configuration/authentication limitation as failed CLI detection. Task configuration/execution lives on `/tasks`, diagnostics on `/diagnostics`, and retained history on `/runs`.

When at least one tool has available tasks, Overview recommends the Command Builder even if another optional CLI needs setup. Unavailable tools remain actionable in the attention card. Summary metrics and Workspace metadata are omitted; setup guidance appears only while no workflow is ready and no recent task or retained run exists. If no tasks are available, tool setup remains the recommended next step.

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

The persistent **Find task** action in the header opens a browser-native modal task switcher on any page. Operators can also open it with **Ctrl+K / Command+K**, except while typing in form controls or while a task is running. Search matches approved task name/description, pack, tool, command ID and risk, with space-separated terms; favorites and recent tasks appear first. At most 25 matches are rendered at once. Each result shows its owning CLI and read/change/destructive plus sign-in labels. Enter selects the first result; Tab navigates result buttons; Escape closes the modal. Selecting never invokes the CLI: it clears any per-tool filter, resets the existing task form/preview/approval state, and navigates to the shared Tasks configuration. No query, form values, credential, or output data is persisted by this switcher. When the task catalog is empty or a run is active, the trigger is unavailable; the local `/` task-catalog search shortcut cannot steal focus from the open modal. The modal fits laptop and 320 px viewports.

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

The **Command Builder** (`/tasks`) is a three-column workbench. The left **Tool Explorer** lists every discovered tool grouped as *Ready to use* or *Needs setup*, with a text status badge (Ready / Not installed / Unavailable) and its task count; choosing a tool applies the same per-tool filter as the compact **Tool** select shown below 1100 CSS px, and a tool without tasks opens Add a CLI. The centre card presents three numbered steps: **1 Select tool and command** (Command / Action catalog, with a Tool select on smaller screens), **2 Configure parameters** (typed inputs in a responsive two-column grid; boolean inputs render as native checkboxes styled as switches), and **3 Command preview** (the validated invocation, colour-tokenised for reading only). Actions are **Copy command** (enabled only after validation; copies the display text, which never contains secret values), **Reset inputs**, **Validate** (read tasks) or **Review change** (mutations), and **Run command** / **Approve change and run**. The right **Execution Preflight** panel restates runtime-reported state (executable found, reviewed pack, input validation, vendor-session requirement, execution readiness) with secondary execution metadata in a collapsed native **Technical details** disclosure; it is presentation-only, grants no authority, and never claims a vendor session is signed in. Below the builder, the result panel has **Output** and **Activity log** tabs (ARIA tabs with arrow-key switching). The activity log is browser memory only, bounded to 200 entries, records task names, run IDs and safe messages (never inputs, argv, output or credentials), and is cleared by **Clear activity log** or a reload. Starting a run switches back to Output so focus can move to the result heading. Below 1500 CSS px the preflight panel moves under the builder; below 1100 px the Tool Explorer is hidden and the Tool select keeps filtering available; at wider sizes only the Explorer is shown. Both share the same filter state through viewport changes. This is presentation-only—planner/executor authority and run lifecycle semantics are unchanged.

The command preview is valuable for power users but must not expose secret fields. Before validation the preview shows a placeholder, never a guessed command; after validation it shows the exact executable-name + argv text with a "Validated by local runtime" badge and the display-only note.

The preview is a representation generated by the trusted execution plan, not executable text copied back into the runtime or reparsed for execution.

Preview uses the same native required/type/range validation as Run. **Reset inputs** restores the selected task's initial values and clears any preview or validation failure. Task selection and inputs are locked while a run is starting or remains active, and rapid duplicate submissions produce only one start request. A run no longer retained by the backend does not lock the operator out of starting another task.

Pending Command Builder validation, run start/execution, guided Conjur secret creation and permission changes, and Terraform state-removal operations show a prominent sticky working notice with a spinner and current action. Busy buttons remain disabled, display an in-progress label and expose `aria-busy`; secret creation keeps a disabled **Creating secret…** action visible after consuming its approval. The notice follows actual workflow stages (checking existence, preparing approvals, creating the variable, storing its value, granting access; applying and re-reading permissions), contains no secret value, and clears on completion or failure. A persistent polite live region announces updates; reduced-motion preferences stop spinner animation. The UI never invents completion percentages, automatically resubmits mutations, or treats loss of live output as process completion.

**Activity** stays in the top bar across routes. It combines transient operation labels with the existing metadata-only run list, links to the current workflow or exact retained run, and shows recent outcomes. Polling is single-flight, pauses while hidden, and retains last-observed metadata with an unavailable warning after failed reads. Leaving an active mutation requires an explicit navigation acknowledgement; browser Back and unload are covered too. The current CLI step may finish, but unmounting a guided form stops later dependent steps. Its in-flight activity remains visible until the request settles, and a remounted form cannot repeat the same pending mutation. Activity links to Execution History after that workflow has been left rather than implying it can resume.

Completion cards distinguish confirmed steps, unconfirmed outcomes and work not started. Guided creation reports variable creation, initial value storage and any access grant separately, with safe next actions to inspect the variable, manage access or open history. Permission results distinguish a confirmed change from failed readback. No partial mutation is automatically retried. Account/backend/target metadata is visible beside guided changes and generic approvals; reviewed generic context remains attached to the current browser run view. This is presentation evidence, not additional authorization or an atomic vendor snapshot.

## Formatted and raw output

Both the active task result and retained Run details provide **Formatted** and **Raw** views. Formatting requires an authoritative successful exit (status `exited`, exit code `0`). Failed, cancelled, timed-out and unconfirmed outcomes immediately show original stdout and stderr, with Formatted unavailable. A backend structured-parser rejection or unavailable result also stays Raw; the browser never re-parses it into a formatted result. For successful runs, Formatted uses server-validated structured fields, or a bounded read-only JSON object/array field list when no backend structured contract was returned. Operators can filter IDs/values and explicitly copy an individual scalar. Arbitrary stdout is never interpreted as executable content or inserted as HTML. Parsing is presentation-only, limited to 128 KiB, 200 scalar rows and depth eight; oversized, malformed, streaming or non-JSON output remains available in Raw. Raw preserves the exact retained stdout/stderr separation. The UI does not grant authority to reveal secret-bearing command output, which the backend's existing policy prohibits.

Successful JSON with no displayable scalar values has an explicit empty-result message; a local search that excludes existing values says **No values match**. Values omitted by preview limits keep a separate limits warning and Raw fallback. A confirmed successful command with no stdout or stderr says so while keeping both raw stream regions accessible. Empty output does not imply a vendor search had no matches or that a mutation achieved its intended effect.

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

The **Sign in** page shows one compact card per installed CLI that declares vendor-session work, built-in or custom. Each card has the CLI icon, name, version and readiness, the session state, the CLI's sign-in form (when a built-in platform supplies one), the session check, and a **settings** button. Settings hold the CLI's backend configuration (supplied by the built-in platform, if any) plus pack/runtime details and Diagnostics. Installed CLIs without vendor sign-in are listed in one line beneath the cards. Overview does not duplicate these cards.

For Conjur's reviewed password adapter, an already configured computer shows only **Identity**, **Password**, then **Sign in and verify**. When the backend marks first-run connection setup as required, the card shows **Configure backend** instead of credential fields and its settings open automatically, offering **Self-hosted Conjur** (HTTPS server, account, standard/LDAP mode and LDAP service ID when needed; **Save connection**) or **Secrets Manager SaaS** (tenant API endpoint). Password entry appears only after the refreshed runtime snapshot reports the connection configured; a separate **Sign in and verify** submission hands the password to the local credential bridge and runs the authoritative session check. For configured or vendor-login modes, settings show the current API endpoint and, when the vendor configuration allows it, **Change API endpoint**.

Connection metadata is non-secret and is sent only to the authenticated loopback configuration endpoint. The backend delegates it to the exact discovered Conjur CLI using a fixed reviewed `init self-hosted` argv; the UI cannot choose arbitrary flags or request insecure/self-signed bypasses. Identity/password are sent only to the authenticated loopback credential endpoint for that attempt, never enter command argv or run history, and are not persisted by CLIHarbor. The pinned vendor API owns credential exchange/storage behavior.

For reviewed Conjur OIDC, JWT, and SaaS/cloud modes on Windows, the card instead shows **Start official Conjur sign-in**. That action sends only pack/tool identity to the local backend. CLIHarbor revalidates the exact executable and starts fixed `conjur login` argv. OIDC/JWT avoid an unnecessary console window; OIDC may open the vendor browser flow. SaaS/cloud uses an isolated console host with explicit native console handles for vendor-owned challenges. The result stays visible until the operator closes the window after the vendor exits. Fast non-zero hidden-process exits are surfaced as sanitized launch failures. CLIHarbor does not capture credentials or vendor interaction. After the user completes the vendor flow, **Check session** remains the authoritative verification step. Certificate, IAM, Azure, GCP, and unknown modes stay on the organization's external flow rather than being guessed.

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

A lost, malformed, mismatched or internal-error run-start acknowledgement is **unconfirmed**, never proof that the CLI failed to run. The UI directs the operator to Execution History and the target before another attempt; it never automatically resubmits. Confirmed policy/input rejections keep their specific error. Opening a different history run clears previous output and errors immediately while the new evidence loads. Reopening the same selected run leaves its evidence readable.

Idempotent runtime reads have a deadline covering both headers and the complete response body: 15 seconds for memory-backed metadata and 60 seconds for probe-capable reads. Caller cancellation remains silent on navigation. These deadlines do not apply to run starts, installations, sign-in or other mutations.

## 9. Structured results

Phase 5 implements a minimal cards renderer for validated scalar structured results. The browser consumes only the backend's normalized DTO, validates its fixed shape again, and renders labels/values as ordinary React text. HTML/script-looking field values are data, not markup.

If parsing is invalid or unavailable, show the stable parser status/error and explicitly keep raw stdout/stderr accessible. A non-zero CLI exit never becomes a structured success. Raw output remains evidence even when structured parsing succeeds.

Implemented structured-result conveniences:

- client-side filtering across validated field labels, keys, and displayed values;
- stable source-order, label, and key sorting without changing backend data;
- explicit per-field copy for present validated values only;
- an expandable normalized JSON inspection view built from the validated structured DTO rather than raw process output.

**Export JSON** and **Export CSV** download the displayed fields from successful
formatted results, both in Command Builder and retained Run details. Filters and
structured-field sorting determine the exported rows. Empty selections and
generic previews that omit values because of size/depth/row limits cannot be
exported. Raw, failed, running, and parser-rejected output has no export action.

JSON uses `cliharbor.result-fields/v1`: the source run ID and a `fields` array
of `{field, value}` display pairs. Values are displayed strings; absent optional
structured fields use `null`, distinct from an empty string. Generic JSON paths
are display labels, not reversible object selectors. CSV includes run ID,
field, presence and displayed value, UTF-8 BOM and CRLF row endings; quoted
formula-like cells receive an apostrophe to prevent spreadsheet evaluation.
These are field reports, not exact raw-output or typed-JSON backups. Downloads
start only on an explicit click, stay local, and report browser failures while
retaining the visible result. No output, input, credential or query is added to
browser storage. Run IDs also identify the download filenames.

Do not add export to secret-bearing results without explicit classification and review. Copy behavior must also be revisited before any secret-bearing browser workflow is enabled.

### Terraform manual Windows setup and discovery recovery

When the backend reports Terraform missing and no reviewed managed installer exists, **Add a CLI** and **Diagnostics** show the same no-admin procedure. Copy **%USERPROFILE%**, an existing user-profile folder, into File Explorer; create `bin` there, then place an approved `terraform.exe` directly at `%USERPROFILE%\bin\terraform.exe`. Do not make users copy a folder path that may not exist yet. Show the version constraint advertised by the backend, and offer **Check installation of terraform** after placing it. Browser refresh alone does not repeat executable discovery; changed PATH entries may still require a relaunch from a fresh terminal. The dedicated Terraform workspace opens this canonical diagnostics guide rather than bypassing it with a direct vendor download.

A found-but-incompatible Terraform installation is a different state: an existing PATH match takes precedence over the user-bin fallback, so another user-bin copy will not fix it. Invalid `--tool-path` overrides likewise require operator correction; the browser cannot select executables. Keep optional User PATH and backend override instructions inside an advanced disclosure. Do not claim automatic download, live rediscovery, administrator bypass or vendor-authentication readiness.

## Managed CLI installation

**Add a CLI** at `/tools` provides a searchable catalog of configured supported CLIs with readiness, pinned install versions, and **Open tasks**. Overview links to it. Diagnostics retains the same install controls. **Install <tool>** appears only for a missing tool with a trusted portable artifact for the current OS/architecture.

The install card includes an optional **Install base directory** field. Blank means CLIHarbor's default current-user cache. A custom value must be an absolute path beneath the current user's home. The UI states that this is a current-user install and requires no administrator credentials. Successful installation qualifies the binary and populates Tasks and the tool catalog without a restart. Installation and vendor sign-in stay separate. See [supported CLI catalog](CLI_CATALOG.md).

The browser never chooses the downloaded artifact, executable filename, hash, archive member, redirect host, or task execution path. Invalid custom locations return a field-specific validation error instead of a generic policy failure.

## Guided custom CLI pack authoring

**Add a CLI** also includes a collapsed wizard for additional reviewed vendor tools. It collects a unique pack ID, display name, tool ID, executable **basename only**, and verified Windows/macOS/Linux platform selections. It locally generates a `cliharbor.dev/v1` scaffold with `commands: {}`, no probes, no auth adapter, no installer, and no command-execution authority. The YAML is presented for review and downloaded via the browser; no authoring payload is sent to the backend and there is no auto-activation endpoint.

A duplicate currently loaded pack ID, malformed identifier, executable path/script/interpreter, name containing control characters, or empty platform selection disables export. These frontend checks are only UX; `cliharbor pack validate` and `pack lint` remain the authoritative static checks. Because the draft has no tasks, an operator must independently author reviewed deterministic command definitions before work can run. The UI gives exact next steps for static validation, lint, discovery and explicitly loading the file with `serve --pack-file`; the normal built-in pack set remains additive. Wizard state is transient browser memory, not persisted credentials or approved configuration.

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

**Search runs**, **Outcome**, and **CLI** filter the retained metadata locally.
Search is case-insensitive and matches every space-separated term against task
name, pack name/ID, command, tool/version, run ID and outcome; it never fetches or
searches output or inputs. Failed outcomes include non-zero exits. CLI choices
are scoped by pack and tool, including tools no longer in the current task
catalog. Counts announce matches, and Clear filters restores all retained runs
and focuses search. Filters survive refresh in browser memory only. Filtering
does not select another run or clear its evidence; an explicit note identifies
selected evidence outside the list filters. A filter miss remains distinct
from an empty retained history.

**Pin for comparison** keeps one completed run as a transient baseline. Open
another run of the same pack, command and tool to compare recorded stdout and
stderr separately. Each side shows its run ID, outcome, version and start
timestamp; different CLI versions remain visible and comparable. Running
evidence and other tasks are not compared. Failed and parser-rejected runs can
be compared as raw diagnostics without gaining formatted-success status.

The native stream disclosures report equality of the complete decoded retained
text. Previews align lines by number, mark differences with `≠` plus a border,
and stop at 200 lines or 20,000 characters per stream. Insertions shift later
comparisons; this is not semantic JSON matching or an insertion-aware diff.
Limited previews say so, and ordinary Raw evidence remains available. Inputs
and vendor contexts may differ, so matching text is not a service-state or
authorization verdict. Pinning/clearing issues no requests; opening another
run uses the existing single-run read. Filters preserve the baseline, while
confirmed list eviction, a matching `run_not_found`, leaving History or reload
clears it. Clear comparison returns focus to the selected run heading.

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

### Conjur access explorer and operations dashboard

The dedicated Conjur home shows the discovered CLI status and version, configured endpoint/account when available, and explicit session-verification guidance. Operators can navigate to access exploration, inventory and reviewed changes, the metadata-first regex explorer, sign-in/session checks, mutation audit via Runs, and Diagnostics.

The first-class `/dedicated/conjur/access-explorer` route retains the inventory search context while opening resource and role navigation. Inventory is limited to server-side pages of 25, 50 or 100 entries, with kind selection, search, and previous/next controls. Validated ID buttons navigate without mutation. Accessible forms, semantic labels, explicit loading/errors and responsive wrapping reuse existing components. Results are cleared on context change/visibility loss; partial or unauthorized reads never become "no access." Relationship labels distinguish resource-permitted roles, direct members and vendor-expanded memberships, without showing inferred access as effective authorization. Safe read-task prefill returns the user to ordinary task review.

### Conjur toolbox and pattern explorer

The Conjur home groups quick links to **backend-authorized** inventory, access-inspection, and approved change tasks. Each link opens the shared task configuration without executing the CLI. The Conjur 9.x pack exposes paginated, read-only list tasks for variable IDs, policies, hosts, and groups, requiring page limits of 25/50/100.

The Conjur security-audit route is now titled **Conjur pattern explorer**. It starts with a metadata-only **Variable IDs · regex** mode: Conjur resource IDs are listed and matched without ever retrieving secret values. Built-in editable presets cover credential-like names, production, service accounts, and legacy paths. A separate **Secret values · regex** mode requires explicit per-attempt acknowledgement and offers reference-URI and PEM-header patterns. Both modes use Go/RE2 expressions; matched results are variable IDs, never matched text or values. Regex criteria remain ephemeral. Search matches are not vulnerability findings. Older heuristic, contains and exact scan inputs remain accepted via the existing API for compatibility.

The Conjur **Tools** tab contains approved inventory tasks and migration playbooks/templates. General Command Builder and Diagnostics destinations remain in workspace navigation; Audit retains its contextual run-history link and an unavailable CLI retains its Diagnostics remediation.

### Dedicated Conjur action forms

Conjur secret, access, inspection, inventory and migration shortcuts stay at
`/dedicated/conjur`. The **Conjur action** dropdown exposes the currently
backend-authorized Conjur catalog without sending the operator to Command
Builder. Grant/Revoke opens the existing guided permission manager; creation
keeps the multi-step create form. Access Explorer shortcuts return to that
manager and carry a selected variable when available. Create's **Manage access**
also carries the created variable. Other actions use a dedicated form sharing
the generic typed controls and run API, not a second executor.

Variable, policy, resource, role and privilege selectors use bounded approved
inventory and enum metadata; LDAP mappings offer multi-selection of Conjur
roles. Dropdown values are presentation-only. Inventory failure offers retry
and clears stale options; manual entry remains explicit for IDs outside the
first 500 visible IDs per kind, new LDAP names, service IDs and issuer IDs
without reviewed inventory commands. CLI authorization remains authoritative.

Manual ID entry receives keyboard focus when selected. A saved role remains
visible as **not currently listed** when inventory is unavailable or changes;
the browser must never display a default while submitting a different role.
Choosing another variable clears the prior grantee and approval. Permission
tables have a labeled, keyboard-focusable horizontal scroll region so Revoke
remains reachable in narrow windows.

Edits invalidate prior approvals. Mutations display the exact approved argv,
non-secret policy payload, target, effect, scope and vendor account/endpoint;
destructive actions require the backend's exact typed confirmation plus explicit
consent. Approvals remain expiring and one-use. Secret values stay write-only
and clear when a run request is submitted. Busy controls, navigation guards,
terminal-evidence checks and unconfirmed-outcome guidance prevent automatic
replay. A successful generic action reports CLI completion, not an inferred
service-state guarantee. Changing the discovered CLI or vendor target resets
the forms, including when the operator returns from a terminal window.


## Terraform dedicated workspace (native Windows qualification pending)

When Terraform is loaded, Built-in CLIs includes a dedicated Terraform workspace with Overview, Projects, Resources, State management, Configuration, Plans and History navigation. The approved project and local state lists come from a backend-only root allowlist; selecting another project clears the state, search filters, selected resource and any prior inventory. Resource tables, selectors and search show only addresses, types, modules and managed/data classification from bounded state-v4 metadata. Use native labelled select controls and a horizontally scrollable table for narrow viewports. No selection mutates state. Local state removal is a separate guarded operation with a CLI dry run, expiring one-use approval, typed confirmation, locking, verified backups and post-execution reconciliation (ADR-040). An unverified result never triggers replay. Provider-dependent validation, plan execution and Terraform-specific mutation history remain unavailable. Native Windows path/locking/reparse-point acceptance is still required.

### Checking newly installed CLIs (native Windows acceptance pending)

**Check installation of &lt;CLI&gt;** is available for missing tools in Add a CLI and Diagnostics. It calls the existing authenticated `POST /api/v1/tools/refresh` with only reviewed pack/tool IDs and CSRF, then reloads tasks, tools and dedicated-platform readiness after successful qualification. The backend searches its process PATH and approved user fallback directories; the browser supplies no executable path, installer or command. Existing overrides, incompatible versions, ambiguous candidates and active runs cannot be replaced, and installation/refresh retain one backend mutex. Controls prevent concurrent submissions. PATH changes to the running process may still require relaunch from a fresh terminal. Native Windows PATH/fallback acceptance remains a release gate.
