import { useEffect, useRef, useState } from 'react';
import { normalizeError, type AppErrorDetail } from '../../api/errors';
import { WorkingStatus } from '../../WorkingStatus';
import {
  executeTerraformStateRemoval, previewTerraformStateRemoval,
  type TerraformStateRemovalPreview, type TerraformStateRemovalResult,
} from './api';

interface Props {
  projectId: string;
  projectName: string;
  stateId: string;
  stateName: string;
  /** The exact resource instance address selected in the inventory, if any. */
  address: string;
  ready: boolean;
  csrfToken?: string;
  /** Called after Terraform ran, so the inventory reloads from disk. */
  onStateChanged: () => void;
}

function failureText(detail: AppErrorDetail): string {
  switch (detail.code) {
    case 'approval_required':
      return 'The state file changed, or this preview expired or was already used. Preview the removal again.';
    case 'run_capacity':
      return 'Another Terraform state operation is already running. Wait for it to finish, then retry.';
    case 'execution_failed':
      return 'Terraform refused the removal (for example, the state is locked by another process). The state file was not changed.';
    case 'tool_changed':
      return 'The Terraform executable changed since CLIHarbor verified it. Relaunch CLIHarbor, then retry.';
    case 'tool_unavailable':
      return 'A ready, version-qualified Terraform CLI is required.';
    case 'audit_unavailable':
      return 'The mutation audit journal is unavailable, so CLIHarbor refused to change state.';
    case 'invalid_input':
      return 'That address is not in the current state snapshot, or the confirmation did not match.';
    default:
      return detail.message;
  }
}

