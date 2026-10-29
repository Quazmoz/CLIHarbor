// Shared plumbing for guided Conjur workflows: approved-run completion, plan
// validation and the read-only inventory that feeds role/policy dropdowns.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../../api/tasks';
import {
  cancelRun, createRun, decodeRunOutput, fetchRun, subscribeRunEvents,
  type RunPreview, type RunSnapshot,
} from '../../api/runs';
import { parseConjurIDs, parseConjurObject } from './ConjurAccessExplorer';

export const PACK = 'cyberark-conjur-v9';
export const TOOL = 'conjur';
export const MAX_RUN_MS = 60_000;
const MAX_RECONCILE_MS = 10_000;
// The reviewed secret-permit / secret-deny privilege enum.
export const PRIVILEGES = ['read, execute', 'read', 'execute', 'update', 'read, execute, update'];
export const ROLE_KINDS = ['policy', 'group', 'host', 'layer', 'user'] as const;
export const GRANTEE_KINDS = ['group', 'host', 'layer', 'user'] as const;
export type InventoryKind = typeof ROLE_KINDS[number] | 'variable' | 'webservice' | 'host_factory';
export type Inventory = Partial<Record<InventoryKind, string[]>>;
const KIND_LABELS: Record<InventoryKind, string> = {
  policy: 'Policies', group: 'Groups', host: 'Hosts', layer: 'Layers', user: 'Users', variable: 'Variables',
  webservice: 'Web services', host_factory: 'Host factories',
};
const PAGE = 100;
// ponytail: first 500 IDs per kind in Conjur's order; add list-resources --search typeahead if tenants outgrow it.
const MAX_PAGES = 5;

export function supportedTask(tasks: Task[], commandId: string, risk: Task['risk'], inputs: Record<string, string>): boolean {
  const task = tasks.find((candidate) => candidate.packId === PACK && candidate.toolId === TOOL &&
    candidate.commandId === commandId && candidate.risk === risk && candidate.requiresAuth);
  if (!task || task.inputs.length !== Object.keys(inputs).length) return false;
  return task.inputs.every((input) => inputs[input.id] === input.type &&
    (input.type === 'boolean' || input.required === true));
}

export const PERMISSION_INPUTS = {
  'policy-branch': 'string', 'variable-id': 'string', 'role-kind': 'enum', 'role-id': 'string',
  privileges: 'enum', 'dry-run': 'boolean',
};

export function successful(snapshot: RunSnapshot, command: string): boolean {
  return snapshot.packId === PACK && snapshot.toolId === TOOL && snapshot.commandId === command &&
    snapshot.status === 'exited' && snapshot.exitCode === 0;
}

// Every mutation must have authoritative terminal evidence before a dependent
// mutation may start. A dropped event stream is reconciled once, never replayed.
export async function completedRun(snapshot: RunSnapshot, signal?: AbortSignal): Promise<RunSnapshot> {
  signal?.throwIfAborted();
  if (snapshot.status !== 'running') return snapshot;
  return new Promise((resolve, reject) => {
    let done = false;
    let close = () => {};
    let reconciling = false;
    let controller: AbortController | undefined;
    let reconcileTimeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RunSnapshot | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (reconcileTimeout !== undefined) clearTimeout(reconcileTimeout);
      signal?.removeEventListener('abort', aborted);
      controller?.abort();
      close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const aborted = () => finish(new DOMException('Aborted', 'AbortError'));
    const reconcile = () => {
      // SSE completion/error and the deadline can race. Fetch the retained
      // snapshot at most once, with an independent network deadline.
      if (done || reconciling) return;
      reconciling = true;
      controller = new AbortController();
      reconcileTimeout = setTimeout(() =>
        finish(new Error('Run outcome is unknown. Check Runs before retrying.')), MAX_RECONCILE_MS);
      void fetchRun(snapshot.runId, controller.signal).then((current) => {
        if (current.status === 'running') finish(new Error('Run completion could not be verified. Check Runs before retrying.'));
        else finish(current);
      }).catch(() => finish(new Error('Run outcome is unknown. Check Runs before retrying.')));
    };
    const timeout = setTimeout(reconcile, MAX_RUN_MS);
    signal?.addEventListener('abort', aborted, { once: true });
    close = subscribeRunEvents(snapshot.runId, () => {}, () => {
      // Stream completion is only a signal: its payload omits retained stdout.
      // Fetch the authoritative terminal snapshot before any dependent mutation.
      reconcile();
    }, reconcile, undefined, snapshot.events?.at(-1)?.sequence ?? 0);
    if (done) close();
  });
}

