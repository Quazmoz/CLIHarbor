import { useEffect, useId, useState, type FormEvent } from 'react';
import { normalizeError } from '../../api/errors';
import { ExecutionContext } from '../../OperationResult';
import { fetchSecretAccessLog, listSecretVersions, revealSecret, type SecretAccessEntry, type SecretVersions } from './secretRetrievalApi';

const DISPLAY_SECONDS = 60;
const CLIPBOARD_MS = 30_000;

const failureText: Record<string, string> = {
  forbidden: 'Conjur did not permit this read. Listing versions needs read privilege; revealing a value needs execute privilege.',
  not_found: 'Conjur has no visible variable or retained version with this ID. Conjur keeps only recent versions.',
  context_mismatch: 'The Conjur server or account changed. Review the environment above, then try again.',
  not_configured: 'Conjur is not configured. Open Sign in to connect first.',
  session_required: 'Your Conjur session is missing or expired. Open Sign in, then try again.',
  output_limit_exceeded: 'The value is larger than 16 KiB, so it was not displayed.',
  not_text: 'The value is not text, so it was not displayed.',
};
const failureMessage = (code: string) => failureText[code] ?? 'Conjur could not return this information. Try again later.';

interface Props {
  packId: string; toolId: string; csrfToken: string;
  account?: string; endpoint?: string; available: boolean; active: boolean;
}

