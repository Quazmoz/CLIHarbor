import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Task } from '../../api/tasks';
import {
  createRun, fetchRun, previewRun, subscribeRunEvents,
  type RunPreview, type RunSnapshot,
} from '../../api/runs';

const PACK = 'cyberark-conjur-v9';
const TOOL = 'conjur';
const MAX_RUN_MS = 60_000;
const MAX_RECONCILE_MS = 10_000;
// Deliberately accept only simple relative policy paths in this guided flow.
// More complex identifiers remain available through the reviewed generic tasks.
const PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/u;

interface Props {
  tasks: Task[];
  csrfToken: string;
  account?: string;
  endpoint?: string;
  contextKey: string;
}

interface Plan {
  branch: string;
  variable: string;
  fullID: string;
  contextKey: string;
  create: RunPreview;
  set: RunPreview;
}

function supportedTask(tasks: Task[], commandId: string, risk: Task['risk'], inputs: Record<string, string>): boolean {
  const task = tasks.find((candidate) => candidate.packId === PACK && candidate.toolId === TOOL &&
    candidate.commandId === commandId && candidate.risk === risk && candidate.requiresAuth);
  if (!task || task.inputs.length !== Object.keys(inputs).length) return false;
  return task.inputs.every((input) => inputs[input.id] === input.type &&
    (input.type === 'boolean' || input.required === true));
}

export function fullVariableID(branch: string, variable: string): string | null {
  if (branch.length > 512 || variable.length > 2048 || !PATH.test(variable) ||
      (branch !== 'root' && !PATH.test(branch))) return null;
  const id = branch === 'root' ? variable : branch + '/' + variable;
  return id.length <= 2048 ? id : null;
}

function successful(snapshot: RunSnapshot, command: string): boolean {
  return snapshot.packId === PACK && snapshot.toolId === TOOL && snapshot.commandId === command &&
    snapshot.status === 'exited' && snapshot.exitCode === 0;
}

