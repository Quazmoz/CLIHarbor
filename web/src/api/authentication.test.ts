import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppError } from './errors';
import { loginWithCredentials } from './authentication';

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
    ).rejects.toMatchObject<AppError>({
      detail: {
        code: 'authentication_failed',
        category: 'security',
      },
    });
  });
});
