import { afterEach, describe, expect, test, vi } from 'vitest';
import { cancelRun, createRun, createRunOutputDecoder, decodeRunOutput, fetchRun, previewRun, subscribeRunEvents, type RunSnapshot } from './runs';

const runId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const timestamp = '2026-10-05T10:00:00Z';
const base: RunSnapshot = { runId, packId: 'fixture', commandId: 'inspect', toolId: 'fixture', status: 'exited' };
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

class FakeEventSource {
  static latest: FakeEventSource;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, EventListener>();
  readyState = 0;
  close = vi.fn();
  constructor() { FakeEventSource.latest = this; }
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener); }
  emit(type: string, value: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(value) }));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('run output decoding', () => {
  test.each(['café 🚢 日本語', 'Hello <script>世界</script>', '\uFEFFfirst\uFEFFsecond'])('preserves UTF-8 at every byte boundary: %s', (text) => {
    const bytes = new TextEncoder().encode(text);
    for (let split = 1; split < bytes.length; split += 1) {
      const snapshot = { ...base, events: [
        { sequence: 1, type: 'stdout.chunk', timestamp, dataBase64: base64(bytes.slice(0, split)) },
        { sequence: 2, type: 'stderr.chunk', timestamp, dataBase64: btoa('separate error') },
        { sequence: 3, type: 'stdout.chunk', timestamp, dataBase64: base64(bytes.slice(split)) },
      ] };
      // TextDecoder consumes only an initial byte-order mark, across chunks.
      expect(decodeRunOutput(snapshot, 'stdout.chunk')).toBe(text.replace(/^\uFEFF/u, ''));
      expect(decodeRunOutput(snapshot, 'stderr.chunk')).toBe('separate error');
    }
  });

  test('holds incomplete bytes while running and flushes malformed terminal output', () => {
    const events = [{ sequence: 1, type: 'stdout.chunk', timestamp, dataBase64: base64(Uint8Array.of(0xf0, 0x9f)) }];
    expect(decodeRunOutput({ ...base, status: 'running', events }, 'stdout.chunk')).toBe('');
    expect(decodeRunOutput({ ...base, events }, 'stdout.chunk')).toBe('\uFFFD');
  });

  test('incremental decoder matches a full decode across appends, completion, and a replaced log', () => {
    const bytes = new TextEncoder().encode('héllo 😀 world');
    const chunk = (sequence: number, type: string, data: Uint8Array) => ({ sequence, type, timestamp, dataBase64: base64(data) });
    const all = [
      chunk(1, 'stdout.chunk', bytes.slice(0, 2)), // splits the two-byte é
      chunk(2, 'stderr.chunk', new TextEncoder().encode('err')),
      chunk(3, 'stdout.chunk', bytes.slice(2, 9)), // splits the four-byte emoji
      chunk(4, 'stdout.chunk', bytes.slice(9)),
    ];
    const full = (snapshot: RunSnapshot) => ({ stdout: decodeRunOutput(snapshot, 'stdout.chunk'), stderr: decodeRunOutput(snapshot, 'stderr.chunk') });
    const decode = createRunOutputDecoder();
    let events: typeof all = [];
    for (const event of all) {
      events = [...events, event];
      const running: RunSnapshot = { ...base, status: 'running', events };
      expect(decode(running)).toEqual(full(running));
    }
    const done: RunSnapshot = { ...base, events };
    expect(decode(done)).toEqual(full(done));
    expect(decode(done)).toEqual(full(done));
    const replaced: RunSnapshot = { ...base, runId: 'b'.repeat(32), events: [chunk(1, 'stdout.chunk', new TextEncoder().encode('next'))] };
    expect(decode(replaced)).toEqual({ stdout: 'next', stderr: '' });
  });
});

