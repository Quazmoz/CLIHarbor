import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Task } from '../../api/tasks';
import { normalizeError, type AppErrorDetail } from '../../api/errors';
import { createRun, decodeRunOutput, previewRun, type RunPreview, type RunSnapshot } from '../../api/runs';
import { InputControl, initialValues, requestValues, taskInputDOMID, type FormValue } from '../../taskForm';
import { ExecutionContext, OperationResult, type OperationOutcome } from '../../OperationResult';
import { WorkingStatus } from '../../WorkingStatus';
import { useMutationActivity, useMutationPending } from '../../OperationActivity';
import { OutputExplorer } from '../../OutputExplorer';
import { ConjurIDSelect } from './ConjurIDSelect';
import { policyRelativeVariableID } from './ConjurManagePermissions';
import { normalizeConjurSaaSAPIURL } from './ConjurBackendConnection';
import { approvalsFresh, completedRun, InventoryStatus, matchingContext, PACK, ROLE_KINDS, successful, TOOL, useConjurInventory, variableExists, type InventoryKind } from './conjurRuns';

interface Props {
  task: Task; tasks: Task[]; csrfToken: string; account?: string; endpoint?: string;
  prefill?: Record<string, string>; onOpenRuns?: () => void;
}

const allKinds: readonly InventoryKind[] = [...ROLE_KINDS, 'variable', 'webservice', 'host_factory'];
const activityID = 'conjur-dedicated-task-progress';

