import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SecretAuditPage } from './SecretAuditPage';
import { parseSecretAuditSnapshot } from './api/secretAudit';

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

afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  return render(<SecretAuditPage csrfToken="csrf-audit" onOpenAuthentication={() => undefined} onOpenDiagnostics={() => undefined} />);
}

test('requires acknowledgement, sends only the reviewed request, and renders redacted findings', async () => {
  const completed = {
    ...base,
    state: 'completed',
    minimumConfidence: 'high',
    total: 3,
    processed: 3,
    inspected: 2,
    findings: [{ variableId: 'app/db/password', confidence: 'high', reason: 'exact_known_variable_reference' }],
    failures: [{ variableId: 'app/empty', code: 'no_value' }],
  };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return response(202, completed);
    return response(200, { ...base, state: 'idle' });
  });
  vi.stubGlobal('fetch', fetchMock);
  renderPage();

  const start = await screen.findByRole('button', { name: 'Start read-only audit' });
  expect(start).toBeDisabled();
  expect(screen.getByText('https://conjur.invalid')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('radio', { name: /Likely references only/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /authorized to read every variable/ }));
  fireEvent.click(start);

  expect(await screen.findByRole('heading', { name: '1 variable needs review' })).toBeInTheDocument();
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(post?.[0]).toBe('/api/v1/conjur/secret-audit');
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({ packId: 'cyberark-conjur-v9', toolId: 'conjur', minimumConfidence: 'high' });
  expect((post?.[1]?.headers as Record<string, string>)['X-CLIHarbor-CSRF']).toBe('csrf-audit');
  expect(screen.getByText('app/db/password')).toBeInTheDocument();
  expect(screen.getByText('Value is exactly the ID of another Conjur variable.')).toBeInTheDocument();
  expect(screen.getByText('1 variable could not be checked')).toBeInTheDocument();
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
});
