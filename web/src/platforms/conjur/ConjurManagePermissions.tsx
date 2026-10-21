import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Task } from '../../api/tasks';
import { createRun, previewRun, type RunPreview } from '../../api/runs';
import { validConjurID } from './ConjurAccessExplorer';
import {
  GRANTEE_KINDS, InventoryStatus, PACK, PERMISSION_INPUTS, PRIVILEGES, RoleOptions,
  approvalsFresh, completedRun, matchingPlans, runRead, safeMessage, successful,
  supportedTask, useConjurInventory,
} from './conjurRuns';

const INVENTORY_KINDS = ['variable', ...GRANTEE_KINDS] as const;
const MAX_PERMISSIONS = 1000;

export interface Permission { role: string; privilege: string; policy: string }
export interface VariableAccess { owner: string; policy: string; permissions: Permission[] }

const localID = (fullID: string) => fullID.split(':').slice(2).join(':');
const kindOf = (fullID: string) => fullID.split(':')[1];

/** Policy YAML resource IDs must be relative to the branch being updated. */
export function policyRelativeVariableID(variableID: string, branch: string): string | null {
  if (branch === 'root') return variableID || null;
  const prefix = branch + '/';
  return variableID.startsWith(prefix) && variableID.length > prefix.length
    ? variableID.slice(prefix.length) : null;
}

/** Parses `conjur resource show` JSON, keeping only validated same-account ownership and grants. */
export function parseVariableAccess(output: string, account: string): VariableAccess {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error('Conjur returned an invalid resource description.'); }
  const record = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  const id = (value: unknown, kind?: string): value is string =>
    typeof value === 'string' && validConjurID(value, account) && (kind === undefined || kindOf(value) === kind);
  const permissions = record.permissions;
  if (!id(record.owner) || !id(record.policy, 'policy') || !Array.isArray(permissions) ||
      permissions.length > MAX_PERMISSIONS || permissions.some((entry: unknown) => {
        const grant = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
        return !id(grant.role) || !id(grant.policy, 'policy') ||
          typeof grant.privilege !== 'string' || !/^[a-z_]{1,64}$/u.test(grant.privilege);
      })) {
    throw new Error('Conjur returned an unexpected resource description.');
  }
  return {
    owner: record.owner, policy: record.policy,
    permissions: (permissions as Permission[]).map(({ role, privilege, policy }) => ({ role, privilege, policy })),
  };
}

interface Props {
  tasks: Task[];
  csrfToken: string;
  account?: string;
  endpoint?: string;
  contextKey: string;
}

interface Change {
  label: string;
  commandId: 'secret-permit' | 'secret-deny';
  values: Record<string, unknown>;
  variable: string;
  contextKey: string;
  preview: RunPreview;
}

