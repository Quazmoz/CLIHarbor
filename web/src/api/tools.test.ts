import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchTools } from './tools';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchTools', () => {
  test('accepts bounded vendor-session readiness metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response(200, {
            tools: [
              {
                packId: 'cyberark-conjur-v9',
                packName: 'CyberArk / Idira Secrets Manager CLI 9.x',
                packVersion: '0.1.2',
                toolId: 'conjur',
                status: 'ready',
                version: '9.3.1',
                requiresVendorSession: true,
                sessionCheck: {
                  commandId: 'whoami',
                  unauthenticatedStderrContains: 'please login again',
                },
                credentialLogin: {
                  method: 'conjur-password',
                },
              },
              {
                packId: 'kubectl-cli',
                packName: 'Kubernetes kubectl',
                packVersion: '0.1.0',
                toolId: 'kubectl',
                status: 'ready',
                requiresVendorSession: true,
              },
            ],
          }),
        ),
      ),
    );

    const diagnostics = await fetchTools();
    expect(diagnostics[0].requiresVendorSession).toBe(true);
    expect(diagnostics[0].sessionCheck).toEqual({
      commandId: 'whoami',
      unauthenticatedStderrContains: 'please login again',
    });
    expect(diagnostics[0].credentialLogin).toEqual({ method: 'conjur-password' });
    expect(diagnostics[1].requiresVendorSession).toBe(true);
    expect(diagnostics[1].sessionCheck).toBeUndefined();
  });

  test.each([
    {
      requiresVendorSession: false,
      sessionCheck: { commandId: 'whoami' },
    },
    {
      requiresVendorSession: true,
      sessionCheck: { commandId: '--whoami' },
    },
    {
      requiresVendorSession: true,
      sessionCheck: { commandId: 'whoami', unauthenticatedStderrContains: ' signed out ' },
    },
    {
      requiresVendorSession: true,
      sessionCheck: { commandId: 'whoami', unauthenticatedStderrContains: 'signed\nout' },
    },
    {
      requiresVendorSession: false,
      credentialLogin: { method: 'conjur-password' },
    },
    {
      requiresVendorSession: true,
      credentialLogin: { method: 'unsupported-method' },
    },
  ])('rejects malformed or inconsistent session metadata: %j', async (metadata) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response(200, {
            tools: [
              {
                packId: 'fixture',
                packName: 'Fixture',
                packVersion: '1.0.0',
                toolId: 'fixture',
                status: 'ready',
                ...metadata,
              },
            ],
          }),
        ),
      ),
    );

    await expect(fetchTools()).rejects.toBeDefined();
  });
});
