import { expect, test } from 'vitest';
import { refreshTool } from './tools';
import { installFakeBackend } from '../test/fakeBackend';

test('refresh sends only approved tool identity and CSRF, with no install or executable selection', async () => {
  const backend = installFakeBackend({ 'POST /api/v1/tools/refresh': { body: { status: 'ready', ready: true, message: 'Verified.' } } });
  await expect(refreshTool('csrf', 'example', 'example')).resolves.toEqual({ status: 'ready', ready: true, message: 'Verified.' });
  expect(backend.bodies('POST /api/v1/tools/refresh')).toEqual([{ packId: 'example', toolId: 'example' }]);
  expect(backend.calls('POST /api/v1/tools/refresh')[0].headers.get('X-CLIHarbor-CSRF')).toBe('csrf');
});

test.each([
  { status: 'unknown', ready: false, message: 'Unknown' },
  { status: 'missing', ready: true, message: 'Mismatch' },
  { status: 'ready', ready: false, message: 'Mismatch' },
  { status: 'ready', ready: true, message: 'unsafe\ntext' },
  { status: 'ready', ready: true, message: 'Verified', executable: 'arbitrary' },
])('rejects ambiguous refresh metadata: %j', async (body) => {
  installFakeBackend({ 'POST /api/v1/tools/refresh': { body } });
  await expect(refreshTool('csrf', 'example', 'example')).rejects.toThrow();
});