export function ConjurManagePermissions({ tasks, csrfToken, account, endpoint, contextKey }: Props) {
  const listID = useId();
  const [open, setOpen] = useState(false);
  const [variable, setVariable] = useState('');
  const [access, setAccess] = useState<VariableAccess | null>(null);
  const [shown, setShown] = useState('');
  const [grantee, setGrantee] = useState('');
  const [privileges, setPrivileges] = useState(PRIVILEGES[0]);
  const [change, setChange] = useState<Change | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const { inventory, state: inventoryState, load: loadInventory } =
    useConjurInventory(csrfToken, account, tasks, INVENTORY_KINDS);

  const canPermit = supportedTask(tasks, 'secret-permit', 'change', PERMISSION_INPUTS);
  const canDeny = supportedTask(tasks, 'secret-deny', 'change', PERMISSION_INPUTS);
  const allowed = Boolean(account && endpoint) && (canPermit || canDeny) &&
    supportedTask(tasks, 'resource-show', 'read', { 'resource-id': 'string' });
  const variableValid = Boolean(account) && validConjurID(account + ':variable:' + variable, account);
  const pending = change !== null && change.contextKey === contextKey && change.variable === shown ? change : null;

  async function work(step: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await step();
    } catch (caught) {
      if (alive.current) setError(safeMessage(caught));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function readAccess(id: string) {
    const loaded = parseVariableAccess(await runRead(csrfToken, 'resource-show', { 'resource-id': account + ':variable:' + id }), account!);
    if (alive.current) { setAccess(loaded); setShown(id); }
  }

  function show(event: FormEvent) {
    event.preventDefault();
    if (!allowed || !variableValid) return;
    setAccess(null);
    setChange(null);
    setOutcome('');
    void work(() => readAccess(variable));
  }

  // Grant in the variable's policy, revoke in the granting policy.
  // Policy YAML requires a branch-relative variable; role IDs may be absolute.
  function review(commandId: Change['commandId'], label: string, branch: string, role: string, privilege: string) {
    const relativeVariable = policyRelativeVariableID(shown, branch);
    if (relativeVariable === null) {
      setError('This variable is outside the granting policy branch. Use the reviewed task workflow to resolve it.');
      return;
    }
    const values = {
      'policy-branch': branch, 'variable-id': relativeVariable, 'role-kind': kindOf(role), 'role-id': '/' + localID(role),
      privileges: privilege, 'dry-run': false,
    };
    setApproved(false);
    setChange(null);
    setOutcome('');
    void work(async () => {
      const preview = await previewRun(csrfToken, { packId: PACK, commandId, values });
      if (!matchingPlans([preview], account, endpoint) || preview.impact?.target !== relativeVariable || !preview.stdin) {
        throw new Error('Conjur did not return a matching approved plan.');
      }
      if (alive.current) setChange({ label, commandId, values, variable: shown, contextKey, preview });
    });
  }

  function apply() {
    if (!pending || !approved) return;
    if (!approvalsFresh([pending.preview])) {
      setError('The reviewed approval is too close to expiry. Review the change again.');
      setChange(null);
      return;
    }
    setApproved(false);
    setChange(null);
    void work(async () => {
      const result = await completedRun(await createRun(csrfToken, {
        packId: PACK, commandId: pending.commandId, values: pending.values,
        approval: { id: pending.preview.approval!.id },
      }));
      if (!successful(result, pending.commandId)) {
        throw new Error('Conjur did not confirm the permission change. Check Runs before trying again.');
      }
      try {
        await readAccess(pending.variable);
      } catch {
        // Don't leave the pre-change table on screen as if it were current.
        if (alive.current) {
          setAccess(null);
          setOutcome(pending.label + ' applied, but current permissions could not be reloaded. Check Runs, then show access again.');
        }
        return;
      }
      if (alive.current) setOutcome(pending.label + ' applied. Current permissions were reloaded from Conjur.');
    });
  }

  return (
    <section className="conjur-create-secret" aria-label="Manage Conjur secret permissions">
      <button type="button" className="conjur-action conjur-action--primary" disabled={!allowed || busy}
        aria-expanded={open} onClick={() => {
          if (busy) return;
          if (!open && !inventory) void loadInventory();
          setOpen(!open);
        }}>
        <span className="conjur-action-text">
          <strong>Manage permissions</strong>
          <span>{allowed
            ? 'See who can access a secret, then grant or revoke privileges from dropdowns of visible roles.'
            : 'Unavailable until Conjur and the approved commands are ready.'}</span>
        </span>
        <span className="task-risk-badge task-risk-badge--change">Approval required</span>
      </button>
      {open && (
        <div className="conjur-create-form conjur-permissions-form">
          <InventoryStatus state={inventoryState} disabled={busy} onRetry={() => void loadInventory()} />
          <form onSubmit={show} autoComplete="off">
            <label>Secret variable ID
              <input required maxLength={2048} value={variable} disabled={busy} spellCheck={false} list={listID}
                placeholder="apps/db/password" aria-busy={inventoryState === 'loading'}
                onChange={(event) => { setVariable(event.target.value); setError(''); }} />
            </label>
            <datalist id={listID}>
              {inventory?.variable?.map((id) => <option key={id} value={id} />)}
            </datalist>
            <button type="submit" disabled={!variableValid || busy}>Show current permissions</button>
          </form>

          {access && (
            <section className="conjur-permissions-current" aria-label="Current permissions">
              <h4>Current permissions on <code>{shown}</code></h4>
              <p><strong>Owner:</strong> <code>{localID(access.owner)}</code> ({kindOf(access.owner)}) holds every privilege.
                {' '}<strong>Defined in policy:</strong> <code>{localID(access.policy)}</code></p>
              {access.permissions.length === 0 ? <p>No explicit grants. Only the owner and its members have access.</p> : (
                <table>
                  <thead><tr><th scope="col">Role</th><th scope="col">Privilege</th><th scope="col">Granted by policy</th><th scope="col">Action</th></tr></thead>
                  <tbody>
                    {access.permissions.map((grant) => {
                      const branchMatches = policyRelativeVariableID(shown, localID(grant.policy)) !== null;
                      const revocable = canDeny && (GRANTEE_KINDS as readonly string[]).includes(kindOf(grant.role)) &&
                        PRIVILEGES.includes(grant.privilege) && branchMatches;
                      const label = 'Revoke ' + grant.privilege + ' from ' + localID(grant.role);
                      return (
                        <tr key={grant.role + '/' + grant.privilege + '/' + grant.policy}>
                          <td><code>{localID(grant.role)}</code> ({kindOf(grant.role)})</td>
                          <td>{grant.privilege}</td>
                          <td><code>{localID(grant.policy)}</code></td>
                          <td>{revocable ? (
                            <button type="button" className="secondary-button" disabled={busy} aria-label={label}
                              onClick={() => review('secret-deny', label, localID(grant.policy), grant.role, grant.privilege)}>
                              Revoke
                            </button>
                          ) : !branchMatches ? <span className="conjur-permission-unavailable">Other policy branch</span> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <p>These are explicit grants on this variable. Access inherited through role membership is not listed.</p>

              {canPermit && (
                <form className="conjur-permissions-grant" onSubmit={(event) => {
                  event.preventDefault();
                  if (!grantee) return;
                  const role = account + ':' + grantee;
                  review('secret-permit', 'Grant ' + privileges + ' to ' + localID(role), localID(access.policy), role, privileges);
                }}>
                  <label>Grant access to
                    <select value={grantee} disabled={busy || !inventory}
                      aria-busy={inventoryState === 'loading'} onChange={(event) => setGrantee(event.target.value)}>
                      <option value="">{inventoryState === 'loading' ? 'Loading roles…' : 'Choose a role'}</option>
                      <RoleOptions inventory={inventory} kinds={GRANTEE_KINDS} />
                    </select>
                  </label>
                  <label>Privileges
                    <select value={privileges} disabled={busy} onChange={(event) => setPrivileges(event.target.value)}>
                      {PRIVILEGES.map((privilege) => <option key={privilege} value={privilege}>{privilege}</option>)}
                    </select>
                  </label>
                  <p>read shows metadata, execute fetches the secret value, update changes the value.</p>
                  <button type="submit" disabled={!grantee || busy ||
                    policyRelativeVariableID(shown, localID(access.policy)) === null}>Review grant</button>
                </form>
              )}
            </section>
          )}

          {pending && (
            <section className="mutation-approval" aria-label="Permission change approval">
              <h4>Review: {pending.label}</h4>
              {pending.preview.context?.fields.map((field) => (
                <p key={field.label}><strong>{field.label}:</strong> {field.value}</p>
              ))}
              <p><strong>Policy branch:</strong> <code>{String(pending.values['policy-branch'])}</code></p>
              <pre className="mutation-stdin">{pending.preview.stdin}</pre>
              <label className="conjur-create-consent">
                <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} />
                I approve this change to this exact variable and environment.
              </label>
              <button type="button" onClick={apply} disabled={!approved || busy}>Apply permission change</button>
            </section>
          )}
          <p role="status" aria-live="polite">{busy ? 'Working with Conjur…' : outcome}</p>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
