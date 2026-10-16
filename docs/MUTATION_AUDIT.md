# Durable mutation audit and recovery

CLIHarbor keeps normal execution history in bounded process memory. **Approved mutation audit evidence is separate**: it is appended to the current user's local journal at `<user config>/CLIHarbor/audit/mutation-trail.jsonl`, including across CLIHarbor restarts.

## Recording and boundaries

For every accepted `change` or `destructive` task, the backend records an `approved` event **synchronously before launching the vendor process**, after consuming an exact-plan, single-use approval. At completion it appends a distinct `completed` event with the execution status and exit code if available. An `approved` entry without a `completed` entry means **outcome unknown**, not success or reversal. A completion with nonzero exit code, cancellation or timeout does **not** establish that the remote service was unchanged. Always reconcile the remote state before retrying.

Entries hold a run ID, timestamp, pack/command IDs, risk, declared target label/identifier, approved effect/scope, and terminal outcome. The journal **does not store** stdin, process argv, stdout/stderr, credential values, session/auth tokens, policy document bodies or executable paths. Resource identifiers, effect descriptions and target metadata **can still be sensitive**. Protect the user's configuration folder and collected audit records accordingly.

Events are one-per-line JSON with chained SHA-256 checksums, sequential numbering, strict read-time verification and fsync after each append. This detects accidental corruption and unsophisticated edits, **not tampering by an attacker who can rewrite the entire file and recompute checksums**. It is not a signed or centralized compliance log. The journal has a 16 MiB/25,000-entry hard cap and no automatic retention rotation. Reaching capacity or failing to write/sync makes subsequent mutations unavailable rather than permitting unaudited writes. If the journal cannot open or validate on startup, CLIHarbor refuses to launch until evidence is preserved and the storage issue is resolved. A journal failure during an active session blocks subsequent mutations; in-memory read runs can continue.

A permanent private sibling `.lock` file coordinates **non-blocking OS locks** (Windows byte-range locking, Unix `flock`). The kernel releases the lock on normal close **and on process death**; the small version marker remains on disk to prevent unlink/recreate races. A second active instance is refused. **Never delete or automatically clear this v2 lock file.** A legacy empty `.lock` created by older CLIHarbor versions has no OS lock, so it cannot be distinguished safely from a currently active older instance. The new runtime fails closed on this legacy file. To migrate once, first verify no prior CLIHarbor instance or active mutation remains, preserve the empty legacy file by renaming it, then restart; do not rename or delete it while an old instance is running. The new runtime creates its own OS-managed v2 lock file. Neither restart nor recovery clears the journal. A corrupted or truncated journal must not be truncated or discarded to resume work. On Windows, `tools/dev-restart.ps1` also checks for the empty legacy sentinel *before* rebuilding or stopping a helper-owned development instance; it refuses the restart with migration guidance and never renames the evidence.

## Incident handling: journal fails verification

Startup stops with `audit trail integrity check failed`. CLIHarbor never repairs, truncates or skips a bad entry, and normal startup never bypasses verification. Recovery is a deliberate operator procedure:

1. Stop every CLIHarbor instance. Treat the failure as possible tampering until shown otherwise and open an incident according to company policy.
2. Copy `mutation-trail.jsonl` to the organization's evidence store. Run `cliharbor audit verify` to record the exact failure (it is read-only).
3. Either **restore** a previously retained copy: run `cliharbor audit verify --path <absolute path to copy>` first and restore it only if it verifies, or **quarantine**: run `cliharbor audit quarantine --confirm`.
4. Quarantine holds the audit lock (it refuses while any instance runs), refuses a journal that verifies or cannot be read (for example a permissions problem), then renames the file **unchanged** to `mutation-trail.quarantined-<UTC time>.jsonl` beside it, under a name reserved exclusively so nothing is overwritten. It prints the preserved path and SHA-256; record both in the incident.
5. The next start creates a new chain at sequence 1. The new chain does **not** reference the quarantined one; the incident record is the link. Reconcile the remote state of every `approved` entry without a matching `completed` entry in the quarantined file before retrying anything.

Limits: the hash chain detects corruption and casual edits, not a local attacker who rewrites the whole file. A **missing** journal is indistinguishable from first use and silently starts a new chain; protecting the audit folder is the operating system account's job. Anchoring the chain head outside the folder (for example in a central log) is an open security decision, not implemented.

## Browser review

**Runs → Mutation audit trail → View audit trail** calls the authenticated, loopback-only `GET /api/v1/audit` API and shows up to 100 latest journal events. The interface never loads the journal into local storage. The API cannot mutate records or run a rollback. The records remain available after restart even when detailed runs have been evicted.

## Undo and recovery

**No automatic undo is enabled yet.** Undo requires (1) verified authoritative pre-change state, (2) a reviewed deterministic inverse for the exact command/version, (3) drift/concurrency checks at replay time, (4) new human approval, and (5) separate audit records for attempted reversal and its result. A prior command's logical opposite is not automatically a safe inverse: `secret deny` is not guaranteed to undo `secret permit`, delete/recreate may lose metadata and history, and cancellation or a failed run can still leave remote side effects. Secret values should never be persisted simply to make undo possible.

For now: inspect the audit record, verify the actual remote object state using an approved read/query or external authoritative logs, and perform a new explicitly approved recovery action through the supported vendor workflow. Do not assume `Undo` is available for any existing Conjur command.

## Coverage

This journal covers **CLIHarbor-approved pack mutations** only. It does not observe changes made outside CLIHarbor, vendor login/configuration, portable tool installation or the read-only secret audit. Extending Conjur to all command families is a separate per-command qualification effort with secret-output, environment and mutation-safety review.
