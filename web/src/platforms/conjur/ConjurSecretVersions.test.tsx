import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConjurSecretVersions } from './ConjurSecretVersions';

const SECRET = 'SENTINEL-previous-value';
const props = { packId: 'cyberark-conjur-v9', toolId: 'conjur', csrfToken: 'csrf', account: 'acct', endpoint: 'https://conjur.example.test', available: true, active: true };
let requests: Array<{ url: string; body?: Record<string, unknown>; csrf: string | null }>;
let revealPayload: Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  requests = [];
  revealPayload = { variableId: 'apps/db', version: 2, value: SECRET };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined, csrf: new Headers(init?.headers).get('X-CLIHarbor-CSRF') });
    const payload = url.endsWith('/versions') ? { variableId: 'apps/db', versions: [{ version: 3 }, { version: 2, expiresAt: '2027-01-01T00:00:00Z' }, { version: 1 }] }
      : url.endsWith('/reveal') ? revealPayload
      : { entries: [{ at: '2026-11-06T12:00:00Z', account: 'acct', applianceUrl: 'https://conjur.example.test', variableId: 'apps/db', version: 2, outcome: 'revealed' }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function revealVersionTwo() {
  const view = render(<ConjurSecretVersions {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /View secret versions/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Variable ID' }), { target: { value: ' apps/db ' } });
  fireEvent.click(screen.getByRole('button', { name: 'List versions' }));
  const select = await screen.findByRole('combobox', { name: 'Version' });
  expect(screen.getByRole('option', { name: 'Version 3 (current)' })).toBeInTheDocument();
  fireEvent.change(select, { target: { value: '2' } });
  const revealButton = screen.getByRole('button', { name: 'Reveal version 2' });
  expect(revealButton).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(revealButton);
  await screen.findByText(/Version 2 of/);
  return view;
}

test('lists versions and reveals a previous version only after acknowledgement, hidden by default', async () => {
  await revealVersionTwo();
  const target = { packId: 'cyberark-conjur-v9', toolId: 'conjur', account: 'acct', applianceUrl: 'https://conjur.example.test', variableId: 'apps/db' };
  expect(requests.find((r) => r.url.endsWith('/versions'))).toMatchObject({ body: target, csrf: 'csrf' });
  expect(requests.find((r) => r.url.endsWith('/reveal'))).toMatchObject({ body: { ...target, version: 2 }, csrf: 'csrf' });
  expect(document.body.textContent).not.toContain(SECRET);
  fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
  expect(screen.getByRole('textbox', { name: 'Secret value' })).toHaveValue(SECRET);
  fireEvent.click(screen.getByRole('button', { name: 'Hide and clear' }));
  expect(screen.queryByRole('textbox', { name: 'Secret value' })).not.toBeInTheDocument();
});

test('the revealed value clears after 60 seconds and when the tab becomes inactive', async () => {
  const view = await revealVersionTwo();
  fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
  await act(async () => { vi.advanceTimersByTime(59_000); });
  expect(screen.getByRole('textbox', { name: 'Secret value' })).toHaveValue(SECRET);
  await act(async () => { vi.advanceTimersByTime(2_000); });
  expect(screen.queryByRole('textbox', { name: 'Secret value' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Reveal version 2' }));
  await screen.findByText(/Version 2 of/);
  view.rerender(<ConjurSecretVersions {...props} active={false} />);
  expect(screen.queryByText(/Version 2 of/)).not.toBeInTheDocument();
});

test('copy clears the clipboard after 30 seconds only if it still holds the value', async () => {
  let clipboard = '';
  const writeText = vi.fn(async (value: string) => { clipboard = value; });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText: async () => clipboard } });
  try {
    await revealVersionTwo();
    fireEvent.click(screen.getByRole('button', { name: 'Copy value' }));
    await waitFor(() => expect(clipboard).toBe(SECRET));
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await waitFor(() => expect(clipboard).toBe(''));

    fireEvent.click(screen.getByRole('button', { name: 'Reveal version 2' }));
    await screen.findByText(/Version 2 of/);
    fireEvent.click(screen.getByRole('button', { name: 'Copy value' }));
    await waitFor(() => expect(clipboard).toBe(SECRET));
    clipboard = 'something the operator copied later';
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(clipboard).toBe('something the operator copied later');
  } finally {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

test('a denied read is reported as not permitted and shows no value', async () => {
  revealPayload = { variableId: 'apps/db', version: 2, failureCode: 'forbidden' };
  render(<ConjurSecretVersions {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /View secret versions/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Variable ID' }), { target: { value: 'apps/db' } });
  fireEvent.click(screen.getByRole('button', { name: 'List versions' }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Version' }), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Reveal version 2' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('did not permit');
  expect(screen.queryByRole('button', { name: 'Show value' })).not.toBeInTheDocument();
});

test('stays unavailable without a known Conjur server and account', () => {
  render(<ConjurSecretVersions {...props} account={undefined} />);
  expect(screen.getByRole('button', { name: /View secret versions/ })).toBeDisabled();
});
