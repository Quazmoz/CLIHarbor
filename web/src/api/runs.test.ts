import { afterEach, describe, expect, test, vi } from 'vitest';
import { decodeRunOutput, subscribeRunEvents, type RunSnapshot } from './runs';

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
