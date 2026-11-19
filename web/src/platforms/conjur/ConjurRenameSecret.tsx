import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Task } from '../../api/tasks';
import { ExecutionContext } from '../../OperationResult';
import { useMutationActivity, useMutationPending } from '../../OperationActivity';
import { WorkingStatus } from '../../WorkingStatus';
import { PACK, TOOL, safeMessage } from './conjurRuns';
import { renameSecret, type RenameRequest, type RenameResult } from './secretRenameApi';

interface Props {
  tasks: Task[];
  csrfToken: string;
  account?: string;
  endpoint?: string;
  onOpenRuns?: () => void;
}

const PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/u;
const failures: Record<string, string> = {
  destination_exists: 'The new ID already exists. It will not be overwritten.',
  different_policy: 'The new ID must remain inside the original defining policy.',
  source_changed: 'The original changed since review. Deletion is blocked.',
  destination_changed: 'The copy changed since verification. Deletion is blocked.',
  verification_failed: 'The copied metadata, grants or retained values do not match. Deletion is blocked.',
  unsupported_grant: 'A grant or its originating policy cannot be reproduced by the approved tasks.',
  unsupported_dynamic: 'Dynamic-secret variables cannot be renamed by this static-history migration.',
  unsupported_annotation: 'An annotation cannot be safely reproduced. Rotation/dynamic annotations and annotations owned by another policy are not supported.',
  unsupported_history: 'The complete retained history could not be read within the 100-version limit.',
  unsupported_value: 'A retained value is empty, whitespace-only, binary or exceeds the approved 4,096-character write limit.',
  unsupported_metadata: 'The owner or complete metadata could not be safely understood within the supported limits.',
  approval_required: 'The approval expired, was consumed, or does not match this target. Do not retry a write blindly.',
  approval_pending: 'Another rename approval is outstanding. Return to that workflow, discard it, or let it expire.',
  confirmation_required: 'The typed deletion confirmation does not match the original ID.',
  forbidden: 'Conjur denied access. An unreadable value or permission is not treated as absent.',
  write_unconfirmed: 'A write was not confirmed. Inspect Execution History and both variables; do not repeat the copy.',
  deletion_unconfirmed: 'Deletion could not be verified. Inspect both variables and Execution History before taking another action.',
};

