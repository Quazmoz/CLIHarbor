import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createRun, previewRun, type RunPreview } from '../../api/runs';
import { ExecutionContext, OperationResult, type OperationOutcome } from '../../OperationResult';
import { useMutationActivity, useMutationPending } from '../../OperationActivity';
import { WorkingStatus } from '../../WorkingStatus';
import { approvalsFresh, completedRun, matchingContext, PACK, safeMessage, successful, TOOL } from './conjurRuns';
import { revealSecret, type SecretTarget } from './secretRetrievalApi';

export const RESTORE_ACTIVITY = 'conjur-secret-restore-progress';
const REVIEW_MS = 60_000;

/** Compose the existing context-bound read and approved write-only CLI task. */
export function ConjurRestoreSecretVersion({ csrfToken, target, variableId, version, readAcknowledged, onRead, onOpenRuns }: {
  csrfToken: string; target: SecretTarget; variableId: string; version: number; readAcknowledged: boolean;
  onRead?: () => void; onOpenRuns?: () => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const secret = useRef<string | null>(null);
  const expires = useRef(0);
  const retention = useRef<number | undefined>(undefined);
  const submitting = useRef(false);
  const [plan, setPlan] = useState<RunPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<OperationOutcome | null>(null);
  const beginMutation = useMutationActivity();
  const pending = useMutationPending(RESTORE_ACTIVITY);
  const busy = stage !== '' || pending;
  // Retrieval always qualifies the ID. Use those same bytes for the write so
  // an ID containing colons cannot select a different account or resource.
  const fullID = target.account + ':variable:' + variableId;

  const clear = useCallback(() => {
    generation.current += 1;
    window.clearTimeout(retention.current);
    secret.current = null;
    setPlan(null);
    setConsent(false);
  }, []);
  useEffect(() => {
    alive.current = true;
    const hidden = () => { if (document.visibilityState === 'hidden') clear(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', clear);
    return () => {
      alive.current = false;
      generation.current += 1;
      secret.current = null;
      window.clearTimeout(retention.current);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', clear);
    };
  }, [clear]);
  useEffect(() => {
    if (!plan) return;
    heading.current?.focus();
  }, [plan]);

  async function review() {
    if (submitting.current || pending || !readAcknowledged || document.visibilityState === 'hidden' ||
      target.packId !== PACK || target.toolId !== TOOL || !Number.isSafeInteger(version) || version < 1) return;
    clear();
    const attempt = generation.current;
    const current = () => alive.current && generation.current === attempt && document.visibilityState !== 'hidden';
    submitting.current = true;
    setStage('Reading the selected version and preparing restore approval…');
    setError(''); setOutcome(null);
    try {
      const source = await revealSecret(csrfToken, target, variableId, version);
      if (!current()) return;
      if (source.failureCode || source.value === undefined) {
        throw new Error('Conjur could not read the selected retained version. No restore was started. Check the target, session and execute permission.');
      }
      secret.current = source.value;
      expires.current = Date.now() + REVIEW_MS;
      retention.current = window.setTimeout(() => {
        clear();
        setError('Conjur restore review expired. Review the selected version again.');
        reviewButton.current?.focus();
      }, REVIEW_MS);
      const preparing = previewRun(csrfToken, { packId: PACK, commandId: 'secret-set-value',
        values: { 'variable-id': fullID, value: source.value } });
      source.value = undefined;
      const next = await preparing;
      if (!current()) return;
      if (next.packId !== PACK || next.toolId !== TOOL || next.commandId !== 'secret-set-value' || next.risk !== 'change' ||
        next.approval?.mode !== 'explicit' || next.impact?.target !== fullID || next.impact.scope !== 'single' ||
        next.stdin !== undefined || !matchingContext(next, target.account, target.applianceUrl) || !approvalsFresh([next])) {
        throw new Error('Conjur did not return a matching restore approval. Nothing was written. Review the current environment again.');
      }
      setPlan(next);
    } catch (caught) {
      if (current()) { clear(); setError(safeMessage(caught)); }
    } finally {
      onRead?.();
      submitting.current = false;
      if (alive.current) setStage('');
    }
  }

  async function restore() {
    if (submitting.current || pending || !readAcknowledged || !plan?.approval || !consent || secret.current === null) return;
    if (document.visibilityState === 'hidden' || Date.now() >= expires.current || !approvalsFresh([plan])) {
      clear(); setError('Conjur restore approval expired or the page was hidden. Review the selected version again.'); return;
    }
    submitting.current = true;
    window.clearTimeout(retention.current);
    setStage('Restoring the approved version as a new current value…');
    setError(''); setPlan(null); setConsent(false);
    const finish = beginMutation('Restoring a previous Conjur value…', RESTORE_ACTIVITY);
    try {
      const accepting = createRun(csrfToken, { packId: PACK, commandId: 'secret-set-value',
        values: { 'variable-id': fullID, value: secret.current }, approval: { id: plan.approval.id } });
      secret.current = null;
      const completed = await completedRun(await accepting);
      if (!alive.current) return;
      const confirmed = successful(completed, 'secret-set-value');
      setOutcome({ title: confirmed ? 'Restore command completed' : 'Restore is unconfirmed',
        tone: confirmed ? 'success' : 'warning', target: fullID,
        steps: [{ label: 'Restore version ' + version + ' as a new current value', state: confirmed ? 'done' : 'unknown' }],
        next: confirmed ? 'List versions again to refresh the history and verify consuming systems. Their credentials were not reset.'
          : 'Check Execution History and the Conjur variable before another attempt. Nothing is automatically retried.' });
    } catch {
      if (alive.current) setOutcome({ title: 'Restore is unconfirmed', tone: 'warning', target: fullID,
        steps: [{ label: 'Restore version ' + version, state: 'unknown' }],
        next: 'The request may have been accepted. Check Execution History and the Conjur variable before retrying.' });
    } finally {
      secret.current = null;
      submitting.current = false;
      finish();
      if (alive.current) setStage('');
    }
  }

  return <section className="mutation-approval" aria-label="Restore previous Conjur version">
    <h4>Restore version {version}</h4>
    <span className="task-risk-badge task-risk-badge--change">Change · approval required</span>
    <p>This writes version {version} as a new current Conjur value, replacing the value current when the command runs. It does not reset the credential in its source system. Conjur execute and update permissions are required. Acknowledge the read above before reviewing; review reads the value without displaying it.</p>
    <button ref={reviewButton} type="button" className="secondary-button" disabled={busy || !readAcknowledged} onClick={() => void review()}>Review restore of version {version}</button>
    {plan && <div>
      <h5 ref={heading} tabIndex={-1}>Approve restoring version {version}</h5>
      <ExecutionContext fields={plan.context!.fields} target={plan.impact!.target} />
      <p>{plan.impact!.effect}</p>
      <pre className="invocation-preview">{JSON.stringify([plan.executableName, ...plan.args], null, 2)}</pre>
      <p>The value stays hidden and clears from this review within 60 seconds, when the page is hidden, or when you change the selection. The existing write limits apply; the value is never trimmed or truncated.</p>
      <label className="conjur-create-consent" htmlFor={id}>
        <input id={id} type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} />
        I approve restoring version {version} for this exact variable and environment.
      </label>
      <button type="button" className="primary-button" disabled={busy || !consent} onClick={() => void restore()}>Restore version {version}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { clear(); reviewButton.current?.focus(); }}>Cancel restore review</button>
    </div>}
    <WorkingStatus id={RESTORE_ACTIVITY} active={busy} title={stage || 'Waiting for the previous restore to finish…'}
      mutation={pending} track={!pending} />
    {error && <p role="alert">{error}</p>}
    {outcome && <OperationResult result={outcome}>
      {onOpenRuns && <button type="button" onClick={onOpenRuns}>Open Execution History</button>}
    </OperationResult>}
  </section>;
}
