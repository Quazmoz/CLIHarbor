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

  test('a fast answer clears the timer and passes the response through', async () => {
    vi.useFakeTimers();
    const ok = new Response('{}', { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async () => ok));
    await expect(fetchWithDeadline('/x', {}, 1_000)).resolves.toBe(ok);
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
