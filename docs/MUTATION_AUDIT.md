# Durable mutation audit and recovery

CLIHarbor keeps normal execution history in bounded process memory. **Approved mutation audit evidence is separate**: it is appended to the current user's local journal at `<user config>/CLIHarbor/audit/mutation-trail.jsonl`, including across CLIHarbor restarts.

## Recording and boundaries

For every accepted `change` or `destructive` task, the backend records an `approved` event **synchronously before launching the vendor process**, after consuming an exact-plan, single-use approval. At completion it appends a distinct `completed` event with the execution status and exit code if available. An `approved` entry without a `completed` entry means **outcome unknown**, not success or reversal. A completion with nonzero exit code, cancellation or timeout does **not** establish that the remote service was unchanged. Always reconcile the remote state before retrying.

Entries hold a run ID, timestamp, pack/command IDs, risk, declared target label/identifier, approved effect/scope, and terminal outcome. The journal **does not store** stdin, process argv, stdout/stderr, credential values, session/auth tokens, policy document bodies or executable paths. Resource identifiers, effect descriptions and target metadata **can still be sensitive**. Protect the user's configuration folder and collected audit records accordingly.

Events are one-per-line JSON with chained SHA-256 checksums, sequential numbering, strict read-time verification and fsync after each append. This detects accidental corruption and unsophisticated edits, **not tampering by an attacker who can rewrite the entire file and recompute checksums**. It is not a signed or centralized compliance log. The journal has a 16 MiB/25,000-entry hard cap and no automatic retention rotation. Reaching capacity or failing to write/sync makes subsequent mutations unavailable rather than permitting unaudited writes. Read commands remain available.

A sibling `.lock` file prevents concurrent writers. After a crash, the lock may remain: investigate the prior process and operation status before removing the lock **only after verifying no CLIHarbor process still owns the journal**. A corrupted or truncated journal must not be truncated or discarded to resume work; preserve it for investigation and restore a verified copy through the organization's evidence retention procedure.

## Browser review

**Runs → Mutation audit trail → View audit trail** calls the authenticated, loopback-only `GET /api/v1/audit` API and shows up to 100 latest journal events. The interface never loads the journal into local storage. The API cannot mutate records or run a rollback. The records remain available after restart even when detailed runs have been evicted.

## Undo and recovery

**No automatic undo is enabled yet.** Undo requires (1) verified authoritative pre-change state, (2) a reviewed deterministic inverse for the exact command/version, (3) drift/concurrency checks at replay time, (4) new human approval, and (5) separate audit records for attempted reversal and its result. A prior command's logical opposite is not automatically a safe inverse: `secret deny` is not guaranteed to undo `secret permit`, delete/recreate may lose metadata and history, and cancellation or a failed run can still leave remote side effects. Secret values should never be persisted simply to make undo possible.

For now: inspect the audit record, verify the actual remote object state using an approved read/query or external authoritative logs, and perform a new explicitly approved recovery action through the supported vendor workflow. Do not assume `Undo` is available for any existing Conjur command.

## Coverage

This journal covers **CLIHarbor-approved pack mutations** only. It does not observe changes made outside CLIHarbor, vendor login/configuration, portable tool installation or the read-only secret audit. Extending Conjur to all command families is a separate per-command qualification effort with secret-output, environment and mutation-safety review.