/** ADR-043: one explicit, transient reveal of a current or retained previous secret version. */
export function ConjurSecretVersions({ packId, toolId, csrfToken, account, endpoint, available, active }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [variableId, setVariableId] = useState('');
  const [versions, setVersions] = useState<SecretVersions | null>(null);
  const [selected, setSelected] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revealed, setRevealed] = useState<{ version: number; value: string } | null>(null);
  const [shown, setShown] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [log, setLog] = useState<SecretAccessEntry[]>([]);
  const target = account && endpoint ? { packId, toolId, account, applianceUrl: endpoint } : undefined;
  const allowed = available && target !== undefined;
  const trimmed = variableId.trim();

  const clear = () => { setRevealed(null); setShown(false); setRemaining(0); };
  if (!active && revealed) clear();
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') clear(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', clear);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', clear); };
  }, []);
  useEffect(() => {
    if (!revealed) return;
    const expires = Date.now() + DISPLAY_SECONDS * 1000;
    const timer = setInterval(() => {
      const left = Math.ceil((expires - Date.now()) / 1000);
      if (left <= 0) clear(); else setRemaining(left);
    }, 1000);
    return () => clearInterval(timer);
  }, [revealed]);

  const refreshLog = () => { void fetchSecretAccessLog().then(setLog).catch(() => setLog([])); };

  const loadVersions = async (event: FormEvent) => {
    event.preventDefault();
    if (!target || !trimmed || busy) return;
    clear(); setError(''); setNotice(''); setVersions(null); setSelected(0); setBusy(true);
    try {
      const result = await listSecretVersions(csrfToken, target, trimmed);
      if (result.failureCode) setError(failureMessage(result.failureCode));
      else setVersions(result);
    } catch (caught) {
      setError(normalizeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    if (!target || !versions || !acknowledged || busy) return;
    clear(); setError(''); setNotice(''); setBusy(true);
    try {
      const result = await revealSecret(csrfToken, target, versions.variableId, selected);
      // A value that arrives while the page is hidden is discarded, never shown later.
      if (document.visibilityState === 'hidden') setError('The value arrived while this page was hidden, so it was discarded.');
      else if (result.failureCode) setError(failureMessage(result.failureCode));
      else { setRevealed({ version: selected, value: result.value ?? '' }); setRemaining(DISPLAY_SECONDS); }
    } catch (caught) {
      setError(normalizeError(caught).message);
    } finally {
      setBusy(false);
      refreshLog();
    }
  };

  const copy = async () => {
    if (!revealed) return;
    const copied = revealed.value;
    try {
      await navigator.clipboard.writeText(copied);
      setNotice('Copied. CLIHarbor clears the clipboard in 30 seconds if it still holds this value. OS clipboard history and clipboard managers are outside CLIHarbor’s control.');
      setTimeout(() => {
        void navigator.clipboard.readText()
          .then((current) => current === copied ? navigator.clipboard.writeText('') : undefined)
          .catch(() => undefined);
      }, CLIPBOARD_MS);
    } catch {
      setNotice('Copy failed. The browser did not allow clipboard access.');
    }
  };

  const versionLabel = (number: number) => number === 0 ? 'Current value' : 'Version ' + number;

  return (
    <section className="conjur-create-secret" aria-label="Reveal Conjur secret version">
      <button type="button" className="conjur-action" disabled={!allowed} aria-expanded={open}
        onClick={() => { if (open) clear(); else refreshLog(); setOpen(!open); }}>
        <span className="conjur-action-text">
          <strong>View secret versions</strong>
          <span>{allowed
            ? 'List a variable’s retained versions and reveal the current or a previous value once.'
            : 'Unavailable until Conjur is ready and its server and account are known.'}</span>
        </span>
        <span className="task-risk-badge task-risk-badge--change">Reveals value</span>
      </button>
      {open && target && <div className="conjur-create-form">
        <ExecutionContext fields={[{ label: 'Account', value: target.account }, { label: 'Backend', value: target.applianceUrl }]}
          target={trimmed || 'Enter a variable ID'} />
        <form onSubmit={(event) => void loadVersions(event)} autoComplete="off">
          <label className="field"><span>Variable ID</span>
            <input value={variableId} maxLength={2048} required spellCheck={false} disabled={busy} aria-describedby={id + '-id-help'}
              onChange={(event) => { setVariableId(event.target.value); setVersions(null); clear(); }} />
          </label>
          <p id={id + '-id-help'} className="field-help">The ID beneath the account, for example <code>apps/myapp/db/password</code>. Listing versions shows metadata only.</p>
          <button type="submit" className="secondary-button" disabled={busy || !trimmed}>List versions</button>
        </form>
        {versions && (versions.versions.length === 0
          ? <p role="status">This variable has no stored value.</p>
          : <fieldset className="conjur-form-step">
            <legend>Choose a version</legend>
            <label className="field"><span>Version</span>
              <select value={selected} disabled={busy} onChange={(event) => { setSelected(Number(event.target.value)); clear(); }}>
                <option value={0}>Current value</option>
                {versions.versions.map((item, index) => <option key={item.version} value={item.version}>
                  Version {item.version}{index === 0 ? ' (current)' : ''}{item.expiresAt ? ' · expires ' + item.expiresAt : ''}
                </option>)}
              </select>
            </label>
            <label className="conjur-create-consent">
              <input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} />
              <span>I need this value now. Conjur records this read in its audit log, and CLIHarbor records the variable, version and outcome but never the value.</span>
            </label>
            <button type="button" className="primary-button" disabled={busy || !acknowledged} onClick={() => void reveal()}>
              Reveal {versionLabel(selected).toLowerCase()}
            </button>
          </fieldset>)}
        {error && <p role="alert" className="field-error">{error}</p>}
        {revealed && <div className="conjur-secret-reveal" aria-live="polite">
          <p role="status">{versionLabel(revealed.version)} of <code>{versions?.variableId}</code> · clears in {remaining} s</p>
          {shown
            ? <label className="field"><span>Secret value</span>
              <textarea readOnly value={revealed.value} rows={Math.min(8, revealed.value.split('\n').length + 1)} autoComplete="off" spellCheck={false} />
            </label>
            : <p>The value is hidden. Make sure nobody else can see your screen before showing it.</p>}
          <div className="conjur-secret-reveal-actions">
            <button type="button" className="secondary-button" onClick={() => setShown(!shown)}>{shown ? 'Mask value' : 'Show value'}</button>
            <button type="button" className="secondary-button" onClick={() => void copy()}>Copy value</button>
            <button type="button" className="secondary-button" onClick={clear}>Hide and clear</button>
          </div>
        </div>}
        {notice && <p role="status">{notice}</p>}
        <p className="field-help">Values are never saved to disk, run history, logs or diagnostics. They clear after {DISPLAY_SECONDS} seconds, when you leave this tab, or when the page is hidden. OS clipboard history and clipboard managers are outside CLIHarbor’s control.</p>
        {log.length > 0 && <details>
          <summary>Reveal attempts this session ({log.length})</summary>
          <ul>{log.slice(-10).reverse().map((entry, index) => <li key={index}>
            {entry.at} · <code>{entry.variableId}</code> · {versionLabel(entry.version)} · {entry.outcome}
          </li>)}</ul>
        </details>}
      </div>}
    </section>
  );
}