/** Runs one approved read-only command to completion and returns its stdout. */
export async function runRead(csrfToken: string, commandId: string, values: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  let accepted: RunSnapshot | undefined;
  try {
    accepted = await createRun(csrfToken, { packId: PACK, commandId, values }, signal);
    const snapshot = await completedRun(accepted, signal);
    if (!successful(snapshot, commandId)) throw new Error('Conjur could not complete the read-only query. Check Runs for details.');
    if (snapshot.structured?.status === 'invalid') throw new Error('Conjur read output did not pass the reviewed output schema.');
    return decodeRunOutput(snapshot, 'stdout.chunk');
  } catch (error) {
    // Cancel only a known read; mutation completion remains independent of navigation.
    if (signal?.aborted && accepted?.status === 'running') void cancelRun(csrfToken, accepted.runId).catch(() => {});
    throw error;
  }
}

// Carry only the generated run ID to the UI, never untrusted vendor output.
export class ExistenceCheckFailure extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super('Conjur could not verify the variable. The read-only existence check failed; no changes were sent. Inspect Runs for the underlying CLI error.');
    this.runId = /^[A-Za-z0-9_-]{1,128}$/u.test(runId) ? runId : '';
  }
}

// conjur-api-go QueryEscapes resource IDs into the URL path, so a space reaches
// Conjur as '+' and `resource show`/`exists` report 404. `list --search` sends
// the ID as a query parameter, where spaces survive.
export const needsSearchLookup = (id: string) => id.includes(' ');

/**
 * Exact variable lookup through the approved list task. Returns the matching ID,
 * or its record as JSON when inspecting; null when a complete page lacks it.
 */
export async function findVariable(csrfToken: string, account: string, id: string, inspect: boolean, signal?: AbortSignal): Promise<string | null> {
  if (id.length > 512) throw new Error('Conjur variable IDs with spaces longer than 512 characters cannot be looked up.');
  const fullID = account + ':variable:' + id;
  const output = await runRead(csrfToken, 'list-resources',
    { kind: 'variable', search: id, limit: String(PAGE), ...(inspect ? { inspect: true } : {}) }, signal);
  let entries: unknown[];
  if (inspect) {
    // Scan the whole response for duplicate keys before trusting any record.
    const records = parseConjurObject('{"r":' + output + '}').r;
    if (!Array.isArray(records)) throw new Error('Conjur returned an unexpected resource list.');
    entries = records;
  } else {
    entries = parseConjurIDs(output, PAGE, account);
  }
  const match = entries.find((entry) => inspect
    ? typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === fullID
    : entry === fullID);
  if (match !== undefined) return inspect ? JSON.stringify(match) : fullID;
  if (entries.length < PAGE) return null;
  throw new Error('Conjur search returned too many matches to confirm this variable.');
}

/** Mutation preflights require the reviewed parser's evidence, never raw JSON. */
export async function variableExists(csrfToken: string, fullID: string, account: string): Promise<boolean> {
  // Search sees only visible variables; resource exists also counts hidden ones.
  if (needsSearchLookup(fullID)) return await findVariable(csrfToken, account, fullID, false) !== null;
  const snapshot = await completedRun(await createRun(csrfToken, {
    packId: PACK, commandId: 'resource-exists',
    values: { 'resource-id': account + ':variable:' + fullID },
  }));
  if (!successful(snapshot, 'resource-exists')) throw new ExistenceCheckFailure(snapshot.runId);
  const field = snapshot.structured?.status === 'available'
    ? snapshot.structured.fields?.find((field) => field.key === 'exists' && field.present && field.type === 'boolean')
    : undefined;
  if (field && (field.value === 'true' || field.value === 'false')) return field.value === 'true';
  throw new Error('Conjur returned an unrecognized existence result.');
}

/** Local IDs (account and kind stripped) of visible resources of one kind. */
export async function listIDs(csrfToken: string, account: string, kind: InventoryKind, signal?: AbortSignal): Promise<string[]> {
  const prefix = account + ':' + kind + ':';
  const ids: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const entries = parseConjurIDs(await runRead(csrfToken, 'list-resources',
      { kind, limit: String(PAGE), ...(page ? { offset: page * PAGE } : {}) }, signal), PAGE, account);
    ids.push(...entries.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)));
    if (entries.length < PAGE) break;
  }
  return ids;
}

/**
 * Lazily loads dropdown inventory. A failure only disables dropdowns; it is
 * never evidence about what exists. Kinds load sequentially because the run
 * manager caps concurrent CLI processes.
 */