// Every mutation must have authoritative terminal evidence before a dependent
// mutation may start. A dropped event stream is reconciled once, never replayed.
async function completedRun(snapshot: RunSnapshot): Promise<RunSnapshot> {
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

async function exists(csrfToken: string, fullID: string, account: string): Promise<boolean> {
  const snapshot = await completedRun(await createRun(csrfToken, {
    packId: PACK, commandId: 'resource-exists',
    values: { 'resource-id': account + ':variable:' + fullID },
  }));
  if (!successful(snapshot, 'resource-exists')) throw new Error('Conjur could not verify that the variable is new.');
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
  // Do not expose untrusted vendor output or request details in the create flow.
  if (error instanceof Error && error.message.startsWith('Run ')) return error.message;
  if (error instanceof Error && error.message.startsWith('Conjur ')) return error.message;
  return 'The operation was not confirmed. Review Runs and the Conjur variable before trying again.';
}

export function ConjurCreateSecret({ tasks, csrfToken, account, endpoint, contextKey }: Props) {
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState('root');
  const [variable, setVariable] = useState('');
  const [value, setValue] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
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
  const fullID = fullVariableID(branch, variable);
  const inputReady = Boolean(fullID) && value.length >= 1 && value.length <= 4096 &&
    !/[\r\n\p{Cc}\p{Cf}]/u.test(value);
  const reviewed = plan !== null && plan.branch === branch && plan.variable === variable &&
    plan.fullID === fullID && plan.contextKey === contextKey;

  function changed(update: () => void) {
    update();
    setPlan(null);
    setApproved(false);
    setError('');
    setOutcome('');
  }

  async function review(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !allowed || !inputReady || !fullID || !account) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setOutcome('');
    try {
      if (await exists(csrfToken, fullID, account)) {
        throw new Error('Conjur reports this variable already exists. Use Update value instead of creating it.');
      }
      const create = await previewRun(csrfToken, {
        packId: PACK, commandId: 'secret-create',
        values: { 'policy-branch': branch, 'variable-id': variable, 'dry-run': false },
      });
      const set = await previewRun(csrfToken, {
        packId: PACK, commandId: 'secret-set-value', values: { 'variable-id': fullID, value },
      });
      if (create.risk !== 'change' || set.risk !== 'change' ||
          !create.approval || !set.approval ||
          create.approval.mode !== 'explicit' || set.approval.mode !== 'explicit' ||
          !create.context || !set.context || !create.impact || !set.impact ||
          create.impact.target !== variable || set.impact.target !== fullID ||
          JSON.stringify(create.context.fields) !== JSON.stringify(set.context.fields) ||
          create.context.fields.find((field) => field.label === 'Account')?.value !== account ||
          create.context.fields.find((field) => field.label === 'Endpoint')?.value.replace(/\/$/u, '') !== endpoint?.replace(/\/$/u, '') ||
          !create.stdin || set.stdin !== undefined) {
        throw new Error('Conjur did not return matching approved plans for both operations.');
      }
      if (alive.current) setPlan({ branch, variable, fullID, contextKey, create, set });
    } catch (caught) {
      if (alive.current) setError(safeMessage(caught));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function apply() {
    if (busyRef.current || !allowed || !approved || !reviewed || !plan || !account || !inputReady) return;
    // The second independent approval must remain valid while the first run completes.
    // Refuse stale reviews before mutating anything; preserve input for a fresh review.
    if (Math.min(Date.parse(plan.create.approval!.expiresAt), Date.parse(plan.set.approval!.expiresAt)) <= Date.now() + MAX_RUN_MS + 5_000) {
      setError('The reviewed approvals are too close to expiry. Review both changes again before proceeding.');
      setPlan(null);
      setApproved(false);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    setOutcome('');
    const secret = value;
    // Clear React state and the password input before the first process starts.
    setValue('');
    setApproved(false);
    setPlan(null);
    let declared = false;
    try {
      setStage('Checking the target again');
      if (await exists(csrfToken, plan.fullID, account)) {
        throw new Error('Conjur reports this variable already exists. No changes were sent.');
      }
      if (!alive.current) return;
      setStage('Creating the variable');
      const create = await completedRun(await createRun(csrfToken, {
        packId: PACK, commandId: 'secret-create',
        values: { 'policy-branch': plan.branch, 'variable-id': plan.variable, 'dry-run': false },
        approval: { id: plan.create.approval!.id },
      }));
      if (!successful(create, 'secret-create')) {
        throw new Error('Conjur did not confirm variable creation. Check Runs before trying again.');
      }
      declared = true;
      if (!alive.current) return; // Never start a second mutation after navigation.
      setStage('Storing the initial secret value');
      const stored = await completedRun(await createRun(csrfToken, {
        packId: PACK, commandId: 'secret-set-value',
        values: { 'variable-id': plan.fullID, value: secret },
        approval: { id: plan.set.approval!.id },
      }));
      if (!successful(stored, 'secret-set-value')) {
        throw new Error('Conjur created the variable but did not confirm the value was stored.');
      }
      if (alive.current) setOutcome('Variable created and initial value stored. Assign permissions separately if required.');
    } catch (caught) {
      if (alive.current) {
        setError((declared ? 'Partial completion: the variable was created, but value storage is unconfirmed. ' : '') +
          safeMessage(caught) + ' Never blindly repeat creation; inspect the variable first.');
      }
    } finally {
      // The only remaining reference to the secret is this short-lived async call stack.
      if (alive.current) { setBusy(false); setStage(''); }
      busyRef.current = false;
    }
  }

  return (
    <section className="conjur-create-secret" aria-label="Create Conjur secret">
      <button type="button" className="platform-tool-button" disabled={!allowed || busy}
        aria-expanded={open} onClick={() => { if (!busy) setOpen(!open); }}>
        <strong>Create secret</strong>
        <span>Declare a variable and enter its initial value together, using the two approved Conjur commands.</span>
        <small>{allowed ? 'One guided form · Explicit review' : 'Unavailable until Conjur and the approved commands are ready'}</small>
      </button>
      {open && (
        <form className="conjur-create-form" onSubmit={(event) => void review(event)} autoComplete="off">
          <p>Provide the destination and secret value once. No change runs until you review and approve both operations; review checks existence using an approved read-only command. This is not an atomic Conjur transaction.</p>
          <label>Policy branch
            <input required maxLength={512} value={branch} disabled={busy} spellCheck={false}
              onChange={(event) => changed(() => setBranch(event.target.value))} />
          </label>
          <label>New variable ID (relative to branch)
            <input required maxLength={2048} value={variable} disabled={busy} spellCheck={false}
              placeholder="db/password" onChange={(event) => changed(() => setVariable(event.target.value))} />
          </label>
          <p>Full variable ID: <code>{fullID ?? 'Enter a simple relative policy path and variable ID'}</code></p>
          <label>Initial secret value
            <input required type="password" minLength={1} maxLength={4096} value={value}
              disabled={busy} autoComplete="off" spellCheck={false}
              onChange={(event) => changed(() => setValue(event.target.value))} />
          </label>
          <p>The value is sent over the protected local API and then to the vendor CLI on stdin. It is never displayed in the preview or stored in run history.</p>
          <button type="submit" disabled={!allowed || !inputReady || busy}>Review creation and value</button>
          {reviewed && plan && (
            <section className="mutation-approval" aria-label="Create secret approval">
              <h4>Review both Conjur changes</h4>
              <p><strong>Target:</strong> <code>{plan.fullID}</code></p>
              {plan.create.context?.fields.map((field) => (
                <p key={field.label}><strong>{field.label}:</strong> {field.value}</p>
              ))}
              <p><strong>1. Declare the variable:</strong></p>
              <pre className="mutation-stdin">{plan.create.stdin}</pre>
              <p><strong>2. Set initial value:</strong> secret passed on stdin, never shown.</p>
              <p>If the first step succeeds and the second fails, the variable may remain without the intended value. There is no automatic rollback.</p>
              <label className="conjur-create-consent">
                <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} />
                I approve both changes to this exact target and environment.
              </label>
              <button type="button" onClick={() => void apply()} disabled={!approved || busy}>
                Create secret and store value
              </button>
            </section>
          )}
          <p role="status" aria-live="polite">{busy ? stage || 'Checking Conjur and preparing the approvals…' : outcome}</p>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </section>
  );
}
