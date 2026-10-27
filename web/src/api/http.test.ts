import { describe, expect, test, vi } from 'vitest';
import { AppError } from './errors';
import { fetchWithDeadline, READ_TIMEOUTS } from './http';
import { fetchRuntimeStatus } from './status';

/** A fetch that never answers until its signal aborts, like a wedged handler. */
function hangingFetch() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(init.signal.reason);
      return;
    }
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  }));
}

/** Headers arrive, but consuming either the JSON or byte body stalls. */
function hangingBodyFetch(status = 200, onRead = () => {}) {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const read = () => {
      onRead();
      return new Promise<never>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    };
    return Promise.resolve(Object.assign(new Response('{}', { status }), { arrayBuffer: read, json: read }));
  });
}

describe('fetchWithDeadline', () => {
  test('turns a stalled read into a retryable request_timeout AppError', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const pending = fetchWithDeadline('/api/v1/tasks', {}, 1_000);
    const assertion = expect(pending).rejects.toSatisfy((error: unknown) =>
      error instanceof AppError && error.detail.code === 'request_timeout' && error.detail.retryable);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  test('a caller abort stays an AbortError so unmounted components stay quiet', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    const pending = fetchWithDeadline('/api/v1/tasks', { signal: controller.signal }, 1_000);
    controller.abort(new DOMException('gone', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('an already-aborted caller signal never starts a deadline error', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    controller.abort(new DOMException('gone', 'AbortError'));
    await expect(fetchWithDeadline('/x', { signal: controller.signal }, 1_000)).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a fast answer clears the timer and preserves status, headers and body', async () => {
    vi.useFakeTimers();
    const ok = new Response('{}', { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async () => ok));
    const response = await fetchWithDeadline('/x', {}, 1_000);
    expect(response.status).toBe(ok.status);
    expect([...response.headers]).toEqual([...ok.headers]);
    await expect(response.json()).resolves.toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([200, 503])('bounds a stalled HTTP %s body after headers arrive', async (status) => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingBodyFetch(status));
    const pending = fetchWithDeadline('/x', {}, 1_000).then((response) => response.json());
    const assertion = expect(pending).rejects.toMatchObject({ detail: { code: 'request_timeout', retryable: true } });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  test('forwards caller abort while reading a body and releases the deadline', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let headersReady!: () => void;
    const ready = new Promise<void>((resolve) => { headersReady = resolve; });
    vi.stubGlobal('fetch', hangingBodyFetch(200, headersReady));
    const pending = fetchWithDeadline('/x', { signal: caller.signal }, 1_000).then((response) => response.json());
    await ready;
    caller.abort(new DOMException('superseded', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  test('network failures are not misreported as timeouts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchWithDeadline('/x', {}, 1_000)).rejects.toBeInstanceOf(TypeError);
  });

  test('status reads are bounded by the fast read deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const pending = fetchRuntimeStatus();
    const assertion = expect(pending).rejects.toMatchObject({ detail: { code: 'request_timeout' } });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUTS.fast);
    await assertion;
  });
});