export function useConjurInventory(csrfToken: string, account: string | undefined, tasks: Task[],
  kinds: readonly InventoryKind[]) {
  const available = Boolean(account) && tasks.some((task) => task.packId === PACK && task.toolId === TOOL &&
    task.commandId === 'list-resources' && task.risk === 'read');
  const scope = useMemo(() => ({ available, account, csrfToken, kinds }), [available, account, csrfToken, kinds]);
  const [result, setResult] = useState<{
    scope: typeof scope; inventory: Inventory | null; state: 'idle' | 'loading' | 'failed';
  } | null>(null);
  const loading = useRef<AbortController | null>(null);
  useEffect(() => () => {
    loading.current?.abort();
    loading.current = null;
  }, [scope]);

  const load = useCallback(async () => {
    if (!scope.available || !scope.account || loading.current) return;
    const controller = new AbortController();
    loading.current = controller;
    setResult({ scope, inventory: null, state: 'loading' });
    try {
      const loaded: Inventory = {};
      for (const kind of scope.kinds) {
        controller.signal.throwIfAborted();
        loaded[kind] = await listIDs(scope.csrfToken, scope.account, kind, controller.signal);
      }
      if (!controller.signal.aborted) setResult({ scope, inventory: loaded, state: 'idle' });
    } catch {
      if (!controller.signal.aborted) setResult({ scope, inventory: null, state: 'failed' });
    } finally {
      if (loading.current === controller) loading.current = null;
    }
  }, [scope]);
  return { inventory: result?.scope === scope ? result.inventory : null,
    state: result?.scope === scope ? result.state : 'idle' as const, load };
}

export function InventoryStatus({ state, disabled, onRetry }: {
  state: 'idle' | 'loading' | 'failed'; disabled: boolean; onRetry: () => void;
}) {
  if (state === 'loading') return (
    <p className="conjur-inventory-status" role="status" aria-live="polite">
      <span className="conjur-inventory-spinner" aria-hidden="true" />
      Loading dropdown options from Conjur…
    </p>
  );
  if (state !== 'failed') return null;
  return (
    <p role="alert">Conjur dropdown options could not be listed. Retry or enter an ID manually.{' '}
      <button type="button" className="secondary-button" disabled={disabled} onClick={onRetry}>Retry</button>
    </p>
  );
}

/** Grouped options whose values are "kind:id", so one select carries a typed Conjur role. */
export function RoleOptions({ inventory, kinds, selected = '' }: { inventory: Inventory | null; kinds: readonly InventoryKind[]; selected?: string }) {
  return <>{selected && !kinds.some((kind) => inventory?.[kind]?.some((id) => kind + ':' + id === selected)) &&
    <option value={selected}>{selected} (not currently listed)</option>}
    {inventory && kinds.map((kind) => (inventory[kind]?.length ?? 0) > 0 && (
    <optgroup key={kind} label={KIND_LABELS[kind]}>
      {inventory[kind]!.map((id) => <option key={id} value={kind + ':' + id}>{id}</option>)}
    </optgroup>
  ))}</>;
}

export function splitRole(role: string): [string, string] {
  const at = role.indexOf(':');
  return [role.slice(0, at), role.slice(at + 1)];
}

/** Every step is an explicitly approved change bound to the displayed account and endpoint. */
export function matchingPlans(steps: RunPreview[], account: string | undefined, endpoint: string | undefined): boolean {
  const fields = steps[0]?.context?.fields;
  return steps.length > 0 && steps.every((step) => step.risk === 'change' && step.approval?.mode === 'explicit' &&
      step.context !== undefined && JSON.stringify(step.context.fields) === JSON.stringify(fields)) &&
    matchingContext(steps[0], account, endpoint);
}

export function matchingContext(plan: RunPreview | undefined, account: string | undefined, endpoint: string | undefined): boolean {
  return Boolean(account && endpoint && plan?.context?.fields.find((field) => field.label === 'Account')?.value === account &&
    plan.context.fields.find((field) => field.label === 'Endpoint')?.value.replace(/\/$/u, '') === endpoint.replace(/\/$/u, ''));
}

/** Later approvals must remain valid while the first run completes. */
export function approvalsFresh(steps: RunPreview[]): boolean {
  return Math.min(...steps.map((step) => Date.parse(step.approval!.expiresAt))) > Date.now() + MAX_RUN_MS + 5_000;
}

export function safeMessage(error: unknown): string {
  // Never expose untrusted vendor output or request details in guided flows.
  if (error instanceof Error && (error.message.startsWith('Run ') || error.message.startsWith('Conjur '))) return error.message;
  return 'The operation was not confirmed. Review Runs and the Conjur variable before trying again.';
}