export function TerraformStateRemoval({ projectId, projectName, stateId, stateName, address, ready, csrfToken, onStateChanged }: Props) {
  const [previewFor, setPreviewFor] = useState<{ key: string; preview: TerraformStateRemovalPreview } | null>(null);
  const [confirmFor, setConfirmFor] = useState<{ key: string; text: string }>({ key: '', text: '' });
  const [busy, setBusy] = useState<'preview' | 'execute' | null>(null);
  const [failureFor, setFailureFor] = useState<{ key: string; text: string } | null>(null);
  const [result, setResult] = useState<TerraformStateRemovalResult | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const selectionKey = projectId + '\n' + stateId + '\n' + address;

  // A preview, its confirmation and its error belong only to the exact
  // selection they were made for; switching selection hides them at once
  // and aborts an in-flight dry run.
  // Discard rather than hide, so returning to an earlier selection never
  // resurrects its one-use preview or typed confirmation.
  const [seenKey, setSeenKey] = useState(selectionKey);
  if (seenKey !== selectionKey) {
    setSeenKey(selectionKey);
    setPreviewFor(null);
    setConfirmFor({ key: '', text: '' });
    setFailureFor(null);
  }
  const preview = previewFor?.key === selectionKey ? previewFor.preview : null;
  const confirm = confirmFor.key === selectionKey ? confirmFor.text : '';
  const failure = failureFor?.key === selectionKey ? failureFor.text : '';
  const setPreview = (value: TerraformStateRemovalPreview | null) => setPreviewFor(value ? { key: selectionKey, preview: value } : null);
  const setConfirm = (text: string) => setConfirmFor({ key: selectionKey, text });
  const setFailure = (text: string) => setFailureFor(text ? { key: selectionKey, text } : null);
  useEffect(() => () => previewAbort.current?.abort(), [selectionKey]);

  const canPreview = ready && !!csrfToken && !!address && busy === null;
  const startPreview = () => {
    if (!canPreview || !csrfToken) return;
    const controller = new AbortController();
    previewAbort.current?.abort();
    previewAbort.current = controller;
    setBusy('preview');
    setFailure('');
    setResult(null);
    setConfirm('');
    const key = selectionKey;
    previewTerraformStateRemoval(projectId, stateId, [address], csrfToken, controller.signal).then((value) => {
      if (!controller.signal.aborted) setPreviewFor({ key, preview: value });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailureFor({ key, text: failureText(normalizeError(error).detail) });
    }).finally(() => {
      setBusy((current) => (current === 'preview' ? null : current));
    });
  };

  const confirmed = preview !== null && confirm === preview.stateName;
  const execute = () => {
    if (!preview || !confirmed || !csrfToken || busy !== null) return;
    const used = preview;
    setBusy('execute');
    setFailure('');
    // The preview is one-use on the backend whatever happens next.
    setPreview(null);
    const key = selectionKey;
    executeTerraformStateRemoval(used, confirm, csrfToken).then((value) => {
      setResult(value);
      onStateChanged();
    }).catch((error: unknown) => {
      setFailureFor({ key, text: failureText(normalizeError(error).detail) });
    }).finally(() => {
      setBusy(null);
      setConfirmFor({ key: '', text: '' });
    });
  };

  return (
    <div className="terraform-state-removal">
      <p><code>terraform state rm</code> makes Terraform <strong>forget</strong> resources. The real infrastructure is <strong>not</strong> destroyed. If the resource is still in your configuration, a later <code>apply</code> will try to create it again.</p>
      <dl className="terraform-removal-context">
        <div><dt>Project</dt><dd>{projectName}</dd></div>
        <div><dt>State file</dt><dd><code>{stateName}</code></dd></div>
        <div><dt>Resource</dt><dd>{address ? <code>{address}</code> : 'Select one exact resource on the Resources tab.'}</dd></div>
      </dl>
      {!ready && <p role="note">A ready, version-qualified Terraform CLI is required.</p>}
      <button type="button" className="secondary-button" disabled={!canPreview} onClick={startPreview} aria-busy={busy !== null}>
        {busy === 'preview' ? 'Running dry run…' : busy === 'execute' ? 'Removing from state…' : 'Preview removal'}
      </button>

      {preview && (
        <section className="terraform-removal-preview" aria-labelledby="terraform-removal-preview-heading">
          <h4 id="terraform-removal-preview-heading">Dry run passed: Terraform would remove</h4>
          <ul aria-label="Addresses to remove">
            {preview.addresses.map((item) => <li key={item}><code>{item}</code></li>)}
          </ul>
          <p>From <code>{preview.stateName}</code> (serial {preview.serial}) in {projectName}, using Terraform {preview.terraformVersion}. This preview is single-use and expires at {new Date(preview.expiresAt).toLocaleTimeString()}. If the state file changes before you confirm, CLIHarbor refuses and asks for a new preview.</p>
          <p>CLIHarbor writes and verifies a backup of this exact state file next to it before Terraform starts.</p>
          <label>Type <code>{preview.stateName}</code> to confirm
            <input value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <div className="terraform-removal-actions">
            <button type="button" className="danger-button" disabled={!confirmed || busy !== null} onClick={execute}>
              Forget from state
            </button>
            <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => { setPreview(null); setConfirm(''); }}>
              Cancel
            </button>
          </div>
        </section>
      )}

      <WorkingStatus active={busy !== null} title={busy === 'preview' ? 'Checking state removal…' : 'Removing from state…'}
        detail={busy === 'preview' ? 'Terraform is running the dry run. No state change has been requested.' : 'Keep CLIHarbor running while removal and backup verification finish. Do not submit again.'} />
      {failure && <p role="alert">{failure}</p>}
      {result?.outcome === 'removed' && (
        <div role="status" className="terraform-removal-result">
          <p><strong>Removed from state:</strong> {result.removed.map((item) => <code key={item}>{item}</code>)}. New serial {result.serial}.</p>
          <p>Backup of the previous state: <code>{result.backup}</code>{result.terraformBackup ? <> (Terraform also wrote <code>{result.terraformBackup}</code>)</> : null}. To undo, restore the backup over <code>{result.stateName}</code> while no other Terraform process is running.</p>
        </div>
      )}
      {result?.outcome === 'unverified' && (
        <div role="alert" className="terraform-removal-result">
          <p><strong>Result not verified.</strong> {result.problem}</p>
          <p>Do not retry. Compare <code>{result.stateName}</code> with the backup <code>{result.backup}</code>{result.terraformBackup ? <> and Terraform&apos;s backup <code>{result.terraformBackup}</code></> : null} before running anything else against this state.</p>
        </div>
      )}
    </div>
  );
}
