import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { cancelInvitation, createInvitation, fetchSharingStatus, inspectInvitation, revealPassword, sendPassword,
  type Destination, type SharingStatus } from './api/passwordSharing';
import { normalizeError } from './api/errors';
import { useMutationActivity, useMutationPending } from './OperationActivity';

export function PasswordSharingPage({ csrfToken }: { csrfToken: string }) {
  const [tab, setTab] = useState<'receive' | 'send'>('receive');
  const [snapshot, setSnapshot] = useState<SharingStatus | null>(null);
  const [address, setAddress] = useState('');
  const [mode, setMode] = useState<'app' | 'browser'>('app');
  const [invitation, setInvitation] = useState<{ id: string; value: string } | null>(null);
  const [incoming, setIncoming] = useState('');
  const [outgoing, setOutgoing] = useState('');
  const [password, setPassword] = useState('');
  const [destination, setDestination] = useState<Destination | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [working, setWorking] = useState(false);
  const begin = useMutationActivity();
  const pending = useMutationPending('password-sharing-actions');
  const busy = working || pending;
  const busyRef = useRef(false);
  const alive = useRef(true);
  const read = useRef<AbortController | null>(null);
  const revealedInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const outgoingInput = useRef<HTMLTextAreaElement>(null);
  const invitationInput = useRef<HTMLTextAreaElement>(null);
  const refresh = useCallback(() => {
    if (busyRef.current || document.visibilityState === 'hidden' || read.current && !read.current.signal.aborted) return;
    const controller = new AbortController(); read.current = controller;
    void fetchSharingStatus(controller.signal).then((next) => {
      if (!controller.signal.aborted && alive.current) {
        setSnapshot(next);
        setReadError('');
        if (next.state !== 'waiting') setInvitation(null);
      }
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted && alive.current) { setSnapshot(null); setInvitation(null); setReadError(normalizeError(caught).detail.message); }
    }).finally(() => {
      if (read.current === controller) read.current = null;
    });
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => { if (read.current === null || read.current.signal.aborted) void refresh(); }, 2000);
    const visible = () => {
      if (document.visibilityState === 'hidden') {
        if (revealedInput.current) revealedInput.current.value = '';
        if (passwordInput.current) passwordInput.current.value = '';
        setIncoming(''); setPassword('');
      }
      else void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    const leaving = () => {
      // Clear DOM controls synchronously before a possible back/forward-cache freeze.
      for (const input of [revealedInput.current, passwordInput.current, outgoingInput.current, invitationInput.current]) if (input) input.value = '';
      setIncoming(''); setPassword(''); setOutgoing(''); setInvitation(null); setDestination(null); setConfirmed(false);
    };
    window.addEventListener('pagehide', leaving);
    return () => { alive.current = false; read.current?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pagehide', leaving); };
  }, [refresh]);
  useEffect(() => {
    if (!incoming) return;
    revealedInput.current?.focus();
    const timer = setTimeout(() => setIncoming(''), 60_000);
    return () => clearTimeout(timer);
  }, [incoming]);
  async function act(title: string, action: () => Promise<void>) {
    if (busyRef.current || pending) return;
    busyRef.current = true; read.current?.abort(); setWorking(true); setError(''); setNotice('');
    const finish = begin(title, 'password-sharing-actions');
    try { await action(); }
    catch (caught) {
      if (alive.current) setError(['network_unavailable', 'invalid_response', 'internal_error', 'request_timeout'].includes(normalizeError(caught).detail.code)
        ? 'The operation was not confirmed. Refresh status and check with the other person before arranging another transfer.'
        : normalizeError(caught).detail.message + ' ' + (normalizeError(caught).detail.remediation ?? ''));
    } finally {
      finish(); busyRef.current = false;
      if (alive.current) { setWorking(false); void refresh(); }
    }
  }
  const active = snapshot?.state === 'waiting' || snapshot?.state === 'received';
  const selectedAddress = snapshot?.addresses.includes(address) ? address : snapshot?.addresses[0] ?? '';
  const currentInvitation = invitation && invitation.id === snapshot?.id && snapshot?.state === 'waiting' ? invitation.value : '';
  const changeTab = (next: 'receive' | 'send') => {
    if (busy) return;
    setTab(next); setIncoming(''); setOutgoing(''); setPassword(''); setDestination(null); setConfirmed(false); setNotice(''); setError('');
  };
  return <section className="password-sharing" aria-labelledby="password-sharing-heading">
    <div className="route-heading"><h2 id="password-sharing-heading">Password sharing</h2>
      <p>Transfer one password over your local network. Invitations expire after five minutes; passwords are kept in memory and excluded from execution history.</p></div>
    <div role="tablist" aria-label="Password sharing" className="output-tabs" onKeyDown={(event) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const next = event.key === 'Home' ? 'receive' : event.key === 'End' ? 'send' : tab === 'receive' ? 'send' : 'receive';
        changeTab(next); document.getElementById('sharing-tab-' + next)?.focus();
      }
    }}>
      {(['receive', 'send'] as const).map((name) => <button key={name} id={'sharing-tab-' + name} type="button" role="tab"
        aria-selected={tab === name} aria-controls={'sharing-panel-' + name} tabIndex={tab === name ? 0 : -1}
        disabled={busy} onClick={() => changeTab(name)}>{name === 'receive' ? 'Receive a password' : 'Send from CLIHarbor'}</button>)}
    </div>
    <div className="panel password-sharing-panel" role="tabpanel" id={'sharing-panel-' + tab} aria-labelledby={'sharing-tab-' + tab}>
      {tab === 'receive' ? <>
        <h3>1. Create an invitation</h3>
        <p>Select an address the sender can reach. The password receiver opens for five minutes when you create an invitation.</p>
        <form onSubmit={(event) => {
          event.preventDefault();
          void act('Creating password invitation…', async () => {
            const next = await createInvitation(csrfToken, selectedAddress, mode);
            if (alive.current) { setSnapshot(next.status); setInvitation({ id: next.status.id!, value: next.invitation }); }
          });
        }}>
          <label>Your LAN address<select value={selectedAddress} disabled={busy || active} onChange={(e) => setAddress(e.target.value)}>
            {snapshot?.addresses.length ? snapshot.addresses.map((ip) => <option key={ip}>{ip}</option>) : <option value="">No private LAN address available</option>}
          </select></label>
          <label>Sender uses<select value={mode} disabled={busy || active} onChange={(e) => setMode(e.target.value as 'app' | 'browser')}>
            <option value="app">CLIHarbor</option>
            <option value="browser" disabled={!snapshot?.browserAvailable}>Web browser</option>
          </select></label>
          {!snapshot?.browserAvailable && <p className="field-help">Browser sending needs an HTTPS certificate configured at launch. It must cover this IP address and be trusted on the sender’s device. See Network setup and privacy below.</p>}
          {mode === 'browser' && <p className="field-help">The sender must have a trusted HTTPS connection. Never bypass certificate warnings. A certificate covering a different IP cannot be used.</p>}
          <button type="submit" disabled={busy || active || !selectedAddress || mode === 'browser' && !snapshot?.browserAvailable}>Create five-minute invitation</button>
        </form>
        {snapshot === null && <p role="status">Reading password-sharing status…</p>}
        {active && <section aria-label="Current password invitation">
          <h3>2. Share and wait</h3>
          <dl><div><dt>Receiving address</dt><dd>{snapshot.origin}</dd></div><div><dt>Certificate fingerprint · SHA-256</dt><dd><code>{snapshot.fingerprint}</code></dd></div>
            <div><dt>Expires</dt><dd><time dateTime={snapshot.expiresAt}>{new Date(snapshot.expiresAt!).toLocaleTimeString()}</time></dd></div></dl>
          {currentInvitation ? <><label>One-use invitation<textarea ref={invitationInput} readOnly value={currentInvitation} rows={4} autoComplete="off" spellCheck={false} /></label>
            <button type="button" className="secondary-button" onClick={() => { void navigator.clipboard.writeText(currentInvitation).then(() => setNotice('Invitation copied. Share it over a trusted channel.'), () => setError('The invitation could not be copied. Select and copy it manually.')); }}>Copy invitation</button></>
            : snapshot.state === 'waiting' && <p>This tab no longer has the invitation link. Use the copy you already shared, or cancel this invitation before creating another.</p>}
          <p>Verify the receiving address and fingerprint with the sender through a trusted channel. Anyone with the invitation can submit; it does not prove their identity.</p>
          <p role="status">{snapshot.state === 'waiting' ? 'Waiting for one password…' : 'A password was received. Confirm with the sender, then reveal it once.'}</p>
          {snapshot.state === 'received' && <button type="button" disabled={busy} onClick={() => void act('Revealing received password…', async () => {
            const value = await revealPassword(csrfToken, snapshot.id!);
            if (alive.current && document.visibilityState !== 'hidden') setIncoming(value);
          })}>Reveal received password once</button>}
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void act('Cancelling password invitation…', async () => {
            await cancelInvitation(csrfToken, snapshot.id!); if (alive.current) { setInvitation(null); setIncoming(''); }
          })}>Cancel invitation and discard password</button>
        </section>}
        {snapshot && !active && snapshot.state !== 'idle' && <p role="status">{snapshot.state === 'revealed' ? 'The received password has been consumed. It cannot be revealed again.' : 'Invitation ' + snapshot.state + '. Create a new invitation if you need another transfer.'}</p>}
        {incoming && <section aria-label="Received password"><h3>3. Use the received password</h3>
          <label>Received password<input ref={revealedInput} readOnly value={incoming} autoComplete="off" spellCheck={false} /></label>
          <p>Clears from this page after one minute or when you leave or hide it. Clipboard managers may retain a copied value.</p>
          <button type="button" onClick={() => { void navigator.clipboard.writeText(incoming).then(() => setNotice('Password copied. Clear your clipboard when finished.'), () => setError('The password could not be copied.')); }}>Copy received password</button>
          <button type="button" className="secondary-button" onClick={() => setIncoming('')}>Hide and clear password</button>
        </section>}
      </> : <>
        <h3>Send to another computer</h3><p>The recipient must use CLIHarbor. Ask them for a fresh invitation, then verify their receiving address and certificate fingerprint before entering a password.</p>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void act('Checking password invitation…', async () => {
          const next = await inspectInvitation(csrfToken, outgoing); if (alive.current) { setDestination(next); setConfirmed(false); }
        }); }}>
          <label>Recipient’s invitation<textarea ref={outgoingInput} required maxLength={1024} rows={4} value={outgoing} disabled={busy} autoComplete="off" spellCheck={false}
            onChange={(e) => { setOutgoing(e.target.value); setDestination(null); setConfirmed(false); setPassword(''); }} /></label>
          <button type="submit" disabled={busy || !outgoing}>Check receiving address</button>
        </form>
        {destination && <form onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed || !password || new TextEncoder().encode(password).length > 4096 || /[\p{Cc}\p{Cf}]/u.test(password)) return;
          void act('Sending password…', async () => {
            const value = password; const link = outgoing;
            setPassword(''); setOutgoing(''); setDestination(null); setConfirmed(false);
            await sendPassword(csrfToken, link, value);
            if (alive.current) setNotice('Password delivered. The recipient can reveal it once in CLIHarbor.');
          });
        }}>
          <dl><div><dt>Receiving address</dt><dd>{destination.origin}</dd></div><div><dt>Certificate fingerprint · SHA-256</dt><dd><code>{destination.fingerprint}</code></dd></div></dl>
          <label className="sharing-consent"><input type="checkbox" required checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />I verified this address and fingerprint with the recipient.</label>
          <label>Password to send<input ref={passwordInput} type="password" required maxLength={4096} value={password} disabled={busy} autoComplete="off" spellCheck={false} aria-describedby="sharing-password-help" onChange={(e) => setPassword(e.target.value)} /></label>
          <p id="sharing-password-help">One line, up to 4,096 UTF-8 bytes, without control or invisible formatting characters. The password and invitation clear on submission.</p>
          <button type="submit" disabled={busy || !confirmed || !password || new TextEncoder().encode(password).length > 4096 || /[\p{Cc}\p{Cf}]/u.test(password)}>Send password once</button>
        </form>}
      </>}
      <div id="password-sharing-actions" tabIndex={-1} aria-live="polite" role="status">{busy ? 'Working… Keep this page open; do not submit again.' : notice}</div>
      {error && <p role="alert">{error}</p>}
      {readError && <p role="alert">{readError}</p>}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { setError(''); void refresh(); }}>Refresh status</button>
    </div>
    <details className="sharing-limits"><summary>Network setup and privacy</summary>
      <p>Both computers must be able to reach the selected private IPv4 address. Firewall or network isolation may block it; CLIHarbor does not change those controls. No internet relay is used.</p>
      <p>For browser senders, launch with <code>--share-tls-cert</code> and <code>--share-tls-key</code> pointing to an organization-approved certificate/key. The certificate needs the LAN IP in its subject alternative names and must be trusted on the sender’s device.</p>
      <p>No passwords are saved to disk, preferences, logs or run history by this feature. Memory clearing is best effort; OS swap, extensions, screenshots and clipboard history can retain copies. Saving into Conjur is a separate approved action.</p>
    </details>
  </section>;
}