/** Dedicated presentation over existing approved tasks; no additional CLI authority. */
export function ConjurTaskPanel({ task, tasks, csrfToken, account, endpoint, prefill, onOpenRuns }: Props) {
  const prefix = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<string, FormValue>>(() => {
    const initial = initialValues(task);
    if ('policy-branch' in initial) initial['policy-branch'] = endpoint && normalizeConjurSaaSAPIURL(endpoint) ? 'data' : 'root';
    for (const input of task.inputs) if (input.type !== 'secret' && prefill?.[input.id] !== undefined) initial[input.id] = prefill[input.id];
    return initial;
  });
  const [plan, setPlan] = useState<RunPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [stage, setStage] = useState('');
  const [failure, setFailure] = useState<AppErrorDetail | null>(null);
  const [message, setMessage] = useState('');
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [outcome, setOutcome] = useState<OperationOutcome | null>(null);
  const [mutating, setMutating] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const beginMutation = useMutationActivity();
  const pending = useMutationPending(activityID);
  const busy = stage !== '' || pending;
  const mutation = task.risk !== 'read';
  const allowed = task.packId === PACK && task.toolId === TOOL && (!mutation || Boolean(account && endpoint));
  const kinds = useMemo(() => {
    const ids = task.inputs.map((input) => input.id);
    return allKinds.filter((kind) => ids.includes('resource-id') ||
      (kind === 'variable' && ids.includes('variable-id')) ||
      (kind === 'policy' && ids.includes('policy-branch')) ||
      (ROLE_KINDS.includes(kind as typeof ROLE_KINDS[number]) && ids.some((id) => ['role-id', 'role', 'roles', 'owner-id'].includes(id))));
  }, [task]);
  const { inventory, state: inventoryState, load } = useConjurInventory(csrfToken, allowed ? account : undefined, tasks, kinds);
  useEffect(() => {
    alive.current = true;
    heading.current?.focus();
    if (kinds.length > 0) void load();
    return () => { alive.current = false; };
  }, [load, kinds.length]);
  useEffect(() => {
    if (failure?.field) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [failure]);

  const text = (id: string) => typeof values[id] === 'string' ? values[id] as string : '';
  const branch = text('policy-branch');
  function changed(id: string, value: FormValue) {
    setValues((current) => ({ ...current, [id]: value,
      ...(id === 'policy-branch' || id === 'role-kind' || id === 'owner-kind' ? { [id === 'policy-branch' ? 'variable-id' : id === 'role-kind' ? 'role-id' : 'owner-id']: '' } : {}) }));
    setPlan(null); setConsent(false); setConfirmation(''); setFailure(null); setMessage(''); setOutcome(null); setSnapshot(null);
  }

  function options(id: string): string[] | null {
    if (id === 'policy-branch') {
      const saas = Boolean(endpoint && normalizeConjurSaaSAPIURL(endpoint));
      return [...new Set([saas ? 'data' : 'root', ...(inventory?.policy ?? []).filter((id) => !saas || id === 'data' || id.startsWith('data/'))])];
    }
    if (id === 'variable-id') return (inventory?.variable ?? []).flatMap((id) => {
      const relative = branch ? policyRelativeVariableID(id, branch) : id;
      return relative === null ? [] : [relative];
    });
    if (id === 'resource-id') return allKinds.flatMap((kind) => (inventory?.[kind] ?? []).map((id) => account + ':' + kind + ':' + id));
    if (id === 'role-id' || id === 'owner-id' || id === 'role') {
      const selectedKind = text(id === 'owner-id' ? 'owner-kind' : 'role-kind');
      return ROLE_KINDS.filter((kind) => !selectedKind || selectedKind === kind).flatMap((kind) =>
        (inventory?.[kind] ?? []).map((id) => selectedKind ? '/' + id : account + ':' + kind + ':' + id));
    }
    if (id === 'privilege') return ['read', 'execute', 'update', 'write'];
    return null;
  }

  async function perform(review: boolean) {
    if (busyRef.current || pending || !allowed) return;
    if (form.current && !form.current.reportValidity()) return;
    if (!review && mutation && (!plan?.approval || !consent ||
      (plan.approval.mode === 'typed' && confirmation !== plan.approval.requiredText))) return;
    busyRef.current = true;
    setStage(review ? 'Preparing the reviewed Conjur action…' : 'Running the approved Conjur action…');
    setFailure(null); setMessage(''); setOutcome(null); setSnapshot(null);
    const approval = plan?.approval;
    if (review) { setPlan(null); setConsent(false); setConfirmation(''); }
    let finishMutation: (() => void) | undefined;
    try {
      const submitted = requestValues(task, values);
      if (review) {
        if (['secret-set-value', 'secret-delete'].includes(task.commandId) && account &&
          tasks.some((entry) => entry.packId === PACK && entry.commandId === 'resource-exists' && entry.risk === 'read')) {
          const fullID = branch && branch !== 'root' ? branch + '/' + submitted['variable-id'] : submitted['variable-id'];
          if (!await variableExists(csrfToken, String(fullID), account)) {
            throw new Error('Conjur did not confirm that this variable exists. No change was approved.');
          }
          if (!alive.current) return;
        }
        const next = await previewRun(csrfToken, { packId: PACK, commandId: task.commandId, values: submitted });
        if (next.packId !== PACK || next.commandId !== task.commandId || next.toolId !== TOOL || next.risk !== task.risk ||
          !matchingContext(next, account, endpoint) || !next.impact || !task.impact ||
          next.impact.target !== submitted[task.impact.targetInput] || !next.approval ||
          next.approval.mode !== (task.risk === 'destructive' ? 'typed' : 'explicit') ||
          (next.approval.mode === 'typed' && !next.approval.requiredText)) throw new Error('Conjur did not return a matching approved plan.');
        if (alive.current) { setPlan(next); setConsent(false); setConfirmation(''); }
        return;
      }
      if (mutation) {
        if (!plan || !approvalsFresh([plan])) {
          setPlan(null); setConsent(false);
          throw new Error('Conjur approval is too close to expiry. Review the action again.');
        }
        setPlan(null); setConsent(false); setConfirmation(''); setMutating(true);
        finishMutation = beginMutation('Applying ' + task.name + '…', activityID);
      }
      const accepting = createRun(csrfToken, { packId: PACK, commandId: task.commandId, values: submitted,
        ...(mutation ? { approval: { id: approval!.id, ...(approval!.mode === 'typed' ? { confirmation } : {}) } } : {}) });
      if (mutation) setValues((current) => Object.fromEntries(Object.entries(current).map(([id, value]) =>
        [id, task.inputs.some((input) => input.id === id && input.type === 'secret') ? '' : value])));
      const accepted = await accepting;
      const completed = await completedRun(accepted);
      if (!alive.current) return;
      setSnapshot(completed);
      const confirmed = successful(completed, task.commandId);
      setOutcome({ title: confirmed ? task.name + ' completed' : 'Conjur action is not confirmed', tone: confirmed ? 'success' : 'warning',
        target: plan?.impact?.target ?? (text('resource-id') || text('role-id')),
        steps: [{ label: task.name, state: confirmed ? 'done' : 'unknown' }],
        next: confirmed ? 'Review the recorded result below. This reports command completion; verify the target before a further change.' : 'Inspect Execution History and the target before deciding whether another attempt is needed.' });
    } catch (caught) {
      if (!alive.current) return;
      if (caught instanceof Error && caught.message.startsWith('Conjur ')) setMessage(caught.message);
      else setFailure(normalizeError(caught).detail);
      if (!review && mutation) setOutcome({ title: 'Conjur action is unconfirmed', tone: 'warning', target: plan?.impact?.target,
        steps: [{ label: task.name, state: 'unknown' }], next: 'Check Execution History and the target before retrying. The request is never automatically replayed.' });
    } finally {
      finishMutation?.(); busyRef.current = false;
      if (alive.current) {
        if (!review) setValues((current) => Object.fromEntries(Object.entries(current).map(([id, value]) =>
          [id, task.inputs.some((input) => input.id === id && input.type === 'secret') ? '' : value])));
        setStage(''); setMutating(false);
      }
    }
  }

  const output = useMemo(() => snapshot ? { stdout: decodeRunOutput(snapshot, 'stdout.chunk'), stderr: decodeRunOutput(snapshot, 'stderr.chunk') } : null, [snapshot]);
  return <section className="conjur-task-panel" aria-label="Dedicated Conjur action">
    <h3 ref={heading} tabIndex={-1}>{task.name}</h3>
    <span className={'task-risk-badge task-risk-badge--' + task.risk}>{task.risk === 'read' ? 'Read-only' : task.risk === 'destructive' ? 'Destructive · typed approval required' : 'Approval required'}</span>
    <p>{task.description}</p>
    <ExecutionContext fields={[{ label: 'Account', value: account ?? 'Unavailable' }, { label: 'Backend', value: endpoint ?? 'Unavailable' }]} target={plan?.impact?.target} />
    {!allowed && <p role="alert">This action is unavailable until the reviewed Conjur tool and environment are ready.</p>}
    {kinds.length > 0 && <><InventoryStatus state={inventoryState} disabled={busy} onRetry={() => void load()} />
      <p className="field-help">Dropdowns show up to 500 visible IDs per kind. Enter another ID if it is not listed; inventory is not an authorization check.</p>
      <button type="button" className="secondary-button" disabled={busy || inventoryState === 'loading'} onClick={() => void load()}>Refresh dropdowns</button></>}
    <form ref={form} autoComplete="off" onSubmit={(event: FormEvent) => { event.preventDefault(); void perform(mutation); }}>
      <fieldset disabled={busy || !allowed}>
        <div className="conjur-task-fields">{task.inputs.map((input) => {
          const choices = input.type === 'string' ? options(input.id) : null;
          const error = failure?.field === 'values.' + input.id ? failure : undefined;
          if (input.id === 'roles' && input.type === 'string') {
            const roles = [...new Set([...ROLE_KINDS.flatMap((kind) => (inventory?.[kind] ?? []).map((id) => account + ':' + kind + ':' + id)).filter((id) => !id.includes(',')), ...text('roles').split(',').filter(Boolean)])];
            return <div key={input.id}>
              <InputControl input={{ ...input, type: 'multiselect', label: 'Conjur roles — select one or more', validation: { enum: roles } }}
                value={text('roles').split(',').filter(Boolean)} idPrefix={prefix} error={error}
                onChange={(value) => changed(input.id, Array.isArray(value) ? value.join(',') : '')} />
              <details><summary>Enter comma-separated role IDs manually</summary>
                <InputControl input={input} value={values[input.id]} idPrefix={prefix + '-manual'} error={error} onChange={(value) => changed(input.id, value)} />
              </details>
            </div>;
          }
          return choices !== null ? <ConjurIDSelect key={input.id} label={input.label} value={text(input.id)} options={choices}
            id={taskInputDOMID(input.id, prefix)} required={input.required} maxLength={input.validation?.maxLength}
            loading={inventoryState === 'loading'}
            error={error?.message} onChange={(value) => changed(input.id, value)} />
            : <InputControl key={input.id} input={input} value={values[input.id]} idPrefix={prefix} error={error} onChange={(value) => changed(input.id, value)} />;
        })}</div>
        <button type="submit" disabled={busy || !allowed}>{mutation ? 'Review action' : 'Run query'}</button>
      </fieldset>
    </form>
    {plan && <section className="mutation-approval" aria-label="Conjur action approval">
      <h4>Review the exact target and environment</h4>
      <ExecutionContext fields={plan.context!.fields} target={plan.impact!.target} />
      <p>{plan.impact!.effect}</p>
      <p>Scope: {plan.impact!.scope === 'multiple' ? 'Multiple records / relationships' : 'Single declared target'}</p>
      <pre className="invocation-preview">{JSON.stringify([plan.executableName, ...plan.args], null, 2)}</pre>
      <p><strong>Policy branch:</strong> {branch || 'Not applicable'}</p>
      {plan.stdin && <pre className="mutation-stdin">{plan.stdin}</pre>}
      {task.inputs.some((input) => input.type === 'secret') && <p>The secret value is sent through stdin only and is never shown in the review or retained history.</p>}
      {plan.approval!.mode === 'typed' && <label>Type <code>{plan.approval!.requiredText}</code> to confirm this destructive action
        <input aria-label="Typed confirmation" autoComplete="off" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} /></label>}
      <label className="conjur-create-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} />I approve this exact action and environment.</label>
      <button type="button" disabled={busy || !consent || (plan.approval!.mode === 'typed' && confirmation !== plan.approval!.requiredText)} onClick={() => void perform(false)}>Approve and run</button>
    </section>}
    <WorkingStatus id={activityID} active={busy} title={stage || 'Finishing the Conjur action…'} mutation={mutating || pending} track={!mutating && !pending} />
    {failure && <p role="alert">{failure.message} {failure.remediation}</p>}
    {message && <p role="alert">{message}</p>}
    {outcome && <OperationResult result={outcome}>{onOpenRuns && <button type="button" onClick={onOpenRuns}>Open Execution History</button>}</OperationResult>}
    {snapshot && output && <OutputExplorer runId={snapshot.runId} status={snapshot.status} exitCode={snapshot.exitCode} structured={snapshot.structured}
      stdout={output.stdout} stderr={output.stderr} rawOutput={<div className="output-grid">
        <section aria-label="Conjur stdout"><h4>stdout</h4><pre tabIndex={0}>{output.stdout || 'No stdout returned.'}</pre></section>
        <section aria-label="Conjur stderr"><h4>stderr</h4><pre tabIndex={0}>{output.stderr || 'No stderr returned.'}</pre></section>
      </div>} />}
  </section>;
}
