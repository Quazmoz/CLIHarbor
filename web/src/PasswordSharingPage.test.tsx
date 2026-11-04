import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { PasswordSharingPage } from './PasswordSharingPage';
import { OperationActivityProvider } from './OperationActivity';
import { App } from './App';
import { bootRoutes, installFakeBackend } from './test/fakeBackend';
import { fetchSharingStatus } from './api/passwordSharing';

const root = '/api/v1/password-sharing';
const id = 'a'.repeat(22);
const idle = { state: 'idle', addresses: ['192.168.10.2'], browserAvailable: false };
const waiting = { ...idle, state: 'waiting', id, mode: 'app', origin: 'https://192.168.10.2:44000', fingerprint: 'b'.repeat(64), expiresAt: '2099-01-01T12:00:00Z' };
const invitation = waiting.origin + '/#v=1&mode=app&token=' + 'c'.repeat(43) + '&pin=' + waiting.fingerprint;
const mount = () => render(<OperationActivityProvider><PasswordSharingPage csrfToken="sharing-csrf" /></OperationActivityProvider>);

test('app navigation opens sharing without executing a CLI or opening a listener', async () => {
  window.history.replaceState({}, '', '/password-sharing');
  const backend = installFakeBackend({ ...bootRoutes(), '/api/v1/platforms': { body: { platforms: [] } }, [root]: { body: idle } });
  render(<App />);
  await screen.findByRole('heading', { name: 'Password sharing' });
  await screen.findByRole('option', { name: '192.168.10.2' });
  expect(screen.getByRole('link', { name: 'Password sharing' })).toHaveAttribute('aria-current', 'page');
  expect(backend.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
});

test('creation is explicit and single-flight; browser mode stays disabled without trusted-certificate configuration', async () => {
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  let state: object = idle;
  const backend = installFakeBackend({ [root]: () => ({ body: state }), ['POST '+root+'/create']: () => pending,
    ['POST '+root+'/cancel']: () => { state = { ...waiting, state: 'cancelled' }; return { status: 204 }; } });
  mount();
  await screen.findByRole('option', { name: '192.168.10.2' });
    expect(screen.getByRole('option', { name: 'From a web browser' })).toBeDisabled();
  const create = screen.getByRole('button', { name: 'Create five-minute invitation' });
  fireEvent.click(create); fireEvent.click(create);
  expect(backend.calls('POST '+root+'/create')).toHaveLength(1);
  expect(backend.bodies('POST '+root+'/create')).toEqual([{ address: idle.addresses[0], mode: 'app' }]);
  expect(backend.calls('POST '+root+'/create')[0].headers.get('X-CLIHarbor-CSRF')).toBe('sharing-csrf');
  state = waiting;
  await act(async () => finish(new Response(JSON.stringify({ status: waiting, invitation }), { status: 201 })));
  expect(await screen.findByRole('textbox', { name: 'One-use invitation' })).toHaveValue(invitation);
  expect(screen.getByRole('button', { name: 'Create five-minute invitation' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel invitation and discard password' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'One-use invitation' })).not.toBeInTheDocument());
  expect(backend.bodies('POST '+root+'/cancel')).toEqual([{ id }]);
});

test('a resumed invitation never reconstructs its private link, and reveal clears on page hiding', async () => {
  let state = { ...waiting, state: 'received' };
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const backend = installFakeBackend({ [root]: () => ({ body: state }), ['POST '+root+'/reveal']: () => {
    state = { ...waiting, state: 'revealed' }; return { body: { password: 'received-fixture-value' } };
  } });
  mount();
  await screen.findByRole('button', { name: 'Reveal received password once' });
  expect(screen.queryByDisplayValue('received-fixture-value')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'One-use invitation' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reveal received password once' }));
  const value = await screen.findByRole('textbox', { name: 'Received password' });
  expect(value).toHaveValue('received-fixture-value'); expect(value).toHaveFocus();
  expect(backend.bodies('POST '+root+'/reveal')).toEqual([{ id }]);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  fireEvent(document, new Event('visibilitychange'));
  expect(screen.queryByRole('textbox', { name: 'Received password' })).not.toBeInTheDocument();
  expect(storage).not.toHaveBeenCalled();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  storage.mockRestore();
});

test('sending verifies destination first, requires consent, clears input before acknowledgement and cannot replay on remount', async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  const backend = installFakeBackend({ [root]: { body: idle },
    ['POST '+root+'/inspect']: { body: { origin: waiting.origin, fingerprint: waiting.fingerprint } },
    ['POST '+root+'/send']: () => pending });
  const view = mount();
  fireEvent.click(screen.getByRole('tab', { name: 'Send a password' }));
  expect(screen.queryByLabelText('Password to send')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Recipient’s invitation' }), { target: { value: invitation } });
  fireEvent.click(screen.getByRole('button', { name: 'Check receiving address' }));
  const password = await screen.findByLabelText('Password to send');
  expect(screen.getByText('192.168.10.2:44000')).toBeInTheDocument();
  expect(screen.getByText('bbbb '.repeat(15) + 'bbbb')).toBeInTheDocument();
  fireEvent.change(password, { target: { value: 'send-fixture-value' } });
  expect(screen.getByRole('button', { name: 'Send password once' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I verified this address/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Send password once' }));
  expect(backend.bodies('POST '+root+'/send')).toEqual([{ invitation, password: 'send-fixture-value', confirmed: true }]);
  expect(screen.queryByDisplayValue('send-fixture-value')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Recipient’s invitation' })).toHaveValue('');
  view.rerender(<OperationActivityProvider>{null}</OperationActivityProvider>);
  view.rerender(<OperationActivityProvider><PasswordSharingPage csrfToken="sharing-csrf" /></OperationActivityProvider>);
  expect(screen.getByRole('button', { name: 'Create five-minute invitation' })).toBeDisabled();
  await act(async () => finish(new Response(null, { status: 204 })));
  expect(backend.calls('POST '+root+'/send')).toHaveLength(1);
});

test('unknown status fields and malformed state never become sharing capabilities', async () => {
  const backend = installFakeBackend({ [root]: { body: { ...idle, state: ['idle'] } } });
  await expect(fetchSharingStatus()).rejects.toMatchObject({ detail: { code: 'invalid_response' } });
  backend.on({ [root]: { body: { ...idle, password: 'unexpected' } } });
  await expect(fetchSharingStatus()).rejects.toMatchObject({ detail: { code: 'invalid_response' } });
});

test('browser invitations hide the uncomparable key fingerprint; app invitations show it grouped', async () => {
  const backend = installFakeBackend({ [root]: { body: { ...waiting, mode: 'browser' } } });
  mount();
  expect(await screen.findByText('192.168.10.2:44000')).toBeInTheDocument();
  expect(screen.getByText(/open it in a browser that trusts/)).toBeInTheDocument();
  expect(screen.queryByText(/Certificate fingerprint/)).not.toBeInTheDocument();
  backend.on({ [root]: { body: waiting } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  expect(await screen.findByText('bbbb '.repeat(15) + 'bbbb')).toBeInTheDocument();
  expect(screen.getByText(/paste it into Password sharing/)).toBeInTheDocument();
});

test('a reveal that completes while the page is hidden is discarded with an explanation', async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  installFakeBackend({ [root]: { body: { ...waiting, state: 'received' } }, ['POST '+root+'/reveal']: () => pending });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Reveal received password once' }));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  try {
    await act(async () => finish(new Response(JSON.stringify({ password: 'hidden-fixture-value' }), { status: 200 })));
    expect(await screen.findByRole('alert')).toHaveTextContent(/revealed while this page was hidden/);
    expect(screen.queryByDisplayValue('hidden-fixture-value')).not.toBeInTheDocument();
  } finally {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  }
});

test('definitive send refusals say nothing was sent instead of reporting an unconfirmed delivery', async () => {
  const refusals = [
    { code: 'password_receiver_mismatch', category: 'security', message: 'The computer at this address is not the one in the invitation. Nothing was sent.', remediation: 'Do not retry with this invitation.', retryable: false },
    { code: 'password_delivery_unreachable', category: 'lifecycle', message: 'The recipient’s computer could not be reached securely. Nothing was sent.', remediation: 'Check with the recipient.', retryable: true },
  ];
  for (const error of refusals) {
    const backend = installFakeBackend({ [root]: { body: idle },
      ['POST '+root+'/inspect']: { body: { origin: waiting.origin, fingerprint: waiting.fingerprint } },
      ['POST '+root+'/send']: { status: 502, body: { error } } });
    const view = mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Send a password' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient’s invitation' }), { target: { value: invitation } });
    fireEvent.click(screen.getByRole('button', { name: 'Check receiving address' }));
    fireEvent.change(await screen.findByLabelText('Password to send'), { target: { value: 'refused-fixture-value' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /I verified this address/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send password once' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(error.message);
    expect(screen.queryByText(/not confirmed/u)).not.toBeInTheDocument();
    expect(backend.calls('POST '+root+'/send')).toHaveLength(1);
    view.unmount();
  }
});

const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\tBBBB\n-----END PRIVATE KEY-----\n';

test('multi-line sending is an explicit, visible-on-screen choice and keeps the receiver limits', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const backend = installFakeBackend({ [root]: { body: idle },
    ['POST '+root+'/inspect']: { body: { origin: waiting.origin, fingerprint: waiting.fingerprint } },
    ['POST '+root+'/send']: { status: 204 } });
  mount();
  fireEvent.click(screen.getByRole('tab', { name: 'Send a password' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Recipient’s invitation' }), { target: { value: invitation } });
  fireEvent.click(screen.getByRole('button', { name: 'Check receiving address' }));
  const masked = await screen.findByLabelText('Password to send');
  expect(masked).toHaveAttribute('type', 'password');
  fireEvent.change(masked, { target: { value: 'typed-before-switching' } });
  const multiline = screen.getByRole('checkbox', { name: /Multi-line value/ });
  expect(multiline).toHaveAccessibleDescription(/shown on screen/);
  fireEvent.click(multiline);
  const area = screen.getByRole('textbox', { name: 'Password to send' });
  expect(area.tagName).toBe('TEXTAREA');
  expect(area).toHaveValue('');
  fireEvent.click(screen.getByRole('checkbox', { name: /I verified this address/ }));
  const send = screen.getByRole('button', { name: 'Send password once' });
  for (const refused of ['bell\u0007', 'zero​width', 'x'.repeat(16385)]) {
    fireEvent.change(area, { target: { value: refused } });
    expect(send).toBeDisabled();
  }
  fireEvent.change(area, { target: { value: pem } });
  fireEvent.click(send);
  await waitFor(() => expect(backend.bodies('POST '+root+'/send')).toEqual([{ invitation, password: pem, confirmed: true }]));
  expect(screen.queryByDisplayValue(/BEGIN PRIVATE KEY/)).not.toBeInTheDocument();
  expect(storage).not.toHaveBeenCalled();
  storage.mockRestore();
});

test('a revealed multi-line value appears in a read-only text area and clears on hiding', async () => {
  installFakeBackend({ [root]: { body: { ...waiting, state: 'received' } }, ['POST '+root+'/reveal']: { body: { password: pem } } });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Reveal received password once' }));
  const value = await screen.findByRole('textbox', { name: 'Received password' });
  expect(value.tagName).toBe('TEXTAREA');
  expect(value).toHaveAttribute('readonly');
  expect(value).toHaveValue(pem);
  expect(value).toHaveFocus();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  try {
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.queryByRole('textbox', { name: 'Received password' })).not.toBeInTheDocument();
  } finally {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  }
});

test('a key pasted into the masked field is caught before its stripped line breaks are sent', async () => {
  installFakeBackend({ [root]: { body: idle },
    ['POST '+root+'/inspect']: { body: { origin: waiting.origin, fingerprint: waiting.fingerprint } } });
  mount();
  fireEvent.click(screen.getByRole('tab', { name: 'Send a password' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Recipient’s invitation' }), { target: { value: invitation } });
  fireEvent.click(screen.getByRole('button', { name: 'Check receiving address' }));
  // Browsers sanitize password inputs by removing line breaks.
  fireEvent.change(await screen.findByLabelText('Password to send'), { target: { value: pem.replaceAll('\n', '') } });
  fireEvent.click(screen.getByRole('checkbox', { name: /I verified this address/ }));
  expect(screen.getByRole('alert')).toHaveTextContent(/removed its line breaks.*Multi-line value/);
  expect(screen.getByRole('button', { name: 'Send password once' })).toBeDisabled();
});

test('a receiver that refuses a multi-line value explains that nothing was stored and what to do next', async () => {
  installFakeBackend({ [root]: { body: idle },
    ['POST '+root+'/inspect']: { body: { origin: waiting.origin, fingerprint: waiting.fingerprint } },
    ['POST '+root+'/send']: { status: 400, body: { error: { code: 'invalid_request', category: 'validation', message: 'The request was not accepted.', retryable: false } } } });
  mount();
  fireEvent.click(screen.getByRole('tab', { name: 'Send a password' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Recipient’s invitation' }), { target: { value: invitation } });
  fireEvent.click(screen.getByRole('button', { name: 'Check receiving address' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /Multi-line value/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Password to send' }), { target: { value: pem } });
  fireEvent.click(screen.getByRole('checkbox', { name: /I verified this address/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Send password once' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/nothing was stored/);
  expect(alert).toHaveTextContent(/older CLIHarbor/);
  expect(alert).not.toHaveTextContent(/Review the task/);
});
