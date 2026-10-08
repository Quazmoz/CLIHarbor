import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SecretAuditPage } from './SecretAuditPage';
import { parseSecretAuditSnapshot } from './secretAuditApi';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const base = {
  available: true,
  packId: 'cyberark-conjur-v9',
  toolId: 'conjur',
  target: { applianceUrl: 'https://conjur.invalid', account: 'acct' },
  total: 0,
  processed: 0,
  inspected: 0,
  findings: [],
  failures: [],
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderPage() {
  return render(<SecretAuditPage csrfToken="csrf-audit" onOpenAuthentication={() => undefined} onOpenDiagnostics={() => undefined} />);
}

test('defaults to inventory-only regex with preset and renders redacted matches', async () => {
  const completed = {
    ...base, state: 'completed', scanType: 'id-regex',
    minimumConfidence: 'high', total: 3, processed: 3, inspected: 3,
    findings: [{ variableId: 'app/db/password', confidence: 'high', reason: 'regex_variable_id_match' }],
  };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    response(init?.method === 'POST' ? 202 : 200, init?.method === 'POST' ? completed : { ...base, state: 'idle' }));
  vi.stubGlobal('fetch', fetchMock);
  renderPage();
  const start = await screen.findByRole('button', { name: 'Start pattern search' });
  expect(start).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Search target' })).toHaveValue('id-regex');
  expect(screen.getByRole('combobox', { name: 'Pattern preset' })).toHaveValue('credential-names');
  const pattern = screen.getByRole('textbox', { name: 'Regex pattern (Go / RE2)' });
  const searchPattern = (pattern as HTMLInputElement).value;
  fireEvent.click(screen.getByRole('checkbox', { name: /inspect visible Conjur variable identifiers/ }));
  fireEvent.click(start);
  expect(await screen.findByRole('heading', { name: '1 variable needs review' })).toBeInTheDocument();
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(post?.[0]).toBe('/api/v1/conjur/secret-audit');
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({
    packId: 'cyberark-conjur-v9', toolId: 'conjur', minimumConfidence: 'high',
    applianceUrl: 'https://conjur.invalid', scanType: 'id-regex', pattern: searchPattern,
  });
  expect((post?.[1]?.headers as Record<string, string>)['X-CLIHarbor-CSRF']).toBe('csrf-audit');
  expect(screen.getByText('app/db/password')).toBeInTheDocument();
  expect(screen.getByText(/no secret value was retrieved/)).toBeInTheDocument();
  expect(pattern).toHaveValue('');
  expect(screen.getByRole('checkbox', { name: /inspect visible Conjur variable identifiers/ })).not.toBeChecked();
});

test.each(['id-regex', 'regex'] as const)('supports custom %s patterns and resets consent on selection', async (scanType) => {
  const pattern = scanType === 'regex' ? '(?i)^conjur://[^/]+$' : '(?i)^team/.*/password$';
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => response(init?.method === 'POST' ? 202 : 200, {
    ...base, state: init?.method === 'POST' ? 'completed' : 'idle', scanType,
    findings: init?.method === 'POST' ? [{ variableId: 'example', confidence: 'high',
      reason: scanType === 'regex' ? 'regex_match' : 'regex_variable_id_match' }] : [],
  }));
  vi.stubGlobal('fetch', fetchMock);
  renderPage();
  const backend = await screen.findByRole('textbox', { name: 'CyberArk backend URL' });
  fireEvent.change(backend, { target: { value: 'https://other.invalid' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Search target' }), { target: { value: scanType } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Pattern preset' }), { target: { value: 'custom' } });
  const input = screen.getByRole('textbox', { name: 'Regex pattern (Go / RE2)' });
  fireEvent.change(input, { target: { value: pattern } });
  const start = screen.getByRole('button', { name: 'Start pattern search' });
  expect(start).toBeDisabled();
  const acknowledgement = screen.getByRole('checkbox', { name: scanType === 'regex' ? /authorized to read every variable/ : /inspect visible Conjur variable identifiers/ });
  fireEvent.click(acknowledgement);
  fireEvent.click(start);
  expect(await screen.findByRole('heading', { name: '1 variable needs review' })).toBeInTheDocument();
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({
    packId: 'cyberark-conjur-v9', toolId: 'conjur', minimumConfidence: 'high',
    applianceUrl: 'https://other.invalid', scanType, pattern,
  });
  expect(input).toHaveValue('');
  expect(acknowledgement).not.toBeChecked();
});

test('explains backend mismatch and requires acknowledgement again after editing the target', async () => {
  const onOpenAuthentication = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => response(200, { ...base, state: 'failed', failureCode: 'backend_mismatch' })));
  render(<SecretAuditPage csrfToken="csrf-audit" onOpenAuthentication={onOpenAuthentication} onOpenDiagnostics={() => undefined} />);
  expect(await screen.findByRole('heading', { name: 'Sign in to the selected backend' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Authentication' }));
  expect(onOpenAuthentication).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('checkbox', { name: /inspect visible Conjur variable identifiers/ }));
  expect(screen.getByRole('button', { name: 'Search again' })).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'CyberArk backend URL' }), { target: { value: 'https://another.invalid' } });
  expect(screen.getByRole('button', { name: 'Run audit again' })).toBeDisabled();
});

test('downloads a versioned report containing only scan metadata and redacted findings', async () => {
  let downloaded: Record<string, unknown> | undefined;
  vi.stubGlobal('Blob', class {
    constructor(parts: string[]) { downloaded = JSON.parse(parts[0]) as Record<string, unknown>; }
  });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:report', revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async () => response(200, {
    ...base, state: 'completed', scanType: 'exact', total: 1, inspected: 1, processed: 1,
    pattern: 'secret-pattern-sentinel', value: 'secret-value-sentinel',
    findings: [{ variableId: 'example', confidence: 'high', reason: 'exact_text_match', value: 'secret-value-sentinel' }],
  })));
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Download redacted report' }));
  expect(downloaded).toMatchObject({ schemaVersion: 2, scanType: 'exact', matchingVariables: 1 });
  expect(JSON.stringify(downloaded)).not.toContain('secret-pattern-sentinel');
  expect(JSON.stringify(downloaded)).not.toContain('secret-value-sentinel');
});

test('explains a missing session with a path to sign in', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(200, { ...base, state: 'failed', failureCode: 'session_required' })));
  renderPage();
  expect(await screen.findByRole('heading', { name: 'Sign in to Conjur first' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open Authentication' })).toBeInTheDocument();
});

test('rejects unsafe or malformed server data', () => {
  expect(() => parseSecretAuditSnapshot({ ...base, state: 'done' })).toThrow();
  expect(() =>
    parseSecretAuditSnapshot({ ...base, state: 'completed', findings: [{ variableId: 'spoof‮txt', confidence: 'high', reason: 'x' }] }),
  ).toThrow();
  expect(() => parseSecretAuditSnapshot({ ...base, state: 'completed', total: -1 })).toThrow();
  expect(() => parseSecretAuditSnapshot({ ...base, state: 'completed', scanType: 'script' })).toThrow();
});
