import { clientError } from './errors';

/**
 * Upper bounds for idempotent reads against the loopback runtime.
 *
 * Without a bound, a read whose handler blocks (a wedged vendor probe, a
 * stalled filesystem, a suspended runtime) leaves the UI spinning forever:
 * the server-side WriteTimeout only fails the eventual write, it never
 * answers the browser. Mutations (run start, sign-in, install) are NOT
 * routed through here: they can legitimately take minutes and must not be
 * abandoned client-side while the backend keeps working.
 */
export const READ_TIMEOUTS = {
  /** Cheap in-memory reads: status, tasks, runs, audit, platforms. */
  fast: 15_000,
  /** Reads that may run bounded discovery/version probes (tool doctor). */
  probe: 60_000,
} as const;

/**
 * fetch() with a deadline that composes with the caller's AbortSignal.
 *
 * - Caller abort keeps its AbortError, which components already ignore on
 *   unmount or superseded requests.
 * - Deadline expiry becomes AppError('request_timeout'), which components
 *   render as a retryable error instead of silently discarding it.
 *
 * Buffer the bounded runtime response under the same deadline. Headers alone
 * are not completion: a suspended runtime may stop midway through its body.
 */
export async function fetchWithDeadline(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal ?? undefined;
  let timedOut = false;

  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    forwardAbort();
  } else {
    callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('The local runtime did not answer in time.', 'TimeoutError'));
  }, timeoutMs);

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = response.body === null ? null : await response.arrayBuffer();
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    if (timedOut && !callerSignal?.aborted) {
      throw clientError('request_timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}