describe('run stream lifecycle', () => {
  const event = (sequence: number) => ({ runId, sequence, type: 'stdout.chunk', timestamp, dataBase64: btoa('output') });
  const subscribe = (afterSequence = 0) => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onEvent = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();
    const close = subscribeRunEvents(runId, onEvent, onComplete, onError, undefined, afterSequence);
    return { source: FakeEventSource.latest, onEvent, onComplete, onError, close };
  };

  test('skips snapshot overlap and repeated/out-of-order events, and accepts completion at the last cursor', () => {
    const { source, onEvent, onComplete, onError } = subscribe(2);
    for (const sequence of [1, 2, 3, 3, 2, 4]) source.emit('run-event', event(sequence));
    expect(onEvent.mock.calls.map(([value]) => value.sequence)).toEqual([3, 4]);
    source.emit('run-complete', { runId, sequence: 4, status: 'exited', exitCode: 0 });
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });


  test('rejects a missing event instead of silently displaying incomplete output', () => {
    const { source, onEvent, onComplete, onError } = subscribe();
    source.emit('run-event', event(1));
    source.emit('run-event', event(3));
    expect(onEvent.mock.calls.map(([value]) => value.sequence)).toEqual([1]);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].detail.code).toBe('invalid_response');
    expect(source.close).toHaveBeenCalledOnce();
    source.emit('run-event', event(2));
    expect(onEvent).toHaveBeenCalledOnce();
  });

  test('rejects completion reporting unseen events after the last delivered cursor', () => {
    const { source, onEvent, onComplete, onError } = subscribe(2);
    source.emit('run-event', event(3));
    source.emit('run-complete', { runId, sequence: 4, status: 'exited', exitCode: 0 });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].detail.code).toBe('invalid_response');
    expect(source.close).toHaveBeenCalledOnce();
  });

  test('rejects missing first event when subscribing without a snapshot cursor', () => {
    const { source, onEvent, onComplete, onError } = subscribe();
    source.emit('run-event', event(2));
    expect(onEvent).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].detail.code).toBe('invalid_response');
  });

  test('exhausts the retry budget even when each empty connection opens', () => {
    const { source, onError } = subscribe();
    for (let i = 0; i < 5; i += 1) { source.onopen?.(); source.onerror?.(); }
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].detail.code).toBe('stream_disconnected');
    source.onerror?.();
    expect(onError).toHaveBeenCalledOnce();
  });

  test('reports a permanently closed source immediately rather than waiting for errors that cannot recur', () => {
    const { source, onError } = subscribe();
    source.readyState = 2;
    source.onerror?.();
    expect(onError).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
  });

  test.each([
    { runId, sequence: 0, status: 'exited' },
    { runId, sequence: 1, status: 'running' },
  ])('rejects stale or nonterminal completion: %j', (completion) => {
    const { source, onComplete, onError } = subscribe();
    source.emit('run-event', event(1));
    source.emit('run-complete', completion);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0].detail.code).toBe('invalid_response');
  });

  test('resets retry budget after a new validated event', () => {
    const { source, onError } = subscribe();
    source.onerror?.(); source.onerror?.();
    source.emit('run-event', event(1));
    for (let i = 0; i < 4; i += 1) source.onerror?.();
    expect(onError).not.toHaveBeenCalled();
    source.onerror?.();
    expect(onError).toHaveBeenCalledOnce();
  });

  test.each(['run-event', 'run-complete'])('fails closed on wrong-run %s', (type) => {
    const { source, onEvent, onComplete, onError } = subscribe();
    source.emit(type, type === 'run-event' ? { ...event(1), runId: 'wrong' } : { runId: 'wrong', sequence: 1, status: 'exited' });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0].detail.code).toBe('invalid_response');
    expect(source.close).toHaveBeenCalledOnce();
  });

  test('ignores queued callbacks after unsubscribe', () => {
    const { source, onEvent, onComplete, onError, close } = subscribe();
    close();
    source.emit('run-event', event(1));
    source.emit('run-complete', { runId, sequence: 1, status: 'exited' });
    source.onerror?.();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('run API request/response identity', () => {
  const request = { packId: 'fixture', commandId: 'inspect', values: {} };
  const preview = {
    packId: 'fixture', commandId: 'inspect', toolId: 'fixture',
    executableName: 'fixture', args: [], risk: 'read',
  };
  const serve = (payload: unknown) => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  test.each([
    ['pack', { ...preview, packId: 'other-pack' }],
    ['command', { ...preview, commandId: 'other-command' }],
  ])('rejects a preview for the wrong %s', async (_identity, payload) => {
    serve(payload);
    await expect(previewRun('csrf', request)).rejects.toMatchObject({
      detail: { code: 'invalid_response' },
    });
  });

  test.each([
    ['pack', { ...base, packId: 'other-pack' }],
    ['command', { ...base, commandId: 'other-command' }],
  ])('rejects creation responses for the wrong %s', async (_identity, payload) => {
    serve(payload);
    await expect(createRun('csrf', request)).rejects.toMatchObject({
      detail: { code: 'run_start_unknown', retryable: false },
    });
  });

  test.each(['network', 'truncated body', 'internal error'])('reports %s after submission as unknown without retrying', async (failure) => {
    const fetchMock = vi.fn(async () => {
      if (failure === 'network') throw new TypeError('connection lost');
      if (failure === 'truncated body') return new Response('{', { status: 202 });
      return new Response(JSON.stringify({ error: {
        code: 'internal_error', category: 'internal', message: 'The local runtime encountered an internal error.', retryable: false,
      } }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(createRun('csrf', { ...request, approval: { id: 'approval' } })).rejects.toMatchObject({
      detail: { code: 'run_start_unknown', retryable: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('preserves a confirmed rejection and caller cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: {
      code: 'approval_required', category: 'policy', message: 'A fresh approval is required.', retryable: false,
    } }), { status: 403 })));
    await expect(createRun('csrf', request)).rejects.toMatchObject({ detail: { code: 'approval_required' } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('abandoned', 'AbortError'); }));
    await expect(createRun('csrf', request)).rejects.toMatchObject({ name: 'AbortError' });
  });

  test.each(['fetch', 'cancel'] as const)('rejects %s responses for another run', async (operation) => {
    serve({ ...base, runId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const result = operation === 'fetch' ? fetchRun(runId) : cancelRun('csrf', runId);
    await expect(result).rejects.toMatchObject({
      detail: { code: 'invalid_response' },
    });
  });


  test.each([
    ['missing first event', [{ sequence: 2, type: 'stdout.chunk', timestamp }]],
    ['skipped event', [{ sequence: 1, type: 'stdout.chunk', timestamp }, { sequence: 3, type: 'stdout.chunk', timestamp }]],
    ['duplicate event', [{ sequence: 1, type: 'stdout.chunk', timestamp }, { sequence: 1, type: 'stderr.chunk', timestamp }]],
    ['out-of-order events', [{ sequence: 2, type: 'stdout.chunk', timestamp }, { sequence: 1, type: 'stderr.chunk', timestamp }]],
    ['foreign run identity', [{ runId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', sequence: 1, type: 'stdout.chunk', timestamp }]],
  ])('rejects retained snapshot with %s', async (_caseName, events) => {
    serve({ ...base, events });
    await expect(fetchRun(runId)).rejects.toMatchObject({
      detail: { code: 'invalid_response' },
    });
  });

  test('accepts a complete ordered snapshot, including matching optional run identity', async () => {
    serve({ ...base, events: [
      { runId, sequence: 1, type: 'stdout.chunk', timestamp, dataBase64: btoa('first') },
      { sequence: 2, type: 'stderr.chunk', timestamp, dataBase64: btoa('second') },
    ] });
    await expect(fetchRun(runId)).resolves.toMatchObject({
      runId,
      events: [{ sequence: 1 }, { sequence: 2 }],
    });
  });

  test('passes the supplied cancellation signal into the run start request', async () => {
    const controller = new AbortController();
    const fetchMock = serve(base);
    await createRun('csrf', request, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/runs', expect.objectContaining({
      signal: controller.signal,
    }));
  });

  test('accepts matching task and run identities', async () => {
    serve(preview);
    await expect(previewRun('csrf', request)).resolves.toMatchObject({
      packId: request.packId, commandId: request.commandId,
    });
    serve(base);
    await expect(createRun('csrf', request)).resolves.toMatchObject({ runId });
    await expect(fetchRun(runId)).resolves.toMatchObject({ runId });
    await expect(cancelRun('csrf', runId)).resolves.toMatchObject({ runId });
  });
});
