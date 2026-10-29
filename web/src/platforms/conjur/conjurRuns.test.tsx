import { useEffect } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cancelRun, createRun, fetchRun, subscribeRunEvents, type RunSnapshot } from '../../api/runs';
import type { Task } from '../../api/tasks';
import { clientError } from '../../api/errors';
import { listIDs, PACK, TOOL, useConjurInventory, type InventoryKind } from './conjurRuns';

vi.mock('../../api/runs', async (original) => ({
  ...(await original<typeof import('../../api/runs')>()),
  cancelRun: vi.fn(), createRun: vi.fn(), fetchRun: vi.fn(), subscribeRunEvents: vi.fn(),
}));

const tasks: Task[] = [{ packId: PACK, packName: 'Conjur', toolId: TOOL,
  commandId: 'list-resources', name: 'List resources', risk: 'read', requiresAuth: true, inputs: [] }];
const kinds: readonly InventoryKind[] = ['variable', 'group'];
const props = { account: 'dev' as string | undefined, tasks, kinds };
const run = (ids: string[] = [], status: RunSnapshot['status'] = 'exited'): RunSnapshot => ({
  runId: 'a'.repeat(32), packId: PACK, toolId: TOOL, commandId: 'list-resources', status,
  ...(status === 'exited' ? { exitCode: 0 } : {}),
  events: [{ sequence: 1, type: 'stdout.chunk', timestamp: '', dataBase64: btoa(JSON.stringify(ids)) }],
});
const page = Array.from({ length: 100 }, (_, i) => 'dev:variable:item-' + i);

function useInventory(current: typeof props) {
  const inventory = useConjurInventory('csrf', current.account, current.tasks, current.kinds);
  const { load } = inventory;
  useEffect(() => { void load(); }, [load]);
  return inventory;
}

beforeEach(() => {
  vi.mocked(createRun).mockResolvedValue(run());
  vi.mocked(cancelRun).mockResolvedValue({ ...run(), status: 'cancelled' });
  vi.mocked(subscribeRunEvents).mockReturnValue(vi.fn());
});
afterEach(() => vi.resetAllMocks());

test('unmount stops later pages and kinds even when the pending start ignores abort', async () => {
  let finish!: (snapshot: RunSnapshot) => void;
  vi.mocked(createRun).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { unmount } = renderHook(useInventory, { initialProps: props });
  expect(createRun).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(createRun).mock.calls[0][2];
  unmount();
  await act(async () => finish(run(page)));
  expect(signal?.aborted).toBe(true);
  expect(createRun).toHaveBeenCalledTimes(1);
});

test('cancels a known running inventory read and closes its event stream on unmount', async () => {
  const close = vi.fn();
  vi.mocked(subscribeRunEvents).mockReturnValue(close);
  vi.mocked(createRun).mockResolvedValueOnce(run([], 'running'));
  const { unmount } = renderHook(useInventory, { initialProps: props });
  await waitFor(() => expect(subscribeRunEvents).toHaveBeenCalledTimes(1));
  unmount();
  await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('csrf', 'a'.repeat(32)));
  expect(close).toHaveBeenCalledTimes(1);
  expect(fetchRun).not.toHaveBeenCalled();
  expect(createRun).toHaveBeenCalledTimes(1);
});

test('cancels a running read acknowledged after its form has already unmounted', async () => {
  let finish!: (snapshot: RunSnapshot) => void;
  vi.mocked(createRun).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { unmount } = renderHook(useInventory, { initialProps: props });
  unmount();
  await act(async () => finish(run([], 'running')));
  expect(cancelRun).toHaveBeenCalledTimes(1);
  expect(subscribeRunEvents).not.toHaveBeenCalled();
  expect(createRun).toHaveBeenCalledTimes(1);
});

