'use strict';
(() => {
  const fields = new URLSearchParams(location.hash.slice(1));
  let token = fields.get('token') ?? '';
  // Remove the invitation credential from the current history entry immediately.
  history.replaceState(null, '', '/');
  const form = document.getElementById('send');
  const password = document.getElementById('password');
  const confirmed = document.getElementById('confirmed');
  const button = document.getElementById('submit');
  const status = document.getElementById('status');
  document.getElementById('destination').textContent = location.host;
  if (fields.size !== 4 || fields.get('v') !== '1' || fields.get('mode') !== 'browser' ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[a-f0-9]{64}$/.test(fields.get('pin') ?? '')) {
    token = ''; status.textContent = 'This invitation is invalid. Ask the recipient for a new invitation.'; return;
  }
  for (const control of [password, confirmed, button]) control.disabled = false;
  let busy = false;
  const forget = () => { token = ''; password.value = ''; confirmed.checked = false; };
  const expiry = setTimeout(() => {
    forget(); for (const control of [password, confirmed, button]) control.disabled = true;
    status.textContent = 'The invitation has timed out. Ask the recipient for a new invitation.';
  }, 5 * 60 * 1000);
  addEventListener('pagehide', () => { clearTimeout(expiry); forget(); }, { once: true });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !token || !form.reportValidity()) return;
    const value = password.value;
    if (new TextEncoder().encode(value).length > 4096 || /[\p{Cc}\p{Cf}]/u.test(value)) {
      status.textContent = 'Use one line, up to 4,096 UTF-8 bytes, without control or invisible formatting characters.'; return;
    }
    busy = true;
    const invitationToken = token;
    forget(); clearTimeout(expiry);
    for (const control of [password, confirmed, button]) control.disabled = true;
    button.textContent = 'Sending…'; button.setAttribute('aria-busy', 'true');
    status.textContent = 'Sending the password. Keep this page open.';
    try {
      const response = await fetch('/deliver', { method: 'POST', credentials: 'omit', redirect: 'error', mode: 'same-origin',
        referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000),
        headers: { Authorization: 'Bearer ' + invitationToken, 'Content-Type': 'text/plain; charset=utf-8' }, body: value });
      status.textContent = response.status === 204 ? 'Password delivered. The recipient can reveal it in CLIHarbor.'
        : 'Delivery was not confirmed. Check with the recipient before arranging another transfer.';
    } catch {
      status.textContent = 'Delivery was not confirmed. Check with the recipient before arranging another transfer.';
    } finally {
      button.textContent = 'Transfer finished'; button.removeAttribute('aria-busy');
    }
  });
})();
