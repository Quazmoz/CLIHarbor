import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SupportDiagnostics } from './SupportDiagnostics';
import { fetchDiagnosticReport } from './api/diagnostics';
import { installFakeBackend, type RouteReply } from './test/fakeBackend';

const bundle = {
  schemaVersion: 'cliharbor.diagnostics/v1', cliharbor: { version: 'dev', commit: 'abc123', buildMode: 'test' },
  runtime: { goVersion: 'go1.27.3', os: 'windows', architecture: 'amd64' },
  configuration: { packSourceMode: 'files', packCount: 1, toolOverrideCount: 1 },
  health: { toolsReady: 1, toolsUnavailable: 0 }, packs: [{ id: 'fixture', version: '1.0.0' }],
  tools: [{ packId: 'fixture', packVersion: '1.0.0', toolId: 'fixture', status: 'ready', version: '1.2.3', candidateCount: 1 }],
};
const json = JSON.stringify(bundle, null, 2) + '\n';
const reply = (text = json) => new Response(text, { headers: { 'Content-Type': 'application/json' } });
const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const createURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const revokeURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
let digest: ReturnType<typeof vi.fn>;
beforeEach(() => {
  digest = vi.fn().mockResolvedValue(new Uint8Array(32).fill(0xab).buffer);
  vi.stubGlobal('crypto', { subtle: { digest } });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  for (const [key, descriptor] of [['createObjectURL', createURL], ['revokeObjectURL', revokeURL]] as const) {
    if (descriptor) Object.defineProperty(URL, key, descriptor);
    else Reflect.deleteProperty(URL, key);
  }
});

test('prepares only on request, suppresses duplicate reads and copies/downloads exact reviewed bytes with their checksum', async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  const backend = installFakeBackend({ '/api/v1/diagnostics': () => pending });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const blobs: Blob[] = [];
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:diagnostics'; }) });
  const revoke = vi.fn();
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const cleanups: (() => void)[] = [];
  const timeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation((handler, milliseconds, ...args) => {
    if (milliseconds === 1000 && typeof handler === 'function') { cleanups.push(() => handler(...args)); return -1; }
    return timeout(handler, milliseconds, ...args);
  });
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  render(<SupportDiagnostics />);
  expect(backend.requests).toHaveLength(0);
  const prepare = screen.getByRole('button', { name: 'Prepare diagnostics' });
  fireEvent.click(prepare);
  fireEvent.click(prepare);
  expect(screen.getByRole('button', { name: 'Preparing diagnostics…' })).toBeDisabled();
  expect(backend.calls('/api/v1/diagnostics')).toHaveLength(1);
  await act(async () => finish(reply()));
  await screen.findByText('Diagnostics ready to review. Copy or download the report.');
  expect(screen.getByLabelText('Diagnostic JSON', { selector: 'pre' }).textContent).toBe(json);
  expect(screen.getByText('ab'.repeat(32))).toBeInTheDocument();
  expect(digest).toHaveBeenCalledExactlyOnceWith('SHA-256', new TextEncoder().encode(json));
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
  await screen.findByText('Copied support diagnostics.');
  expect(writeText).toHaveBeenCalledExactlyOnceWith(json);
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostics' }));
  const text = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blobs[0]); });
  expect(text).toBe(json);
  expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe('cliharbor-diagnostics.json');
  expect(document.querySelector('a[download]')).toBeNull();
  expect(revoke).not.toHaveBeenCalled();
  cleanups.forEach((cleanup) => cleanup());
  expect(revoke).toHaveBeenCalledWith('blob:diagnostics');
  expect(storage).not.toHaveBeenCalled();
  expect(backend.requests).toHaveLength(1);
  expect(backend.requests[0].method).toBe('GET');
});

test.each([
  { ...bundle, credentials: 'forbidden' },
  { ...bundle, cliharbor: { ...bundle.cliharbor, commit: 'C:/private/path' } },
  { ...bundle, configuration: { ...bundle.configuration, packSourceMode: ['files'] } },
  { ...bundle, configuration: { ...bundle.configuration, packCount: '1' } },
  { ...bundle, health: { toolsReady: 0, toolsUnavailable: 0 } },
  { ...bundle, packs: [...bundle.packs, ...bundle.packs], configuration: { ...bundle.configuration, packCount: 2 } },
  { ...bundle, tools: [{ ...bundle.tools[0], status: ['ready'] }] },
  { ...bundle, tools: [{ ...bundle.tools[0], message: 'output token=forbidden' }] },
  { ...bundle, tools: Array.from({ length: 257 }, () => bundle.tools[0]), health: { toolsReady: 257, toolsUnavailable: 0 } },
])('refuses malformed or unexpected metadata before producing a report: %#', async (value) => {
  installFakeBackend({ '/api/v1/diagnostics': () => reply(JSON.stringify(value, null, 2) + '\n') });
  await expect(fetchDiagnosticReport()).rejects.toMatchObject({ detail: { code: 'invalid_response' } });
});

