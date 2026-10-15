import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Task } from '../../api/tasks';
import { createRun, previewRun, type RunPreview } from '../../api/runs';
import { normalizeConjurSaaSAPIURL } from './ConjurBackendConnection';
import {
  GRANTEE_KINDS, InventoryStatus, PACK, PERMISSION_INPUTS, PRIVILEGES, ROLE_KINDS, RoleOptions,
  approvalsFresh, completedRun, matchingPlans, safeMessage as sharedSafeMessage, splitRole, successful,
  supportedTask, useConjurInventory,
} from './conjurRuns';

// Deliberately accept only simple relative policy paths in this guided flow.
// More complex identifiers remain available through the reviewed generic tasks.
const PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/u;

interface Props {
  tasks: Task[];
  csrfToken: string;
  account?: string;
  endpoint?: string;
  contextKey: string;
  onOpenRuns?: () => void;
}

interface Plan {
  branch: string;
  variable: string;
  fullID: string;
  contextKey: string;
  owner: string;
  grantee: string;
  privileges: string;
  create: RunPreview;
  set: RunPreview;
  permit?: RunPreview;
}

function createValues(branch: string, variable: string, owner: string): Record<string, unknown> {
  if (!owner) return { 'policy-branch': branch, 'variable-id': variable, 'dry-run': false };
  const [kind, id] = splitRole(owner);
  // A leading slash makes Conjur resolve the selected role absolutely, not under the branch.
  return { 'policy-branch': branch, 'variable-id': variable, 'owner-kind': kind, 'owner-id': '/' + id, 'dry-run': false };
}

function permitValues(plan: Pick<Plan, 'branch' | 'variable' | 'grantee' | 'privileges'>): Record<string, unknown> {
  const [kind, id] = splitRole(plan.grantee);
  return {
    'policy-branch': plan.branch, 'variable-id': plan.variable, 'role-kind': kind, 'role-id': '/' + id,
    privileges: plan.privileges, 'dry-run': false,
  };
}

export function fullVariableID(branch: string, variable: string): string | null {
  if (branch.length > 512 || variable.length > 2048 || !PATH.test(variable) ||
      (branch !== 'root' && !PATH.test(branch))) return null;
  const id = branch === 'root' ? variable : branch + '/' + variable;
  return id.length <= 2048 ? id : null;
}

// A failed CLI read is not evidence of absence. Carry only CLIHarbor's
// generated run ID to the UI, never untrusted vendor stdout or stderr.
class ExistenceCheckFailure extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super('Conjur could not verify that the variable is new. The read-only existence check failed; no changes were sent. Inspect Runs for the underlying CLI error.');
    this.runId = /^[A-Za-z0-9_-]{1,128}$/u.test(runId) ? runId : '';
  }
}

async function exists(csrfToken: string, fullID: string, account: string): Promise<boolean> {
  const snapshot = await completedRun(await createRun(csrfToken, {
    packId: PACK, commandId: 'resource-exists',
    values: { 'resource-id': account + ':variable:' + fullID },
  }));
  if (!successful(snapshot, 'resource-exists')) throw new ExistenceCheckFailure(snapshot.runId);
  const existsField = snapshot.structured?.status === 'available'
    ? snapshot.structured.fields?.find((field) => field.key === 'exists' && field.present && field.type === 'boolean')
    : undefined;
  if (existsField && (existsField.value === 'true' || existsField.value === 'false')) {
    return existsField.value === 'true';
  }
  // The reviewed pack requires a single structured boolean. Never fall back to
  // JSON.parse(stdout): it can mask parser failures such as duplicate keys.
  throw new Error('Conjur returned an unrecognized existence result.');
}

function safeMessage(error: unknown): string {
  return error instanceof ExistenceCheckFailure ? error.message : sharedSafeMessage(error);
}