export function ConjurRenameSecret({ tasks, csrfToken, account, endpoint, onOpenRuns }: Props) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [consent, setConsent] = useState(false);
  const [approved, setApproved] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [result, setResult] = useState<RenameResult | null>(null);
  const [error, setError] = useState('');
  const [stage, setStage] = useState('');
  const beginMutation = useMutationActivity();
  const pending = useMutationPending('conjur-rename-progress');
  const busy = stage !== '' || pending;
  const busyRef = useRef(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => { if (result) heading.current?.focus(); }, [result]);
  const allowed = Boolean(account && endpoint) && ['secret-create-owned', 'secret-annotate-owned', 'secret-permit', 'secret-set-value', 'secret-delete']
    .every((id) => tasks.some((task) => task.packId === PACK && task.toolId === TOOL && task.commandId === id &&
      task.risk === (id === 'secret-delete' ? 'destructive' : 'change')));
  const reviewed = result?.status === 'reviewed';
  const copied = result?.status === 'copied';
  const locked = reviewed || copied;
  const valid = PATH.test(source) && PATH.test(destination) && source !== destination;

  async function perform(action: 'review' | 'copy' | 'delete' | 'discard') {
    if (busyRef.current || pending || !allowed || !account || !endpoint || !valid) return;
    busyRef.current = true;
    const operation = new AbortController();
    controller.current = operation;
    setError('');
    setApproved(false);
    setConfirmation('');
    setStage(action === 'review' ? 'Reading all retained versions and checking the copy plan'
      : action === 'copy' ? 'Copying and verifying every retained value, owner, annotation and grant'
        : action === 'delete' ? 'Rechecking both variables before deleting the original' : 'Discarding rename approval');
    const finish = beginMutation('Conjur secret rename', 'conjur-rename-progress');
    const request: RenameRequest = {
      target: { packId: PACK, toolId: TOOL, account, applianceUrl: endpoint, variableId: source },
      destination, ...(action === 'review' ? {} : { approvalId: result?.approvalId }),
      ...(action === 'delete' ? { confirmation } : {}),
    };
    try {
      const response = await renameSecret(action, csrfToken, request, operation.signal);
      if (!alive.current) return;
      if (response.status === 'discarded') {
        setResult(null);
      } else {
        setResult(response);
        if (response.failureCode) {
          setError((failures[response.failureCode] ?? 'The operation stopped (' + response.failureCode + '). Inspect both variables and Execution History before continuing.') +
            ' The rename workflow will not automatically retry or roll back.');
        }
      }
    } catch (caught) {
      if (alive.current) {
        setResult(null);
        setError(safeMessage(caught) + ' Outcome may be unknown. Inspect Execution History and both variables; do not repeat a write blindly.');
      }
    } finally {
      finish();
      controller.current = null;
      busyRef.current = false;
      if (alive.current) setStage('');
    }
  }

  function review(event: FormEvent) {
    event.preventDefault();
    if (consent && !locked) void perform('review');
  }

  return (
    <section className="conjur-create-secret" aria-label="Rename Conjur secret">
      <button type="button" className="conjur-action conjur-action--change" disabled={!allowed || busy || locked}
        aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="conjur-action-text"><strong>Rename secret</strong>
          <span>Copy all retained values and matching access first; delete the original only after a separate confirmation.</span></span>
        <span className="task-risk-badge task-risk-badge--change">Staged approval</span>
      </button>
      {open && <form className="conjur-create-form" onSubmit={review} autoComplete="off">
        <ExecutionContext fields={[{ label: 'Account', value: account ?? 'Unavailable' }, { label: 'Backend', value: endpoint ?? 'Unavailable' }]}
          target={source || 'Choose a variable'} />
        <p>This creates a different Conjur resource ID in the same defining policy. Update application references and your policy repository before cutover. No automatic rollback or alias is created.</p>
        <p role="note">Pause external writes, rotation and policy changes throughout copying and cutover. Conjur has no atomic rename or conditional delete; a final read check cannot lock out another writer.</p>
        <p>Every retained value is recreated oldest first. Version numbers, timestamps and expiration metadata are not preserved. Values stay in the backend, outside browser state and run history.</p>
        <label>Original variable ID
          <input required maxLength={2048} value={source} disabled={busy || locked} spellCheck={false}
            onChange={(event) => { setSource(event.target.value); setResult(null); setConsent(false); }} />
        </label>
        <label>New variable ID
          <input required maxLength={2048} value={destination} disabled={busy || locked} spellCheck={false}
            onChange={(event) => { setDestination(event.target.value); setResult(null); setConsent(false); }} />
        </label>
        <p className="field-help">Enter full account-relative paths, such as apps/database/password. The new ID must not exist. Simple slash-separated names using letters, numbers, underscores, dots and hyphens are supported.</p>
        {!locked && result?.status !== 'deleted' && <>
          <label className="approval-checkbox"><input type="checkbox" checked={consent} disabled={busy}
            onChange={(event) => setConsent(event.target.checked)} />
            I authorize backend reads of every retained version and will pause external changes for this migration.
          </label>
          <button type="submit" className="primary-button" disabled={busy || !valid || !consent}>Review rename</button>
        </>}
        {result && <div>
          <h4 ref={heading} tabIndex={-1}>{reviewed ? 'Review secret rename' : copied ? 'Copy verified; original retained'
            : result.status === 'deleted' ? 'Rename completed' : 'Rename needs inspection'}</h4>
          {result.owner && <p>Owner: <code>{result.owner}</code> · Policy: <code>{result.policy}</code></p>}
          <p>{result.versions.length} retained versions · {result.grants} explicit grants · {result.annotations} annotations</p>
          {result.versions.length > 0 && <ul aria-label="Version mapping">
            {result.versions.map((version) => <li key={version.source}>Original version {version.source} → {version.destination ? 'new version ' + version.destination : 'assigned during copy'}</li>)}
          </ul>}
          {result.expiresAt && <p>Approval expires: {result.expiresAt}</p>}
          {reviewed && <>
            <label className="approval-checkbox"><input type="checkbox" checked={approved} disabled={busy} onChange={(event) => setApproved(event.target.checked)} />
              I approve copying all retained values, the owner, annotations and every explicit grant with its originating policy.
            </label>
            <button type="button" className="primary-button" disabled={busy || !approved} onClick={() => void perform('copy')}>Copy and verify all versions</button>
          </>}
          {copied && <>
            <p>Switch consumers to <code>{destination}</code> and update policy source files now. The original still exists. Deletion will recheck both variables and permanently remove the original history and grants.</p>
            <label>Type DELETE: {source}
              <input value={confirmation} disabled={busy} autoComplete="off" spellCheck={false}
                onChange={(event) => setConfirmation(event.target.value)} />
            </label>
            <button type="button" className="primary-button" disabled={busy || confirmation !== 'DELETE: ' + source}
              onClick={() => void perform('delete')}>Delete original after verification</button>
          </>}
          {locked && <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform('discard')}>
            {copied ? 'Keep both; discard deletion approval' : 'Cancel review'}
          </button>}
        </div>}
        {stage && <WorkingStatus active track={false} id="conjur-rename-progress" title="Renaming Conjur secret" detail={stage} />}
        {error && <p role="alert">{error}</p>}
        {onOpenRuns && <button type="button" className="secondary-button" onClick={onOpenRuns}>Open Execution History</button>}
      </form>}
    </section>
  );
}
