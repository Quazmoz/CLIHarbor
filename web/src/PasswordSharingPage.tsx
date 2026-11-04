import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { acceptablePassword, cancelInvitation, createInvitation, fetchSharingStatus, inspectInvitation, MAX_PASSWORD_BYTES, revealPassword, sendPassword,
  type Destination, type SharingStatus } from './api/passwordSharing';
import { normalizeError } from './api/errors';
import { useMutationActivity, useMutationPending } from './OperationActivity';

// People compare these aloud, so show the same host:port the browser sender sees
// and break the fingerprint into short groups.
const hostOf = (origin = '') => origin.replace(/^https:\/\//u, '');
const grouped = (fingerprint = '') => fingerprint.match(/.{1,4}/gu)?.join(' ') ?? '';
function timeLeft(expiresAt: string | undefined, now: number) {
  const left = Date.parse(expiresAt ?? '') - now;
  return !(left > 0) ? 'expiring now' : left <= 60_000 ? 'less than a minute left' : 'about ' + Math.ceil(left / 60_000) + ' minutes left';
}

export function PasswordSharingPage({ csrfToken }: { csrfToken: string }) {
  const [tab, setTab] = useState<'receive' | 'send'>('receive');
  const [snapshot, setSnapshot] = useState<SharingStatus | null>(null);
  const [address, setAddress] = useState('');
  const [mode, setMode] = useState<'app' | 'browser'>('app');
  const [invitation, setInvitation] = useState<{ id: string; value: string } | null>(null);
  const [incoming, setIncoming] = useState('');
  const [outgoing, setOutgoing] = useState('');
  const [password, setPassword] = useState('');
  const [multiline, setMultiline] = useState(false);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [working, setWorking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const begin = useMutationActivity();
  const pending = useMutationPending('password-sharing-actions');
  const busy = working || pending;
  const busyRef = useRef(false);
  const alive = useRef(true);
  const read = useRef<AbortController | null>(null);
  // Each is either a single-line input or a multi-line text area; only value and focus are used.
  const revealedInput = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const passwordInput = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
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
    const timer = setInterval(() => { setNow(Date.now()); if (read.current === null || read.current.signal.aborted) void refresh(); }, 2000);
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
      <p>Move one password directly between two computers on your local network, without email or chat. The recipient creates a five-minute invitation; the sender uses it once. Passwords stay in memory only and never enter run history.</p></div>
    <div role="tablist" aria-label="Password sharing" className="output-tabs" onKeyDown={(event) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const next = event.key === 'Home' ? 'receive' : event.key === 'End' ? 'send' : tab === 'receive' ? 'send' : 'receive';
        changeTab(next); document.getElementById('sharing-tab-' + next)?.focus();
      }
    }}>
      {(['receive', 'send'] as const).map((name) => <button key={name} id={'sharing-tab-' + name} type="button" role="tab"
        aria-selected={tab === name} aria-controls={'sharing-panel-' + name} tabIndex={tab === name ? 0 : -1}
        disabled={busy} onClick={() => changeTab(name)}>{name === 'receive' ? 'Receive a password' : 'Send a password'}</button>)}
    </div>
    <div className="panel password-sharing-panel" role="tabpanel" id={'sharing-panel-' + tab} aria-labelledby={'sharing-tab-' + tab}>
      {tab === 'receive' ? <>
        <h3>1. Create an invitation</h3>
        <p>Choose the address of this computer that the sender can reach. A private receiver opens on that address for five minutes, only after you create the invitation.</p>
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
          <label>How will the sender send it?<select value={mode} disabled={busy || active} onChange={(e) => setMode(e.target.value as 'app' | 'browser')}>
            <option value="app">From their CLIHarbor</option>
            <option value="browser" disabled={!snapshot?.browserAvailable}>From a web browser</option>
          </select></label>
          <p className="field-help">A browser sender does not need CLIHarbor.</p>
          {!snapshot?.browserAvailable && <p className="field-help">Browser sending needs an HTTPS certificate configured at launch. It must cover this IP address and be trusted on the sender’s device. See Network setup and privacy below.</p>}
          {mode === 'browser' && <p className="field-help">The sender must have a trusted HTTPS connection. Never bypass certificate warnings. A certificate covering a different IP cannot be used.</p>}
          <button type="submit" disabled={busy || active || !selectedAddress || mode === 'browser' && !snapshot?.browserAvailable}>Create five-minute invitation</button>
        </form>
        {snapshot === null && <p role="status">Reading password-sharing status…</p>}
        {active && <section aria-label="Current password invitation">
          <h3>2. Share and wait</h3>
          <p>{snapshot.mode === 'browser'
            ? 'Send the invitation link to the sender. They open it in a browser that trusts this computer’s certificate, then enter the password.'
            : 'Send the invitation to the sender. They paste it into Password sharing → Send a password in their CLIHarbor.'}</p>
          <dl><div><dt>Receiving address</dt><dd><code>{hostOf(snapshot.origin)}</code></dd></div>
            {snapshot.mode !== 'browser' && <div><dt>Certificate fingerprint (SHA-256)</dt><dd><code>{grouped(snapshot.fingerprint)}</code></dd></div>}
            <div><dt>Expires</dt><dd><time dateTime={snapshot.expiresAt}>{new Date(snapshot.expiresAt!).toLocaleTimeString()}</time> · {timeLeft(snapshot.expiresAt, now)}</dd></div></dl>
          {currentInvitation ? <><label>One-use invitation<textarea ref={invitationInput} readOnly value={currentInvitation} rows={4} autoComplete="off" spellCheck={false} /></label>
            <button type="button" className="secondary-button" onClick={() => { void navigator.clipboard.writeText(currentInvitation).then(() => setNotice('Invitation copied. Share it over a trusted channel.'), () => setError('The invitation could not be copied. Select and copy it manually.')); }}>Copy invitation</button></>
            : snapshot.state === 'waiting' && <p>This tab no longer has the invitation link. Use the copy you already shared, or cancel this invitation before creating another.</p>}
          <p>{snapshot.mode === 'browser' ? 'Read the receiving address to the sender' : 'Read the receiving address and fingerprint to the sender'} by phone, in person or another trusted channel. Anyone holding the invitation can submit a password, so confirm with the sender before you use what arrives.</p>
          <p role="status">{snapshot.state === 'waiting' ? 'Waiting for one password…' : 'A password was received. Confirm with the sender, then reveal it once.'}</p>
          {snapshot.state === 'received' && <button type="button" disabled={busy} onClick={() => void act('Revealing received password…', async () => {
            const value = await revealPassword(csrfToken, snapshot.id!);
            if (!alive.current) return;
            // Never render a secret into a hidden page; say so instead of dropping it silently.
            if (document.visibilityState === 'hidden') setError('The password was revealed while this page was hidden, so it was discarded. Ask the sender for a new transfer.');
            else setIncoming(value);
          })}>Reveal received password once</button>}
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void act('Cancelling password invitation…', async () => {
            await cancelInvitation(csrfToken, snapshot.id!); if (alive.current) { setInvitation(null); setIncoming(''); }
          })}>Cancel invitation and discard password</button>
        </section>}
        {snapshot && !active && snapshot.state !== 'idle' && <p role="status">{snapshot.state === 'revealed' ? 'The received password has been consumed. It cannot be revealed again.' : 'Invitation ' + snapshot.state + '. Create a new invitation if you need another transfer.'}</p>}
        {incoming && <section aria-label="Received password"><h3>3. Use the received password</h3>
          <label>Received password{incoming.includes('\n')
            ? <textarea ref={revealedInput} readOnly value={incoming} rows={8} autoComplete="off" spellCheck={false} />
            : <input ref={revealedInput} readOnly value={incoming} autoComplete="off" spellCheck={false} />}</label>
          <p>Clears from this page after one minute or when you leave or hide it. Clipboard managers may retain a copied value.</p>
          <button type="button" onClick={() => { void navigator.clipboard.writeText(incoming).then(() => setNotice('Password copied. Clear your clipboard when finished.'), () => setError('The password could not be copied.')); }}>Copy received password</button>
          <button type="button" className="secondary-button" onClick={() => setIncoming('')}>Hide and clear password</button>
        </section>}
      </> : <>
        <h3>1. Paste the recipient’s invitation</h3><p>Ask the recipient to create an invitation in their CLIHarbor and send it to you. Nothing is sent until you check the destination and confirm.</p>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void act('Checking password invitation…', async () => {
          const next = await inspectInvitation(csrfToken, outgoing); if (alive.current) { setDestination(next); setConfirmed(false); }
        }); }}>
          <label>Recipient’s invitation<textarea ref={outgoingInput} required maxLength={1024} rows={4} value={outgoing} disabled={busy} autoComplete="off" spellCheck={false}
            onChange={(e) => { setOutgoing(e.target.value); setDestination(null); setConfirmed(false); setPassword(''); }} /></label>
          <button type="submit" disabled={busy || !outgoing}>Check receiving address</button>
        </form>
        {destination && <form onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed || !acceptablePassword(password)) return;
          void act('Sending password…', async () => {
            const value = password; const link = outgoing;
            setPassword(''); setOutgoing(''); setDestination(null); setConfirmed(false);
            await sendPassword(csrfToken, link, value);
            if (alive.current) setNotice('Password delivered. The recipient can reveal it once in CLIHarbor.');
          });
        }}>
          <h3>2. Verify and send</h3>
          <p>Ask the recipient to read you their receiving address and fingerprint. Both must match exactly.</p>
          <dl><div><dt>Receiving address</dt><dd><code>{hostOf(destination.origin)}</code></dd></div><div><dt>Certificate fingerprint (SHA-256)</dt><dd><code>{grouped(destination.fingerprint)}</code></dd></div></dl>
          <label className="sharing-consent"><input type="checkbox" required checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />I verified this address and fingerprint with the recipient.</label>
          <label className="sharing-consent"><input type="checkbox" checked={multiline} disabled={busy} aria-describedby="sharing-multiline-help"
            onChange={(e) => { setMultiline(e.target.checked); setPassword(''); }} />Multi-line value, such as a private key, certificate or JSON key file</label>
          <p id="sharing-multiline-help">The multi-line field is not masked: its text is shown on screen as you paste it. Make sure nobody else can see your screen. Switching clears the field.</p>
          <label>Password to send{multiline
            ? <textarea ref={passwordInput} required maxLength={MAX_PASSWORD_BYTES} rows={8} value={password} disabled={busy} autoComplete="off" spellCheck={false} aria-describedby="sharing-password-help" onChange={(e) => setPassword(e.target.value)} />
            : <input ref={passwordInput} type="password" required maxLength={MAX_PASSWORD_BYTES} value={password} disabled={busy} autoComplete="off" spellCheck={false} aria-describedby="sharing-password-help" onChange={(e) => setPassword(e.target.value)} />}</label>
          <p id="sharing-password-help">{multiline ? 'Line breaks and tabs are kept. An older CLIHarbor receiver refuses multi-line values, and nothing is stored.' : 'Masked, single line.'} Up to 16,384 bytes, without other control or invisible formatting characters. The password and invitation clear from this page as soon as you send.</p>
          <button type="submit" disabled={busy || !confirmed || !acceptablePassword(password)}>Send password once</button>
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