test('aborts pending terminal reconciliation and ignores queued completion callbacks', async () => {
  vi.mocked(createRun).mockResolvedValueOnce(run([], 'running'));
  let finish!: (snapshot: RunSnapshot) => void;
  vi.mocked(fetchRun).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { unmount } = renderHook(useInventory, { initialProps: props });
  await waitFor(() => expect(subscribeRunEvents).toHaveBeenCalledTimes(1));
  const [, , complete, failed] = vi.mocked(subscribeRunEvents).mock.calls[0];
  await act(async () => failed(clientError('stream_disconnected')));
  expect(fetchRun).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(fetchRun).mock.calls[0][1];
  unmount();
  await act(async () => {
    complete({ ...run(), sequence: 1 });
    finish(run(page));
  });
  expect(signal?.aborted).toBe(true);
  expect(fetchRun).toHaveBeenCalledTimes(1);
  expect(cancelRun).toHaveBeenCalledTimes(1);
  expect(createRun).toHaveBeenCalledTimes(1);
});

test('discards a late old-account response without blocking or unlocking the current load', async () => {
  let old!: (snapshot: RunSnapshot) => void;
  let current!: (snapshot: RunSnapshot) => void;
  vi.mocked(createRun)
    .mockImplementationOnce(() => new Promise((resolve) => { old = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { current = resolve; }));
  const { result, rerender } = renderHook(useInventory, { initialProps: props });
  rerender({ ...props, account: 'next' });
  expect(createRun).toHaveBeenCalledTimes(2);
  await act(async () => old(run(page)));
  expect(result.current.inventory).toBeNull();
  expect(result.current.state).toBe('loading');
  await act(async () => result.current.load());
  expect(createRun).toHaveBeenCalledTimes(2);
  await act(async () => current(run(['next:variable:current'])));
  await waitFor(() => expect(result.current.inventory).toEqual({ variable: ['current'], group: [] }));
});

test('clears loaded options when inventory authority disappears', async () => {
  vi.mocked(createRun).mockResolvedValueOnce(run(['dev:variable:old']));
  const { result, rerender } = renderHook(useInventory, { initialProps: props });
  await waitFor(() => expect(result.current.inventory?.variable).toEqual(['old']));
  rerender({ ...props, tasks: [] });
  expect(result.current.inventory).toBeNull();
  expect(result.current.state).toBe('idle');
  await act(async () => result.current.load());
  expect(createRun).toHaveBeenCalledTimes(2);
});

test('StrictMode cleanup cannot revive an abandoned inventory load', async () => {
  let old!: (snapshot: RunSnapshot) => void;
  vi.mocked(createRun).mockImplementationOnce(() => new Promise((resolve) => { old = resolve; }));
  const { result } = renderHook(useInventory, { initialProps: props, reactStrictMode: true });
  await waitFor(() => expect(result.current.inventory).toEqual({ variable: [], group: [] }));
  const requests = vi.mocked(createRun).mock.calls.length;
  await act(async () => old(run(page)));
  expect(result.current.inventory).toEqual({ variable: [], group: [] });
  expect(createRun).toHaveBeenCalledTimes(requests);
});

test('failed refresh removes prior options and remains retryable', async () => {
  vi.mocked(createRun).mockResolvedValueOnce(run(['dev:variable:old']));
  const { result } = renderHook(useInventory, { initialProps: props });
  await waitFor(() => expect(result.current.inventory?.variable).toEqual(['old']));
  vi.mocked(createRun).mockRejectedValueOnce(new Error('untrusted vendor failure'));
  await act(async () => result.current.load());
  expect(result.current.inventory).toBeNull();
  expect(result.current.state).toBe('failed');
  await act(async () => result.current.load());
  expect(result.current.inventory).toEqual({ variable: [], group: [] });
  expect(result.current.state).toBe('idle');
});

test('an already-aborted inventory request never starts a CLI run', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(listIDs('csrf', 'dev', 'variable', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(createRun).not.toHaveBeenCalled();
});
