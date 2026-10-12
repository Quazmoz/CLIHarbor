import { afterEach, describe, expect, test, vi } from 'vitest';
import { getVendorConnection, loginWithCredentials } from './authentication';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loginWithCredentials', () => {
  test('posts credentials only to the dedicated local auth endpoint with CSRF protection', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.credentials).toBe('same-origin');
      expect(init?.headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CLIHarbor-CSRF': 'csrf-token',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        packId: 'cyberark-conjur-v9',
        toolId: 'conjur',
        identity: 'alice',
        secret: 'super-secret',
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await loginWithCredentials('csrf-token', {
      packId: 'cyberark-conjur-v9',
      toolId: 'conjur',
      identity: 'alice',
      secret: 'super-secret',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/login');
  });

  test('accepts only the reviewed sanitized server error contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'authentication_failed',
                category: 'security',
                message: 'Vendor authentication was not accepted.',
                remediation: 'Re-enter the credential or use your organization\'s approved vendor authentication flow.',
                retryable: false,
              },
            }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
    );

    await expect(
      loginWithCredentials('csrf-token', {
        packId: 'cyberark-conjur-v9',
        toolId: 'conjur',
        identity: 'alice',
        secret: 'super-secret',
      }),
    ).rejects.toMatchObject({
      detail: {
        code: 'authentication_failed',
        category: 'security',
      },
    });
  });
});

describe('getVendorConnection', () => {
  const valid = {
    environment: 'saas',
    applianceUrl: 'https://example.invalid',
    account: 'team-ops',
    configurable: true,
  };

  test.each([
    ['applianceUrl', '\u0000'],
    ['applianceUrl', '\u001f'],
    ['applianceUrl', '\u007f'],
    ['account', '\u0000'],
    ['account', '\u001f'],
    ['account', '\u007f'],
  ])('rejects ASCII control characters in %s (%j)', async (field, control) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ ...valid, [field]: 'before' + control + 'after' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))));

    await expect(getVendorConnection()).rejects.toMatchObject({
      detail: { code: 'invalid_response' },
    });
  });

  test('accepts valid vendor response fields, including printable Unicode', async () => {
    const response = { ...valid, account: 'team-ops Δ', applianceUrl: 'https://example.invalid/app' };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify(response),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))));

    await expect(getVendorConnection()).resolves.toEqual(response);
  });
});
