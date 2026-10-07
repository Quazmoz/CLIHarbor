import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchPlatforms } from './platforms';

afterEach(() => vi.unstubAllGlobals());

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('fetchPlatforms', () => {
  test('parses dedicated platforms and drops unknown features', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { platforms: [{
      id: 'conjur', name: 'CyberArk Conjur', summary: 's', packId: 'cyberark-conjur-v9', toolId: 'conjur', ready: true,
      features: [{ id: 'security-audit', name: 'Security audit' }, { id: 'remote-shell', name: 'Nope' }],
    }] }))));
    await expect(fetchPlatforms()).resolves.toEqual([{
      id: 'conjur', name: 'CyberArk Conjur', summary: 's', packId: 'cyberark-conjur-v9', toolId: 'conjur', ready: true,
      features: [{ id: 'security-audit', name: 'Security audit' }],
    }]);
  });

  test('rejects malformed platform ids', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { platforms: [{
      id: '../x', name: 'X', summary: '', packId: 'p', toolId: 't', ready: false, features: [],
    }] }))));
    await expect(fetchPlatforms()).rejects.toBeTruthy();
  });
});