export function ConjurCreateSecret({ tasks, csrfToken, account, endpoint, contextKey, onOpenRuns }: Props) {
  // SaaS tenants cannot load policy into root; their secrets live under data.
  // The parent remounts this form when the endpoint changes.
  const saas = Boolean(endpoint && normalizeConjurSaaSAPIURL(endpoint));
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState(saas ? 'data' : 'root');
  const [variable, setVariable] = useState('');
  const [value, setValue] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [failedCheckRunId, setFailedCheckRunId] = useState('');
  const [outcome, setOutcome] = useState('');
  const [owner, setOwner] = useState('');
  const [grantee, setGrantee] = useState('');
  const [privileges, setPrivileges] = useState(PRIVILEGES[0]);
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const allowed = Boolean(account && endpoint) &&
    supportedTask(tasks, 'resource-exists', 'read', { 'resource-id': 'string' }) &&
    supportedTask(tasks, 'secret-create', 'change', {
      'policy-branch': 'string', 'variable-id': 'string', 'dry-run': 'boolean',
    }) &&
    supportedTask(tasks, 'secret-set-value', 'change', { 'variable-id': 'string', value: 'secret' });
  const { inventory, state: inventoryState, load: loadInventory } = useConjurInventory(csrfToken, account, tasks, ROLE_KINDS);
  const canOwn = supportedTask(tasks, 'secret-create-owned', 'change', {
    'policy-branch': 'string', 'variable-id': 'string', 'owner-kind': 'enum', 'owner-id': 'string', 'dry-run': 'boolean',
  });
  const canPermit = supportedTask(tasks, 'secret-permit', 'change', PERMISSION_INPUTS);
  // SaaS only accepts branches under data; keep the current branch listed so the select never lies.
  const branchOptions = inventory ? [...new Set([...(saas ? [] : ['root']), branch, ...(inventory.policy ?? []).filter((id) =>
    PATH.test(id) && id !== 'root' && (!saas || id === 'data' || id.startsWith('data/')))])] : [];

  const fullID = fullVariableID(branch, variable);
  const saasRoot = saas && branch === 'root';
  // The resource-exists task limits the account-prefixed resource ID to 2048 characters.
  const resourceIDTooLong = Boolean(fullID && account && (account + ':variable:' + fullID).length > 2048);
  const inputReady = Boolean(fullID) && !saasRoot && !resourceIDTooLong && value.length >= 1 && value.length <= 4096 &&
    !/[\r\n\p{Cc}\p{Cf}]/u.test(value);
  const reviewed = plan !== null && plan.branch === branch && plan.variable === variable &&
    plan.fullID === fullID && plan.contextKey === contextKey && plan.owner === owner &&
    plan.grantee === grantee && plan.privileges === privileges;

  function changed(update: () => void) {
    update();
    setPlan(null);
    setApproved(false);
    setError('');
    setFailedCheckRunId('');
    setOutcome('');
  }

  async function review(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !allowed || !inputReady || !fullID || !account) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setFailedCheckRunId('');
    setOutcome('');
    try {
      if (await exists(csrfToken, fullID, account)) {
        throw new Error('Conjur reports this variable already exists. Use Update value instead of creating it.');
      }
      const create = await previewRun(csrfToken, {
        packId: PACK, commandId: owner ? 'secret-create-owned' : 'secret-create',
        values: createValues(branch, variable, owner),
      });
      const set = await previewRun(csrfToken, {
        packId: PACK, commandId: 'secret-set-value', values: { 'variable-id': fullID, value },
      });
      const permit = grantee ? await previewRun(csrfToken, {
        packId: PACK, commandId: 'secret-permit', values: permitValues({ branch, variable, grantee, privileges }),
      }) : undefined;
      const policyLoads = permit ? [create, permit] : [create];
      if (!matchingPlans([...policyLoads, set], account, endpoint) ||
          policyLoads.some((step) => step.impact?.target !== variable || !step.stdin) ||
          set.impact?.target !== fullID || set.stdin !== undefined) {
        throw new Error('Conjur did not return matching approved plans for every operation.');
      }
      if (alive.current) setPlan({ branch, variable, fullID, contextKey, owner, grantee, privileges, create, set, permit });
    } catch (caught) {
      if (alive.current) {
        setError(safeMessage(caught));
        setFailedCheckRunId(caught instanceof ExistenceCheckFailure ? caught.runId : '');
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function apply() {
    if (busyRef.current || !allowed || !approved || !reviewed || !plan || !account || !inputReady) return;
    // Later independent approvals must remain valid while the first run completes.
    // Refuse stale reviews before mutating anything; preserve input for a fresh review.
    // An optional grant that still lapses later is reported as recoverable partial completion.
    if (!approvalsFresh([plan.create, plan.set, ...(plan.permit ? [plan.permit] : [])])) {
      setError('The reviewed approvals are too close to expiry. Review both changes again before proceeding.');
      setPlan(null);
      setApproved(false);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    setFailedCheckRunId('');
    setOutcome('');
    const secret = value;
    // Clear React state and the password input before the first process starts.
    setValue('');
    setApproved(false);
    setPlan(null);
    let declared = false;
    let stored = false;
    const createCommand = plan.owner ? 'secret-create-owned' : 'secret-create';
    try {
      setStage('Checking the target again');
      if (await exists(csrfToken, plan.fullID, account)) {
        throw new Error('Conjur reports this variable already exists. No changes were sent.');
      }
      if (!alive.current) return;
      setStage('Creating the variable');
      const create = await completedRun(await createRun(csrfToken, {
        packId: PACK, commandId: createCommand,
        values: createValues(plan.branch, plan.variable, plan.owner),
        approval: { id: plan.create.approval!.id },
      }));
      if (!successful(create, createCommand)) {
        throw new Error('Conjur did not confirm variable creation. Check Runs before trying again.');
      }
      declared = true;
      if (!alive.current) return; // Never start a second mutation after navigation.
      setStage('Storing the initial secret value');
      const setRun = await completedRun(await createRun(csrfToken, {
        packId: PACK, commandId: 'secret-set-value',
        values: { 'variable-id': plan.fullID, value: secret },
        approval: { id: plan.set.approval!.id },
      }));
      if (!successful(setRun, 'secret-set-value')) {
        throw new Error('Conjur created the variable but did not confirm the value was stored.');
      }
      stored = true;
      if (plan.permit) {
        if (!alive.current) return;
        setStage('Granting access');
        const permitted = await completedRun(await createRun(csrfToken, {
          packId: PACK, commandId: 'secret-permit', values: permitValues(plan),
          approval: { id: plan.permit.approval!.id },
        }));
        if (!successful(permitted, 'secret-permit')) {
          throw new Error('Conjur did not confirm the access grant.');
        }
      }
      if (alive.current) {
        setOutcome(plan.permit ? 'Variable created, initial value stored and access granted.'
          : 'Variable created and initial value stored. Assign permissions separately if required.');
      }
    } catch (caught) {
      if (alive.current) {
        setError(stored
          ? 'Partial completion: the variable and its value are stored, but the access grant is unconfirmed. ' +
            safeMessage(caught) + ' Check Runs, then use Grant permission instead of recreating the secret.'
          : (declared ? 'Partial completion: the variable was created, but value storage is unconfirmed. ' : '') +
            safeMessage(caught) + ' Never blindly repeat creation; inspect the variable first.');
        setFailedCheckRunId(caught instanceof ExistenceCheckFailure ? caught.runId : '');
      }
    } finally {
      // The only remaining reference to the secret is this short-lived async call stack.
      if (alive.current) { setBusy(false); setStage(''); }
      busyRef.current = false;
    }
  }

  return (
    <section className="conjur-create-secret" aria-label="Create Conjur secret">
      <button type="button" className="conjur-action conjur-action--primary" disabled={!allowed || busy}
        aria-expanded={open} onClick={() => {
          if (busy) return;
          if (!open && !inventory) void loadInventory();
          setOpen(!open);
        }}>
        <span className="conjur-action-text">
          <strong>Create secret</strong>
          <span>{allowed
            ? 'Choose where the variable lives, who owns it and who can access it, then enter its initial value, using approved Conjur commands.'
            : 'Unavailable until Conjur and the approved commands are ready.'}</span>
        </span>
        <span className="task-risk-badge task-risk-badge--change">Explicit approval</span>
      </button>
      {open && (
        <form className="conjur-create-form" onSubmit={(event) => void review(event)} autoComplete="off">
          <p>Provide the destination and secret value once. No change runs until you review and approve every operation; review checks existence using an approved read-only command. This is not an atomic Conjur transaction.</p>
          <InventoryStatus state={inventoryState} disabled={busy} onRetry={() => void loadInventory()} />
          {inventory ? (
            <label>Parent policy
              <select value={branch} disabled={busy} onChange={(event) => changed(() => setBranch(event.target.value))}>
                {branchOptions.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
          ) : (
            <label>Policy branch
              <input required maxLength={512} value={branch} disabled={busy} spellCheck={false}
                onChange={(event) => changed(() => setBranch(event.target.value))} />
            </label>
          )}
          {saasRoot && <p role="alert">Secrets Manager SaaS does not allow changes to the root policy. Use <code>data</code> or a branch under it.</p>}
          <label>New variable ID (relative to branch)
            <input required maxLength={2048} value={variable} disabled={busy} spellCheck={false}
              placeholder="db/password" onChange={(event) => changed(() => setVariable(event.target.value))} />
          </label>
          <p>Full variable ID: <code>{fullID ?? 'Enter a simple relative policy path and variable ID'}</code></p>
          {resourceIDTooLong && <p role="alert">The complete Conjur resource ID exceeds the supported 2,048-character limit. Shorten the variable path.</p>}
          <label>Owner
            <select value={owner} disabled={busy || !inventory || !canOwn}
              onChange={(event) => changed(() => setOwner(event.target.value))}>
              <option value="">Parent policy (Conjur default)</option>
              <RoleOptions inventory={inventory} kinds={ROLE_KINDS} />
            </select>
          </label>
          <p>The owner holds every privilege on the variable, including reading and changing its value.</p>
          <label>Accessible by
            <select value={grantee} disabled={busy || !inventory || !canPermit}
              onChange={(event) => changed(() => setGrantee(event.target.value))}>
              <option value="">Owner only (no additional grant)</option>
              <RoleOptions inventory={inventory} kinds={GRANTEE_KINDS} />
            </select>
          </label>
          {grantee && (
            <label>Permissions
              <select value={privileges} disabled={busy} onChange={(event) => changed(() => setPrivileges(event.target.value))}>
                {PRIVILEGES.map((privilege) => <option key={privilege} value={privilege}>{privilege}</option>)}
              </select>
            </label>
          )}
          {grantee && <p>read shows metadata, execute fetches the secret value, update changes the value.</p>}
          <label>Initial secret value
            <input required type="password" minLength={1} maxLength={4096} value={value}
              disabled={busy} autoComplete="off" spellCheck={false}
              onChange={(event) => changed(() => setValue(event.target.value))} />
          </label>
          <p>The value is sent over the protected local API and then to the vendor CLI on stdin. It is never displayed in the preview or stored in run history.</p>
          <button type="submit" disabled={!allowed || !inputReady || busy}>Review creation and value</button>
          {reviewed && plan && (
            <section className="mutation-approval" aria-label="Create secret approval">
              <h4>Review {plan.permit ? 'all three' : 'both'} Conjur changes</h4>
              <p><strong>Target:</strong> <code>{plan.fullID}</code></p>
              {plan.create.context?.fields.map((field) => (
                <p key={field.label}><strong>{field.label}:</strong> {field.value}</p>
              ))}
              <p><strong>1. Declare the variable{plan.owner ? ' with its owner' : ''}:</strong></p>
              <pre className="mutation-stdin">{plan.create.stdin}</pre>
              <p><strong>2. Set initial value:</strong> secret passed on stdin, never shown.</p>
              {plan.permit && <>
                <p><strong>3. Grant access:</strong></p>
                <pre className="mutation-stdin">{plan.permit.stdin}</pre>
              </>}
              <p>If an early step succeeds and a later one fails, the variable may remain without the intended value or access. There is no automatic rollback.</p>
              <label className="conjur-create-consent">
                <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} />
                I approve {plan.permit ? 'all three' : 'both'} changes to this exact target and environment.
              </label>
              <button type="button" onClick={() => void apply()} disabled={!approved || busy}>
                Create secret and store value
              </button>
            </section>
          )}
          <p role="status" aria-live="polite">{busy ? stage || 'Checking Conjur and preparing the approvals…' : outcome}</p>
          {error && <p role="alert">{error}</p>}
          {error && failedCheckRunId && (
            <div className="conjur-create-check-failure">
              <p>Failed read-only check run: <code>{failedCheckRunId}</code></p>
              {onOpenRuns && <button type="button" className="secondary-button" onClick={onOpenRuns}>
                Inspect failed check in Runs
              </button>}
            </div>
          )}
        </form>
      )}
    </section>
  );
}
