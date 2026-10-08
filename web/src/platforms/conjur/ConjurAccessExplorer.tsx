import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Task } from '../../api/tasks';
import { cancelRun, createRun, decodeRunOutput, fetchRun, type RunSnapshot } from '../../api/runs';
import { fetchTools } from '../../api/tools';
import { fetchSecretAudit } from './secretAuditApi';

const PACK = 'cyberark-conjur-v9';
const TOOL = 'conjur';
const PAGE_SIZES = [25, 50, 100] as const;
const KINDS = ['all', 'variable', 'policy', 'host', 'group', 'user', 'layer', 'webservice', 'host_factory'] as const;
const PRIVILEGES = ['read', 'write', 'execute'] as const;
const READ_COMMANDS = new Set(['whoami', 'list-resources', 'resource-show', 'resource-permitted-roles',
  'role-show', 'role-members', 'role-memberships']);
const MAX_OUTPUT = 512 * 1024;
const MAX_ROLE_ENTRIES = 1000;
const MAX_PAGES = 4000;
const QUERY_DEADLINE_MS = 20000;

export function validConjurID(value: string, account?: string): boolean {
  if (value.length < 5 || value.length > 2048 || value.startsWith('-') ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false;
  const parts = /^([^:]+):([a-z_]+):(.+)$/u.exec(value);
  if (!parts || !parts[1] || !parts[3] ||
      !/^[a-zA-Z0-9_.-]+$/.test(parts[1]) ||
      !KINDS.includes(parts[2] as typeof KINDS[number])) return false;
  return account === undefined || value.startsWith(account + ':');
}

export function parseConjurIDs(output: string, max: number, account?: string): string[] {
  if (output.length > MAX_OUTPUT) throw new Error('Response exceeds the explorer output limit.');
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error('Conjur returned invalid JSON.'); }
  if (!Array.isArray(parsed) || parsed.length > max || parsed.some((item) =>
    typeof item !== 'string' || !validConjurID(item, account))) {
    throw new Error('Conjur returned an unexpected or cross-account identifier list.');
  }
  return [...new Set(parsed as string[])];
}

// Only intentionally approved metadata keys may leave the generic run output for this view.
// Never render annotations, values, credentials, policy bodies, or arbitrary vendor fields.
export function parseSafeMetadata(output: string, expectedID: string): Record<string, string> {
  if (output.length > MAX_OUTPUT) throw new Error('Response exceeds the explorer output limit.');
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error('Conjur returned invalid JSON.'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Conjur returned an unexpected resource shape.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.id !== expectedID) throw new Error('Resource identity changed in the response.');
  const result: Record<string, string> = { id: expectedID };
  for (const key of ['kind', 'owner']) {
    const value = record[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length > 2048 ||
          /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
        throw new Error('Conjur returned unsafe metadata.');
      }
      result[key] = value;
    }
  }
  return result;
}

interface ContextEvidence {
  target: string;
  identity: string;
}

type Inspection =
  | { type: 'inventory'; ids: string[]; offset: number; size: number; kind: string; search: string }
  | { type: 'resource'; id: string; metadata: Record<string, string>; roles?: string[]; privilege?: string }
  | { type: 'role'; id: string; metadata: Record<string, string>; members?: string[]; memberships?: string[] };

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

interface Props {
  tasks: Task[];
  csrfToken: string;
  onOpenTask: (commandId: string, values: Record<string, string>) => void;
  onOpenSignIn: () => void;
  onOpenDiagnostics: () => void;
}