test.each([json.repeat(100), '{broken', '{"cliharbor":{"password":"DO_NOT_EXPORT"},' + json.slice(1), JSON.stringify(bundle)])('rejects oversized, malformed, duplicate or noncanonical JSON', async (text) => {
  installFakeBackend({ '/api/v1/diagnostics': () => reply(text) });
  await expect(fetchDiagnosticReport()).rejects.toMatchObject({ detail: { code: 'invalid_response' } });
});

test('handles an empty runtime using the existing nullable-array contract', async () => {
  const empty = { ...bundle, configuration: { ...bundle.configuration, packCount: 0 }, health: { toolsReady: 0, toolsUnavailable: 0 }, packs: null, tools: null };
  const text = JSON.stringify(empty, null, 2) + '\n';
  installFakeBackend({ '/api/v1/diagnostics': () => reply(text) });
  expect((await fetchDiagnosticReport()).json).toBe(text);
});

test('retains the previous preview through refresh failure and blocks stale export until an explicit successful reread', async () => {
  const backend = installFakeBackend({ '/api/v1/diagnostics': () => reply() });
  render(<SupportDiagnostics />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare diagnostics' }));
  await screen.findByText('Diagnostics ready to review. Copy or download the report.');
  backend.on({ '/api/v1/diagnostics': { status: 500, body: {} } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }));
  await screen.findByText('Prepare diagnostics again before exporting.');
  expect(screen.getByLabelText('Diagnostic JSON', { selector: 'pre' }).textContent).toBe(json);
  expect(screen.getByRole('button', { name: 'Download diagnostics' })).toBeDisabled();
  backend.on({ '/api/v1/diagnostics': () => reply() });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Download diagnostics' })).toBeEnabled());
});

test('aborts an abandoned report read without preparing or exporting it', async () => {
  let signal: AbortSignal | null | undefined;
  let finish!: (response: RouteReply) => void;
  const pending = new Promise<RouteReply>((resolve) => { finish = resolve; });
  const backend = installFakeBackend({ '/api/v1/diagnostics': () => pending });
  backend.fetch.mockImplementationOnce(async (_input, init) => { signal = init?.signal; return pending.then(() => reply()); });
  const view = render(<SupportDiagnostics />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare diagnostics' }));
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => finish({}));
  expect(screen.queryByText(/ready to review/)).not.toBeInTheDocument();
});

test('browser copy and download failures preserve the reviewed report without echoing internal errors', async () => {
  installFakeBackend({ '/api/v1/diagnostics': () => reply() });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('PRIVATE')) } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => { throw new Error('PRIVATE'); }) });
  render(<SupportDiagnostics />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare diagnostics' }));
  await screen.findByText('Diagnostics ready to review. Copy or download the report.');
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
  await screen.findByText(/Clipboard unavailable/);
  fireEvent.click(screen.getByRole('button', { name: 'Download diagnostics' }));
  expect(screen.getByText(/Your browser could not start the download/)).toBeInTheDocument();
  expect(screen.getByLabelText('Diagnostic JSON', { selector: 'pre' }).textContent).toBe(json);
  expect(screen.queryByText('PRIVATE')).not.toBeInTheDocument();
});

test('a late copy response cannot label a refreshed report as copied', async () => {
  const backend = installFakeBackend({ '/api/v1/diagnostics': () => reply() });
  let finish!: () => void;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) } });
  render(<SupportDiagnostics />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare diagnostics' }));
  await screen.findByText('Diagnostics ready to review. Copy or download the report.');
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
  const updated = JSON.stringify({ ...bundle, cliharbor: { ...bundle.cliharbor, commit: 'def456' } }, null, 2) + '\n';
  backend.on({ '/api/v1/diagnostics': () => reply(updated) });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }));
  await waitFor(() => expect(screen.getByLabelText('Diagnostic JSON', { selector: 'pre' }).textContent).toBe(updated));
  await act(async () => finish());
  expect(screen.queryByText('Copied support diagnostics.')).not.toBeInTheDocument();
});
