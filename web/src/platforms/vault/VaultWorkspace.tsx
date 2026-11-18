import { useEffect, useState, type FormEvent } from 'react';
import { normalizeError } from '../../api/errors';
import type { Platform, PlatformFeatureID } from '../../api/platforms';
import type { Task } from '../../api/tasks';
import type { ToolDiagnostic } from '../../api/tools';
import {
  fetchVaultAccessLog, fetchVaultContext, listVaultKeys, revealVaultSecret,
  type VaultAccessEntry, type VaultContext, type VaultList, type VaultReveal,
} from './api';

const DISPLAY_SECONDS = 60;
const CLIPBOARD_MS = 30_000;
const failureText: Record<string, string> = {
  session_required: 'The Vault CLI has no valid token. Run `vault login` in a terminal (or set VAULT_TOKEN before starting CLIHarbor), then try again.',
  forbidden: 'Your Vault policy does not permit this read. Listing needs the "list" capability; revealing needs "read".',
  not_found: 'Vault has no visible secret or folder at this location, or the current version was deleted.',
  sealed: 'The Vault server is sealed.',
  unreachable: 'The Vault server could not be reached. Check VAULT_ADDR and your network or TLS settings.',
  not_configured: 'VAULT_ADDR is not a plain http(s) server address, so CLIHarbor will not contact it.',
  busy: 'Another Vault read is still running. Try again in a moment.',
  output_limit_exceeded: 'The response is larger than CLIHarbor displays (16 KiB of values or 1000 keys).',
};
const failureMessage = (code: string) => failureText[code] ?? 'Vault could not return this information. Try again later.';

interface Props {
  platform: Platform;
  tasks: Task[];
  tool?: ToolDiagnostic;
  csrfToken?: string;
  onOpenRuns?: () => void;
  onOpenFeature: (feature: PlatformFeatureID) => void;
  onOpenDiagnostics: () => void;
  onOpenTask: (taskKey: string, prefill?: Record<string, string>) => void;
}

