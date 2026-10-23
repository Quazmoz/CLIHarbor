import { describe, expect, test } from 'vitest';
import { bootRoutes, FakeBackend, FakeEventSource, installFakeBackend, jsonResponse, verifyAndResetFakeBackend } from './fakeBackend';

describe('FakeBackend', () => {
  test('routes by method and path, records parsed bodies and query', async () => {
    const backend = new FakeBackend({
      '/api/v1/tasks': { body: { tasks: ['a'] } },
      'post /api/v1/runs': (request) => ({ status: 202, body: { echo: request.body } }),
    });
    const tasks = await backend.fetch('/api/v1/tasks?filter=x');
    expect(await tasks.json()).toEqual({ tasks: ['a'] });
    const run = await backend.fetch('/api/v1/runs', { method: 'POST', body: JSON.stringify({ packId: 'p' }), headers: { 'X-CSRF-Token': 't' } });
    expect(run.status).toBe(202);
    expect(await run.json()).toEqual({ echo: { packId: 'p' } });
    expect(backend.calls('/api/v1/tasks')[0].query.get('filter')).toBe('x');
    expect(backend.bodies('POST /api/v1/runs')).toEqual([{ packId: 'p' }]);
    expect(backend.calls('POST /api/v1/runs')[0].headers.get('x-csrf-token')).toBe('t');
  });

  test('later routes override earlier ones, so tests can patch bootRoutes()', async () => {
    const backend = new FakeBackend(bootRoutes()).on({ 'GET /api/v1/tasks': { status: 503, body: { error: { code: 'x' } } } });
    expect((await backend.fetch('/api/v1/tasks')).status).toBe(503);
    expect((await backend.fetch('/api/v1/status')).status).toBe(200);
  });

  test('an unhandled request is recorded and fails verification with the route named', async () => {
    const backend = installFakeBackend();
    const reply = await fetch('/api/v1/typo?x=1');
    expect(reply.ok).toBe(false);
    expect(backend.unhandled).toEqual(['GET /api/v1/typo?x=1']);
    expect(() => verifyAndResetFakeBackend()).toThrow(/GET \/api\/v1\/typo\?x=1/);
  });

  test('honours an already-aborted signal like real fetch', async () => {
    const backend = new FakeBackend(bootRoutes());
    const controller = new AbortController();
    controller.abort();
    await expect(backend.fetch('/api/v1/status', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('handlers may return a raw Response', async () => {
    const backend = new FakeBackend({ '/x': () => jsonResponse(201, { ok: true }) });
    expect((await backend.fetch('/x')).status).toBe(201);
  });
});

describe('FakeEventSource', () => {
  test('delivers named events to every listener and stops after close', () => {
    const source = new FakeEventSource('/api/v1/runs/r/events');
    const seen: unknown[] = [];
    source.addEventListener('output', (event) => seen.push(JSON.parse((event as MessageEvent).data)));
    source.addEventListener('output', () => seen.push('second'));
    source.emit('output', { line: 1 });
    source.close();
    source.emit('output', { line: 2 });
    expect(seen).toEqual([{ line: 1 }, 'second']);
    expect(FakeEventSource.latest).toBe(source);
  });
});
