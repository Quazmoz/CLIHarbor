'use strict';
(() => {
  const fields = new URLSearchParams(location.hash.slice(1));
  let token = fields.get('token') ?? '';
  // Remove the invitation credential from the current history entry immediately.
  history.replaceState(null, '', '/');
  const form = document.getElementById('send');
  const single = document.getElementById('password');
  const multi = document.getElementById('multiline-password');
  const multiline = document.getElementById('multiline');
  const confirmed = document.getElementById('confirmed');
  const button = document.getElementById('submit');
  const status = document.getElementById('status');
  const controls = [multiline, confirmed, button];
  const lock = () => { for (const control of [...controls, single, multi]) control.disabled = true; };
  // Only the chosen field is shown and enabled; switching clears both.
  const choose = () => {
    single.value = multi.value = '';
    for (const [field, on] of [[single, !multiline.checked], [multi, multiline.checked]]) field.hidden = field.labels[0].hidden = field.disabled = !on;
  };
  const report = (text, tone) => { status.textContent = text; status.dataset.tone = tone; };
  document.getElementById('destination').textContent = location.host;
  // Count entries rather than URLSearchParams.size so older browsers also reject duplicates.
  if ([...fields].length !== 4 || fields.get('v') !== '1' || fields.get('mode') !== 'browser' ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[a-f0-9]{64}$/.test(fields.get('pin') ?? '')) {
    token = '';
    report('This page needs the complete invitation link, which is removed from the address bar after it opens. Open the link the recipient sent you again, or ask them for a new one.', 'error');
    return;
  }
  for (const control of controls) control.disabled = false;
  choose();
  multiline.addEventListener('change', choose);
  let busy = false;
  const forget = () => { token = ''; single.value = multi.value = ''; confirmed.checked = false; };
  const expiry = setTimeout(() => {
    forget(); lock();
    report('This invitation has timed out. Ask the recipient for a new one.', 'error');
  }, 5 * 60 * 1000);
  addEventListener('pagehide', () => { clearTimeout(expiry); forget(); }, { once: true });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !token || !form.reportValidity()) return;
    // Text areas report line breaks as LF, matching what the receiver stores.
    const value = (multiline.checked ? multi : single).value;
    if (new TextEncoder().encode(value).length > 16384 || /(?![\t\n])[\p{Cc}\p{Cf}]/u.test(value)) {
      report('Use up to 16,384 bytes, without control or invisible formatting characters other than line breaks and tabs.', 'error'); return;
    }
    busy = true;
    const invitationToken = token;
    forget(); clearTimeout(expiry);
    lock();
    button.textContent = 'Sending…'; button.setAttribute('aria-busy', 'true');
    report('Sending the password. Keep this page open.', '');
    const unconfirmed = 'Delivery could not be confirmed. The recipient may already have it, so check with them before sending again.';
    try {
      const response = await fetch('/deliver', { method: 'POST', credentials: 'omit', redirect: 'error', mode: 'same-origin',
        referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000),
        headers: { Authorization: 'Bearer ' + invitationToken, 'Content-Type': 'text/plain; charset=utf-8' }, body: value });
      // The trusted HTTPS receiver's refusals are definitive: nothing was stored.
      if (response.status === 204) report('Password sent. The recipient can now reveal it in CLIHarbor. You can close this page.', 'success');
      else if (response.status === 403) report('The recipient’s invitation is no longer available. It may have expired, been cancelled or already been used. Your password was not stored; ask the recipient for a new invitation.', 'error');
      else if (response.status === 400) report('The recipient’s computer did not accept this password format, and nothing was stored. An older CLIHarbor accepts only single-line passwords. Open the invitation link again to retry.', 'error');
      else report(unconfirmed, 'error');
    } catch {
      report(unconfirmed, 'error');
    } finally {
      button.textContent = 'Transfer finished'; button.removeAttribute('aria-busy');
    }
  });
})();
