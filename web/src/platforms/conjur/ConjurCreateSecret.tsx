import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Task } from '../../api/tasks';
import { createRun, previewRun, type RunPreview } from '../../api/runs';
import { normalizeConjurSaaSAPIURL } from './ConjurBackendConnection';
import { WorkingStatus } from '../../WorkingStatus';
import { ExecutionContext, OperationResult, type OperationOutcome } from '../../OperationResult';
import { useMutationActivity, useMutationPending } from '../../OperationActivity';
import {
  GRANTEE_KINDS, InventoryStatus, PACK, PERMISSION_INPUTS, PRIVILEGES, ROLE_KINDS, RoleOptions,
  approvalsFresh, completedRun, matchingPlans, safeMessage as sharedSafeMessage, splitRole, successful,
  supportedTask, useConjurInventory, variableExists as exists, ExistenceCheckFailure,
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
  onInspectTarget?: (id: string) => void;
  onManageAccess?: (id: string) => void;
  initial?: Record<string, string>;
  initiallyOpen?: boolean;
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

function safeMessage(error: unknown): string {
  return error instanceof ExistenceCheckFailure ? error.message : sharedSafeMessage(error);
}

export function ConjurCreateSecret({ tasks, csrfToken, account, endpoint, contextKey, onOpenRuns, onInspectTarget, onManageAccess, initial, initiallyOpen = false }: Props) {
  const beginMutation = useMutationActivity();
  // SaaS tenants cannot load policy into root; their secrets live under data.
  // The parent remounts this form when the endpoint changes.
  const saas = Boolean(endpoint && normalizeConjurSaaSAPIURL(endpoint));
  const [open, setOpen] = useState(initiallyOpen);
  const [branch, setBranch] = useState(initial?.['policy-branch'] ?? (saas ? 'data' : 'root'));
  const [variable, setVariable] = useState(initial?.['variable-id'] ?? '');
  const [value, setValue] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [approved, setApproved] = useState(false);
  const [operation, setOperation] = useState<'review' | 'create' | null>(null);
  const pendingMutation = useMutationPending('conjur-secret-work-progress');
  const busy = operation !== null || pendingMutation;
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [failedCheckRunId, setFailedCheckRunId] = useState('');
  const [outcome, setOutcome] = useState('');
  const [result, setResult] = useState<OperationOutcome | null>(null);
  const [owner, setOwner] = useState(initial?.['owner-kind'] && initial?.['owner-id'] ? initial['owner-kind'] + ':' + initial['owner-id'].replace(/^\//u, '') : '');
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
  useEffect(() => { if (initiallyOpen) void loadInventory(); }, [initiallyOpen, loadInventory]);
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
    setResult(null);
    update();
    setPlan(null);
    setApproved(false);
    setError('');
    setFailedCheckRunId('');
    setOutcome('');
  }

  async function review(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || pendingMutation || !allowed || !inputReady || !fullID || !account) return;
    busyRef.current = true;
    setOperation('review');
    setResult(null);
    setStage('Checking whether the variable already exists…');
    setError('');
    setFailedCheckRunId('');
    setOutcome('');
    try {
      if (await exists(csrfToken, fullID, account)) {
        throw new Error('Conjur reports this variable already exists. Use Update value instead of creating it.');
      }
      setStage('Preparing the variable creation approval…');
      const create = await previewRun(csrfToken, {
        packId: PACK, commandId: owner ? 'secret-create-owned' : 'secret-create',
        values: createValues(branch, variable, owner),
      });
      setStage('Preparing the initial value approval…');
      const set = await previewRun(csrfToken, {
        packId: PACK, commandId: 'secret-set-value', values: { 'variable-id': fullID, value },
      });
      if (grantee) setStage('Preparing the access grant approval…');
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
      if (alive.current) { setOperation(null); setStage(''); }
    }
  }

  async function apply() {
    if (busyRef.current || pendingMutation || !allowed || !approved || !reviewed || !plan || !account || !inputReady) return;
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
    setOperation('create');
    const finishActivity = beginMutation('Creating Conjur secret…', 'conjur-secret-work-progress');
    setResult(null);
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
    let createAttempted = false;
    let valueAttempted = false;
    let grantAttempted = false;
    let granted = false;
    const steps = (): OperationOutcome['steps'] => [
      { label: 'Variable creation', state: declared ? 'done' : createAttempted ? 'unknown' : 'not-started' },
      { label: 'Initial value storage', state: stored ? 'done' : valueAttempted ? 'unknown' : 'not-started' },
      ...(plan.permit ? [{ label: 'Access grant', state: granted ? 'done' as const : grantAttempted ? 'unknown' as const : 'not-started' as const }] : []),
    ];
    const createCommand = plan.owner ? 'secret-create-owned' : 'secret-create';
    try {
      setStage('Checking the target again');
      if (await exists(csrfToken, plan.fullID, account)) {
        throw new Error('Conjur reports this variable already exists. No changes were sent.');
      }
      if (!alive.current) return;
      setStage('Creating the variable');
      createAttempted = true;
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
      valueAttempted = true;
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
        grantAttempted = true;
        const permitted = await completedRun(await createRun(csrfToken, {
          packId: PACK, commandId: 'secret-permit', values: permitValues(plan),
          approval: { id: plan.permit.approval!.id },
        }));
        if (!successful(permitted, 'secret-permit')) {
          throw new Error('Conjur did not confirm the access grant.');
        }
        granted = true;
      }
      if (alive.current) {
        setResult({ title: 'Secret created', tone: 'success', target: plan.fullID, steps: steps(),
          next: 'Inspect the variable or manage its access. Stored secret values are never displayed.' });
        setOutcome(plan.permit ? 'Variable created, initial value stored and access granted.'
          : 'Variable created and initial value stored. Assign permissions separately if required.');
      }
    } catch (caught) {
      if (alive.current) {
        setResult({ title: createAttempted ? 'Creation outcome needs review' : 'Creation stopped before changes', tone: 'warning', target: plan.fullID, steps: steps(),
          next: stored ? 'Do not recreate the secret. Inspect Execution History, then review the access grant separately.'
            : declared ? 'The variable exists. Inspect Execution History before deciding whether to update its value; do not repeat creation.'
            : createAttempted ? 'Creation is unconfirmed. Inspect Execution History and check whether the variable exists before doing anything else.'
            : 'No mutation was requested. Resolve the read-only check failure before a fresh review.' });
        setError(stored
          ? 'Partial completion: the variable and its value are stored, but the access grant is unconfirmed. ' +
            safeMessage(caught) + ' Check Runs, then use Grant permission instead of recreating the secret.'
          : (declared ? 'Partial completion: the variable was created, but value storage is unconfirmed. ' : '') +
            safeMessage(caught) + ' Never blindly repeat creation; inspect the variable first.');
        setFailedCheckRunId(caught instanceof ExistenceCheckFailure ? caught.runId : '');
      }
    } finally {
      // The only remaining reference to the secret is this short-lived async call stack.
      finishActivity();
      if (alive.current) { setOperation(null); setStage(''); }
      busyRef.current = false;
    }
  }

  return (
    <section className="conjur-create-secret" aria-label="Create Conjur secret">
      <button type="button" className="conjur-action conjur-action--primary" disabled={!allowed || busy}
        aria-busy={busy}
        aria-expanded={open} onClick={() => {
          if (busy) return;
          if (!open && !inventory) void loadInventory();
          setOpen(!open);
        }}>
        <span className="conjur-action-text">
          <strong>{operation === 'create' || pendingMutation ? 'Creating secret…' : operation === 'review' ? 'Reviewing secret…' : 'Create secret'}</strong>
          <span>{allowed
            ? 'Choose where the variable lives, who owns it and who can access it, then enter its initial value, using approved Conjur commands.'
            : 'Unavailable until Conjur and the approved commands are ready.'}</span>
        </span>
        <span className="task-risk-badge task-risk-badge--change">Explicit approval</span>
      </button>
      {open && (
        <form className="conjur-create-form" onSubmit={(event) => void review(event)} autoComplete="off">
          <ExecutionContext fields={[{ label: 'Account', value: account ?? 'Unavailable' }, { label: 'Backend', value: endpoint ?? 'Unavailable' }]}
            target={fullID ?? 'Choose a valid variable ID'} />
          <p>Provide the destination and secret value once. No change runs until you review and approve every operation; review checks existence using an approved read-only command. This is not an atomic Conjur transaction.</p>
          <InventoryStatus state={inventoryState} disabled={busy} onRetry={() => void loadInventory()} />
          {inventory ? (
            <label>Parent policy
              <select value={branch} disabled={busy} onChange={(event) => changed(() => setBranch(event.target.value))}>
                {branchOptions.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
          ) : inventoryState === 'loading' ? (
            <label>Parent policy
              <select value="" disabled aria-busy="true">
                <option value="">Loading policies…</option>
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
              aria-busy={inventoryState === 'loading'}
              onChange={(event) => changed(() => setOwner(event.target.value))}>
              <option value="">{inventoryState === 'loading' ? 'Loading roles…' : 'Parent policy (Conjur default)'}</option>
              <RoleOptions inventory={inventory} kinds={ROLE_KINDS} selected={owner} />
            </select>
          </label>
          <p>The owner holds every privilege on the variable, including reading and changing its value.</p>
          <label>Accessible by
            <select value={grantee} disabled={busy || !inventory || !canPermit}
              aria-busy={inventoryState === 'loading'}
              onChange={(event) => changed(() => setGrantee(event.target.value))}>
              <option value="">{inventoryState === 'loading' ? 'Loading roles…' : 'Owner only (no additional grant)'}</option>
              <RoleOptions inventory={inventory} kinds={GRANTEE_KINDS} selected={grantee} />
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
          <button type="submit" disabled={!allowed || !inputReady || busy} aria-busy={busy}>
            {operation === 'review' ? 'Reviewing creation…' : operation === 'create' ? 'Creating secret…' : 'Review creation and value'}
          </button>
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
          <WorkingStatus active={busy} title={operation === 'review' ? 'Reviewing secret creation…' : 'Creating secret…'}
            id="conjur-secret-work-progress"
            mutation={operation === 'create'}
            track={operation === 'review'}
            detail={stage + ' Keep this page open; no need to submit again.'} />
          <p role="status" aria-live="polite">{outcome}</p>
          {result && <OperationResult result={result}>
            {onOpenRuns && <button type="button" className="secondary-button" onClick={onOpenRuns}>Open Execution History</button>}
            {onInspectTarget && result.target && <button type="button" className="secondary-button" onClick={() => onInspectTarget(result.target!)}>Inspect variable</button>}
            {onManageAccess && result.target && <button type="button" className="secondary-button" onClick={() => onManageAccess(result.target!)}>Manage access</button>}
          </OperationResult>}
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