export function ConjurAccessExplorer({ tasks, csrfToken, onOpenTask, onOpenSignIn, onOpenDiagnostics }: Props) {
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all');
  const [search, setSearch] = useState('');
  const [size, setSize] = useState<25 | 50 | 100>(25);
  const [resourceID, setResourceID] = useState('');
  const [roleID, setRoleID] = useState('');
  const [privilege, setPrivilege] = useState<(typeof PRIVILEGES)[number]>('execute');
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [inventory, setInventory] = useState<Extract<Inspection, {type: 'inventory'}> | null>(null);
  const [evidence, setEvidence] = useState<ContextEvidence | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const taskMap = new Map(tasks.filter((task) => task.packId === PACK && task.toolId === TOOL &&
    task.risk === 'read' && READ_COMMANDS.has(task.commandId)).map((task) => [task.commandId, task]));

  useEffect(() => {
    // Navigating away, hiding the tab, or changing the runtime invalidates displayed access evidence.
    const clear = () => {
      abortRef.current?.abort();
      setInspection(null);
      setInventory(null);
      setEvidence(null);
    };
    const hidden = () => { if (document.visibilityState === 'hidden') clear(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', clear);
    return () => {
      clear();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', clear);
    };
  }, []);

  async function runRead(commandId: string, values: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const task = taskMap.get(commandId);
    if (!task) throw new Error('The read-only command is not approved by the current backend.');
    if (Object.keys(values).some((key) => !task.inputs.some((input) => input.id === key))) {
      throw new Error('The current pack does not accept this query.');
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    let runID = '';
    try {
      let snapshot = await createRun(csrfToken, { packId: PACK, commandId, values });
      runID = snapshot.runId;
      const deadline = Date.now() + QUERY_DEADLINE_MS;
      while (snapshot.status === 'running') {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (Date.now() >= deadline) throw new Error('The read-only query exceeded the explorer deadline.');
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        snapshot = await fetchRun(runID, signal);
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (snapshot.packId !== PACK || snapshot.toolId !== TOOL ||
          snapshot.commandId !== commandId || snapshot.status !== 'exited' ||
          snapshot.exitCode !== 0) throw new Error('Conjur did not confirm a complete, successful read.');
      const stdout = decodeRunOutput(snapshot, 'stdout.chunk');
      if (stdout.length > MAX_OUTPUT) throw new Error('Response exceeds the explorer output limit.');
      return stdout;
    } catch (err) {
      if (runID !== '') void cancelRun(csrfToken, runID).catch(() => {});
      throw err;
    }
  }

  async function connection(signal: AbortSignal): Promise<ContextEvidence> {
    const [audit, tools] = await Promise.all([fetchSecretAudit(signal), fetchTools(signal)]);
    const tool = tools.find((candidate) => candidate.packId === PACK && candidate.toolId === TOOL);
    if (!audit.available || !audit.target || !audit.target.account || tool?.status !== 'ready') {
      throw new Error('Conjur connection or CLI is not ready. Open sign-in and Diagnostics.');
    }
    const who = await runRead('whoami', {}, signal);
    let identity: unknown;
    try { identity = JSON.parse(who); } catch { throw new Error('Session identity response is not valid JSON.'); }
    if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
      throw new Error('Session identity response is incomplete.');
    }
    const user = (identity as Record<string, unknown>).username ?? (identity as Record<string, unknown>).user;
    if (typeof user !== 'string' || user.length === 0 || user.length > 256 ||
        /[\p{Cc}\p{Cf}]/u.test(user)) {
      throw new Error('Current authenticated identity could not be verified.');
    }
    const account = (identity as Record<string, unknown>).account;
    if (account !== undefined && account !== audit.target.account) {
      throw new Error('The CLI session account differs from its configured connection.');
    }
    return {
      target: JSON.stringify([audit.target.applianceUrl.replace(/\/$/, ''), audit.target.account, tool.version]),
      identity: user,
    };
  }

  async function inspect(operation: (signal: AbortSignal, account: string) => Promise<Inspection>) {
    if (working) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setWorking(true);
    setInspection(null);
    setError('');
    try {
      const before = await connection(controller.signal);
      const account = JSON.parse(before.target)[1] as string;
      const result = await operation(controller.signal, account);
      const after = await connection(controller.signal);
      if (controller.signal.aborted || before.target !== after.target || before.identity !== after.identity) {
        throw new Error('Conjur endpoint, account, CLI or authenticated identity changed. Results discarded.');
      }
      setEvidence(after);
      setInspection(result);
      if (result.type === 'inventory') setInventory(result);
    } catch (err) {
      setInventory(null);
      setEvidence(null);
      if (!isAbort(err)) setError(err instanceof Error ? err.message : 'The Conjur query failed.');
    } finally {
      if (abortRef.current === controller) { abortRef.current = null; setWorking(false); }
    }
  }

  function browse(offset: number, nextKind = kind, nextSearch = search, nextSize = size) {
    if (offset < 0 || offset / nextSize >= MAX_PAGES || nextSearch.length > 512 ||
        /[\p{Cc}\p{Cf}]/u.test(nextSearch)) {
      setError('Invalid or out-of-bounds inventory request.');
      return;
    }
    void inspect(async (signal, account) => {
      const output = await runRead('list-resources', {
        ...(nextKind === 'all' ? {} : { kind: nextKind }),
        ...(nextSearch ? { search: nextSearch } : {}),
        limit: String(nextSize), ...(offset ? { offset } : {}),
      }, signal);
      return { type: 'inventory', ids: parseConjurIDs(output, nextSize, account),
        offset, size: nextSize, kind: nextKind, search: nextSearch };
    });
  }

  function showResource(id: string) {
    if (!validConjurID(id)) { setError('Enter a full, valid Conjur resource ID.'); return; }
    setResourceID(id);
    void inspect(async (signal, account) => {
      if (!validConjurID(id, account)) throw new Error('Resource ID is not in the configured Conjur account.');
      return { type: 'resource', id, metadata: parseSafeMetadata(
        await runRead('resource-show', { 'resource-id': id }, signal), id) };
    });
  }

  function showRole(id: string) {
    if (!validConjurID(id)) { setError('Enter a full, valid Conjur role ID.'); return; }
    setRoleID(id);
    void inspect(async (signal, account) => {
      if (!validConjurID(id, account)) throw new Error('Role ID is not in the configured Conjur account.');
      return { type: 'role', id, metadata: parseSafeMetadata(
        await runRead('role-show', { 'role-id': id }, signal), id) };
    });
  }

  function related(command: 'resource-permitted-roles' | 'role-members' | 'role-memberships') {
    const current = inspection;
    if (!current || current.type === 'inventory') return;
    void inspect(async (signal, account) => {
      const values = command === 'resource-permitted-roles'
        ? { 'resource-id': current.id, privilege }
        : { 'role-id': current.id };
      const output = await runRead(command, values, signal);
      const roles = parseConjurIDs(output, MAX_ROLE_ENTRIES, account);
      if (current.type === 'resource' && command === 'resource-permitted-roles') {
        return { ...current, roles, privilege };
      }
      if (current.type === 'role' && command === 'role-members') return { ...current, members: roles };
      if (current.type === 'role' && command === 'role-memberships') return { ...current, memberships: roles };
      throw new Error('Invalid relationship query.');
    });
  }

  function exportMetadata() {
    if (!inspection || !evidence) return;
    const data = inspection.type === 'inventory'
      ? { resourceIds: inspection.ids }
      : { resource: inspection.metadata };
    const blob = new Blob([JSON.stringify({ format: 'cliharbor-conjur-metadata-v1', ...data }, null, 2)],
      { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'conjur-metadata.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="panel conjur-access" aria-labelledby="access-heading">
      <p className="status-label">Conjur · Read-only</p>
      <h2 id="access-heading">Access &amp; Permissions Explorer</h2>
      <p>Explore visible resources and Conjur-returned relationships. A permitted-role list is not a verified effective-access decision. An empty or incomplete result does not prove denial.</p>
      <div className="platform-toolbox-grid">
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); browse(0); }} className="form-stack">
          <h3>Inventory</h3>
          <label>Resource kind
            <select value={kind} disabled={working} onChange={(event) => setKind(event.target.value as typeof kind)}>
              {KINDS.map((entry) => <option value={entry} key={entry}>{entry === 'all' ? 'All kinds' : entry}</option>)}
            </select>
          </label>
          <label>Server-side search
            <input value={search} maxLength={512} disabled={working} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <label>Page size
            <select value={size} disabled={working} onChange={(event) => setSize(Number(event.target.value) as typeof size)}>
              {PAGE_SIZES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
          </label>
          <button type="submit" disabled={working || !taskMap.has('list-resources')}>Search inventory</button>
        </form>
        <form className="form-stack" onSubmit={(event) => { event.preventDefault(); showResource(resourceID); }}>
          <h3>Resource</h3>
          <label>Full resource ID
            <input value={resourceID} maxLength={2048} disabled={working} onChange={(event) => setResourceID(event.target.value)} placeholder="account:variable:path" />
          </label>
          <button type="submit" disabled={working || !taskMap.has('resource-show')}>Inspect resource</button>
          <label>Requested privilege
            <select value={privilege} disabled={working} onChange={(event) => setPrivilege(event.target.value as typeof privilege)}>
              {PRIVILEGES.map((entry) => <option key={entry}>{entry}</option>)}
            </select>
          </label>
        </form>
        <form className="form-stack" onSubmit={(event) => { event.preventDefault(); showRole(roleID); }}>
          <h3>Role</h3>
          <label>Full role ID
            <input value={roleID} maxLength={2048} disabled={working} onChange={(event) => setRoleID(event.target.value)} placeholder="account:group:name" />
          </label>
          <button type="submit" disabled={working || !taskMap.has('role-show')}>Inspect role</button>
        </form>
      </div>
      <div className="platform-toolbox-grid">
        <button type="button" className="secondary-button" onClick={onOpenSignIn}>Conjur sign-in / session</button>
        <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>CLI diagnostics</button>
        {working && <button type="button" className="secondary-button" onClick={() => abortRef.current?.abort()}>Cancel inspection</button>}
      </div>
      <p role="status" aria-live="polite">{working ? 'Verifying Conjur context and running bounded read-only inspection…' :
        evidence ? 'Verified for the same endpoint, account, CLI version and identity before and after the query.' :
          'No current verified inspection results.'}</p>
      {error && <p role="alert">{error} Results are unavailable, not evidence of absent access.</p>}
      {inspection && evidence && <section aria-label="Explorer results" className="conjur-access-results">
        <h3>{inspection.type === 'inventory' ? 'Inventory page' : inspection.type === 'role' ? 'Role details' : 'Resource details'}</h3>
        {inspection.type === 'inventory' ? <>
          <p>Offset {inspection.offset} · {inspection.ids.length} returned · page size {inspection.size}. Only visible resource IDs are shown.</p>
          {inspection.ids.length === 0 && <p>No visible resources returned for this page. Visibility and authorization may limit results.</p>}
          <ul>{inspection.ids.map((id) => <li key={id}>
            <button type="button" disabled={working} className="secondary-button" onClick={() => showResource(id)}>{id}</button>
          </li>)}</ul>
          <div className="platform-toolbox-grid">
            <button type="button" disabled={working || inspection.offset === 0} onClick={() =>
              browse(Math.max(0, inspection.offset - inspection.size), inspection.kind as typeof kind, inspection.search, inspection.size)}>Previous page</button>
            <button type="button" disabled={working || inspection.ids.length < inspection.size ||
              inspection.offset + inspection.size >= MAX_PAGES * inspection.size} onClick={() =>
              browse(inspection.offset + inspection.size, inspection.kind as typeof kind, inspection.search, inspection.size)}>Next page</button>
          </div>
        </> : <>
          <dl>{Object.entries(inspection.metadata).map(([key, value]) =>
            <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
          <button type="button" className="secondary-button" onClick={() => void navigator.clipboard?.writeText(inspection.id)}>Copy full ID</button>
          {inspection.type === 'resource' ? <>
            <button type="button" disabled={working || !taskMap.has('resource-permitted-roles')} onClick={() => related('resource-permitted-roles')}>
              Query Conjur-permitted roles ({privilege})
            </button>
            {inspection.roles && <section aria-label="Permitted roles">
              <h4>Conjur-returned roles for “{inspection.privilege}”</h4>
              <p>These are server-reported permitted-role relationships; this does not certify an individual identity's effective access.</p>
              <ul>{inspection.roles.map((id) => <li key={id}><button type="button" disabled={working}
                onClick={() => showRole(id)}>{id}</button></li>)}</ul>
            </section>}
          </> : <>
            <button type="button" disabled={working || !taskMap.has('role-members')} onClick={() => related('role-members')}>List direct members</button>
            <button type="button" disabled={working || !taskMap.has('role-memberships')} onClick={() => related('role-memberships')}>List memberships</button>
            {inspection.members && <section aria-label="Direct members"><h4>Direct members reported by Conjur</h4>
              <ul>{inspection.members.map((id) => <li key={id}><button type="button" disabled={working} onClick={() => showRole(id)}>{id}</button></li>)}</ul>
            </section>}
            {inspection.memberships && <section aria-label="Expanded memberships"><h4>Conjur-expanded memberships</h4>
              <p>Vendor CLI expands memberships recursively. These are not necessarily direct edges; cycles and duplicates are deduplicated for display.</p>
              <ul>{inspection.memberships.map((id) => <li key={id}><button type="button" disabled={working} onClick={() => showRole(id)}>{id}</button></li>)}</ul>
            </section>}
          </>}
          {inventory && <button type="button" className="secondary-button" disabled={working}
            onClick={() => browse(inventory.offset, inventory.kind as typeof kind, inventory.search, inventory.size)}>
            Back to inventory search</button>}
          <button type="button" className="secondary-button" onClick={() => {
            onOpenTask(inspection.type === 'role' ? 'role-show' : 'resource-show',
              { [inspection.type === 'role' ? 'role-id' : 'resource-id']: inspection.id });
          }}>Open approved task</button>
        </>}
        <button type="button" className="secondary-button" onClick={exportMetadata}>Export approved metadata only</button>
      </section>}
    </section>
  );
}