export function VaultWorkspace({ platform, tasks, tool, csrfToken, onOpenDiagnostics, onOpenTask }: Props) {
  const [context, setContext] = useState<VaultContext | null>(null);
  const [mount, setMount] = useState('secret');
  const [listing, setListing] = useState<VaultList | null>(null);
  const [selected, setSelected] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revealed, setRevealed] = useState<VaultReveal | null>(null);
  const [shown, setShown] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [log, setLog] = useState<VaultAccessEntry[]>([]);

  const ready = platform.ready && tool?.status === 'ready' && context?.ready === true && !!csrfToken;
  const vaultTasks = tasks.filter((t) => t.packId === platform.packId && t.toolId === platform.toolId && t.risk === 'read');
  const clear = () => { setRevealed(null); setShown(false); setRemaining(0); };

  useEffect(() => {
    const controller = new AbortController();
    void fetchVaultContext(controller.signal).then(setContext).catch(() => {
      if (!controller.signal.aborted) setContext({ ready: false });
    });
    const hidden = () => { if (document.visibilityState === 'hidden') clear(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', clear);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', clear);
    };
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

  const refreshLog = () => { void fetchVaultAccessLog().then(setLog).catch(() => setLog([])); };

  const list = async (path: string) => {
    const trimmedMount = mount.trim().replace(/^\/+|\/+$/g, '');
    if (!ready || !csrfToken || !trimmedMount || busy) return;
    clear(); setError(''); setNotice(''); setSelected(''); setAcknowledged(false); setBusy(true);
    try {
      const result = await listVaultKeys(csrfToken, { mount: trimmedMount, path });
      setListing(result);
      if (result.failureCode) setError(failureMessage(result.failureCode));
    } catch (caught) {
      setListing(null);
      setError(normalizeError(caught).message);
    } finally {
      setBusy(false);
    }
  };
  const submitMount = (event: FormEvent) => { event.preventDefault(); void list(''); };
  const child = (key: string) => (listing?.path ? listing.path + '/' : '') + key.replace(/\/$/, '');
  const parent = listing?.path.includes('/') ? listing.path.slice(0, listing.path.lastIndexOf('/')) : '';

  const reveal = async () => {
    if (!ready || !csrfToken || !listing || !selected || !acknowledged || busy) return;
    clear(); setError(''); setNotice(''); setBusy(true);
    try {
      const result = await revealVaultSecret(csrfToken, { mount: listing.mount, path: selected });
      // A value that arrives while the page is hidden is discarded, never shown later.
      if (document.visibilityState === 'hidden') setError('The value arrived while this page was hidden, so it was discarded.');
      else if (result.failureCode) setError(failureMessage(result.failureCode));
      else { setRevealed(result); setRemaining(DISPLAY_SECONDS); }
    } catch (caught) {
      setError(normalizeError(caught).message);
    } finally {
      setBusy(false);
      refreshLog();
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('Copied. CLIHarbor clears the clipboard in 30 seconds if it still holds this value. OS clipboard history and clipboard managers are outside CLIHarbor’s control.');
      setTimeout(() => {
        void navigator.clipboard.readText()
          .then((current) => current === value ? navigator.clipboard.writeText('') : undefined)
          .catch(() => undefined);
      }, CLIPBOARD_MS);
    } catch {
      setNotice('Copy failed. The browser did not allow clipboard access.');
    }
  };

  return (
    <div className="terraform-workspace">
      <div className="terraform-context">
        <span><strong>CLI</strong> {tool?.status ?? 'Unavailable'}{tool?.version ? ' · ' + tool.version : ''}</span>
        <span><strong>Server</strong> {context?.address ?? (context ? 'Not usable' : 'Loading…')}</span>
        {context?.namespace && <span><strong>Namespace</strong> {context.namespace}</span>}
        <span><strong>Mode</strong> Read-only · uses the Vault CLI’s existing token</span>
        {tool?.status !== 'ready' && (
          <button type="button" className="secondary-button" onClick={() => onOpenDiagnostics()}>Open Vault diagnostics</button>
        )}
      </div>

      <section className="terraform-section" aria-labelledby="vault-tasks-heading">
        <h3 id="vault-tasks-heading">Server and mount metadata</h3>
        {vaultTasks.length === 0
          ? <p role="status">No Vault tasks are available. Check Vault CLI readiness in diagnostics.</p>
          : <ul>{vaultTasks.map((task) => <li key={task.commandId}>
            <button type="button" className="secondary-button" disabled={tool?.status !== 'ready'}
              onClick={() => onOpenTask(task.packId + '/' + task.commandId)}>{task.name}</button>
            {task.description && <span> {task.description}</span>}
          </li>)}</ul>}
      </section>

      <section className="terraform-section" aria-labelledby="vault-kv-heading">
        <h3 id="vault-kv-heading">KV secrets</h3>
        <p>Browse key names in a KV v1 or v2 mount, then reveal one secret on request. CLIHarbor never asks for, stores, or sends a Vault token; it runs the official <code>vault</code> CLI with the session you already have.</p>
        <form className="terraform-controls" onSubmit={submitMount} autoComplete="off">
          <label>KV mount
            <input value={mount} maxLength={256} required spellCheck={false} disabled={busy}
              onChange={(event) => { setMount(event.target.value); setListing(null); setSelected(''); clear(); }} />
          </label>
          <button type="submit" className="secondary-button" disabled={!ready || busy || !mount.trim()}>List keys</button>
        </form>
        {!ready && context && <p role="status">Vault browsing is unavailable until the Vault CLI is ready and VAULT_ADDR is a plain http(s) address.</p>}
        {listing && !listing.failureCode && <>
          <p role="status">
            <code>{listing.mount}/{listing.path}</code> · {listing.keys.length} key{listing.keys.length === 1 ? '' : 's'}
            {listing.path && <> <button type="button" className="secondary-button" disabled={busy} onClick={() => void list(parent)}>Up one level</button></>}
          </p>
          <div className="terraform-table-wrap">
            <table className="terraform-table">
              <thead><tr><th scope="col">Key</th><th scope="col">Type</th><th scope="col">Action</th></tr></thead>
              <tbody>{listing.keys.map((key) => {
                const folder = key.endsWith('/');
                const path = child(key);
                return <tr key={key}>
                  <td><code>{key}</code></td><td>{folder ? 'Folder' : 'Secret'}</td>
                  <td>{folder
                    ? <button type="button" className="secondary-button" disabled={busy} aria-label={'Open folder ' + key} onClick={() => void list(path)}>Open</button>
                    : <button type="button" className="secondary-button" disabled={busy} aria-pressed={selected === path} aria-label={'Select secret ' + key}
                      onClick={() => { setSelected(path); setAcknowledged(false); clear(); }}>{selected === path ? 'Selected' : 'Select'}</button>}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </>}
        {listing && selected && <fieldset className="terraform-section">
          <legend>Reveal <code>{listing.mount}/{selected}</code> on {context?.address}</legend>
          <label className="conjur-create-consent">
            <input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span>I need this value now. Vault records this read in its audit device, and CLIHarbor records the location and outcome but never the value.</span>
          </label>
          <button type="button" className="primary-button" disabled={busy || !acknowledged} onClick={() => void reveal()}>Reveal secret</button>
        </fieldset>}
        {error && <p role="alert" className="field-error">{error}</p>}
        {revealed && <div className="conjur-secret-reveal" aria-live="polite">
          <p role="status"><code>{revealed.mount}/{revealed.path}</code>{revealed.version > 0 ? ' · version ' + revealed.version : ''} · clears in {remaining} s</p>
          {!shown && <p>Values are hidden. Make sure nobody else can see your screen before showing them.</p>}
          <table className="terraform-table">
            <thead><tr><th scope="col">Field</th><th scope="col">Value</th><th scope="col">Copy</th></tr></thead>
            <tbody>{revealed.fields.map((field) => <tr key={field.key}>
              <td><code>{field.key}</code></td>
              <td>{shown ? <textarea readOnly aria-label={'Value of ' + field.key} value={field.value} rows={Math.min(6, field.value.split('\n').length)} spellCheck={false} /> : '••••••••'}</td>
              <td><button type="button" className="secondary-button" aria-label={'Copy ' + field.key} onClick={() => void copy(field.value)}>Copy</button></td>
            </tr>)}</tbody>
          </table>
          <div className="conjur-secret-reveal-actions">
            <button type="button" className="secondary-button" onClick={() => setShown(!shown)}>{shown ? 'Mask values' : 'Show values'}</button>
            <button type="button" className="secondary-button" onClick={clear}>Hide and clear</button>
          </div>
        </div>}
        {notice && <p role="status">{notice}</p>}
        <p className="field-help">Values are never saved to disk, run history, logs or diagnostics. They clear after {DISPLAY_SECONDS} seconds or when the page is hidden.</p>
        {log.length > 0 && <details>
          <summary>Reveal attempts this session ({log.length})</summary>
          <ul>{log.slice(-10).reverse().map((entry, index) => <li key={index}>
            {entry.at} · <code>{entry.mount}/{entry.path}</code> · {entry.outcome}
          </li>)}</ul>
        </details>}
      </section>
    </div>
  );
}
