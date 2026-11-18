import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { VaultWorkspace } from './VaultWorkspace';
import type { Platform } from '../../api/platforms';
import { jsonResponse } from '../../test/fakeBackend';

const platform: Platform = {
  id: 'vault', name: 'HashiCorp Vault', summary: 'KV secrets',
  packId: 'vault-cli', toolId: 'vault', ready: true,
  features: [{ id: 'tasks', name: 'Vault tasks' }],
};
const props = {
  platform, tasks: [], csrfToken: 'csrf',
  tool: { packId: 'vault-cli', packName: 'Vault', toolId: 'vault', packVersion: '0.1.0', status: 'ready' as const },
  onOpenFeature: vi.fn(), onOpenDiagnostics: vi.fn(), onOpenTask: vi.fn(),
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function backend(reveal: unknown) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/context')) return jsonResponse(200, { address: 'http://127.0.0.1:8200', ready: true });
    if (url.endsWith('/access-log')) return jsonResponse(200, { entries: [] });
    const body = JSON.parse(String(init?.body));
    if (url.endsWith('/list')) return jsonResponse(200, body.path === '' ? { ...body, keys: ['apps/'] } : { ...body, keys: ['db'] });
    return jsonResponse(200, { ...body, ...(reveal as object) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function browseToSecret() {
  render(<VaultWorkspace {...props} />);
  await screen.findByText('http://127.0.0.1:8200');
  fireEvent.click(screen.getByRole('button', { name: 'List keys' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open folder apps/' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Select secret db' }));
}

test('reveal requires consent, shows masked values, and clears on hide', async () => {
  const fetchMock = backend({ version: 3, fields: [{ key: 'password', value: 's3cret-value' }] });
  await browseToSecret();
  const reveal = screen.getByRole('button', { name: 'Reveal secret' });
  expect(reveal).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(reveal);
  expect(await screen.findByText(/version 3/)).toBeInTheDocument();
  const revealCall = fetchMock.mock.calls.find(([url]) => url.endsWith('/reveal'));
  expect(JSON.parse(String(revealCall?.[1]?.body))).toEqual({ mount: 'secret', path: 'apps/db' });
  expect(screen.queryByDisplayValue('s3cret-value')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show values' }));
  expect(screen.getByLabelText('Value of password')).toHaveValue('s3cret-value');
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  expect(screen.queryByDisplayValue('s3cret-value')).not.toBeInTheDocument();
});

test('a failure code is explained and never rendered as a value', async () => {
  backend({ failureCode: 'forbidden' });
  await browseToSecret();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Reveal secret' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/policy does not permit/);
  expect(screen.queryByRole('button', { name: 'Show values' })).not.toBeInTheDocument();
});

test('a response for a different location is rejected', async () => {
  backend({ path: 'apps/other', version: 1, fields: [{ key: 'k', value: 'leak' }] });
  await browseToSecret();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Reveal secret' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Show values' })).not.toBeInTheDocument();
});
