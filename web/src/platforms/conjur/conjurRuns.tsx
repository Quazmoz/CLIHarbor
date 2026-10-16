// Shared plumbing for guided Conjur workflows: approved-run completion, plan
// validation and the read-only inventory that feeds role/policy dropdowns.
import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../api/tasks';
import {
  createRun, decodeRunOutput, fetchRun, subscribeRunEvents,
  type RunPreview, type RunSnapshot,
} from '../../api/runs';
import { parseConjurIDs } from './ConjurAccessExplorer';

export const PACK = 'cyberark-conjur-v9';
export const TOOL = 'conjur';
export const MAX_RUN_MS = 60_000;
const MAX_RECONCILE_MS = 10_000;
// The reviewed secret-permit / secret-deny privilege enum.
export const PRIVILEGES = ['read, execute', 'read', 'execute', 'update', 'read, execute, update'];
export const ROLE_KINDS = ['policy', 'group', 'host', 'layer', 'user'] as const;
export const GRANTEE_KINDS = ['group', 'host', 'layer', 'user'] as const;
export type InventoryKind = typeof ROLE_KINDS[number] | 'variable';
export type Inventory = Partial<Record<InventoryKind, string[]>>;
const KIND_LABELS: Record<InventoryKind, string> = {
  policy: 'Policies', group: 'Groups', host: 'Hosts', layer: 'Layers', user: 'Users', variable: 'Variables',
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
export async function completedRun(snapshot: RunSnapshot): Promise<RunSnapshot> {
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
      controller?.abort();
      close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
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
    close = subscribeRunEvents(snapshot.runId, () => {}, () => {
      // Stream completion is only a signal: its payload omits retained stdout.
      // Fetch the authoritative terminal snapshot before any dependent mutation.
      reconcile();
    }, reconcile, undefined, snapshot.events?.at(-1)?.sequence ?? 0);
    if (done) close();
  });
}

/** Runs one approved read-only command to completion and returns its stdout. */
export async function runRead(csrfToken: string, commandId: string, values: Record<string, unknown>): Promise<string> {
  const snapshot = await completedRun(await createRun(csrfToken, { packId: PACK, commandId, values }));
  if (!successful(snapshot, commandId)) throw new Error('Conjur could not complete the read-only query. Check Runs for details.');
  return decodeRunOutput(snapshot, 'stdout.chunk');
}

/** Local IDs (account and kind stripped) of visible resources of one kind. */
export async function listIDs(csrfToken: string, account: string, kind: InventoryKind): Promise<string[]> {
  const prefix = account + ':' + kind + ':';
  const ids: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const entries = parseConjurIDs(await runRead(csrfToken, 'list-resources',
      { kind, limit: String(PAGE), ...(page ? { offset: page * PAGE } : {}) }), PAGE, account);
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
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const loading = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const available = Boolean(account) && tasks.some((task) => task.packId === PACK && task.toolId === TOOL &&
    task.commandId === 'list-resources' && task.risk === 'read');

  async function load() {
    if (!available || !account || loading.current) return;
    loading.current = true;
    setState('loading');
    try {
      const loaded: Inventory = {};
      for (const kind of kinds) loaded[kind] = await listIDs(csrfToken, account, kind);
      if (alive.current) { setInventory(loaded); setState('idle'); }
    } catch {
      if (alive.current) setState('failed');
    } finally {
      loading.current = false;
    }
  }
  return { inventory, state, load };
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
    <p role="alert">Conjur policies and roles could not be listed, so the dropdowns are unavailable.{' '}
      <button type="button" className="secondary-button" disabled={disabled} onClick={onRetry}>Retry</button>
    </p>
  );
}

/** Grouped options whose values are "kind:id", so one select carries a typed Conjur role. */
export function RoleOptions({ inventory, kinds }: { inventory: Inventory | null; kinds: readonly InventoryKind[] }) {
  return <>{inventory && kinds.map((kind) => (inventory[kind]?.length ?? 0) > 0 && (
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
    fields?.find((field) => field.label === 'Account')?.value === account &&
    fields?.find((field) => field.label === 'Endpoint')?.value.replace(/\/$/u, '') === endpoint?.replace(/\/$/u, '');
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
