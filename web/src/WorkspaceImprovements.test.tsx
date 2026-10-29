import { StrictMode, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { App } from './App';
import { OperationActivity, OperationActivityProvider, useMutationActivity, useOperationActivity } from './OperationActivity';
import type { Task } from './api/tasks';
import { bootRoutes, installFakeBackend } from './test/fakeBackend';

const task: Task = { packId: 'example', packName: 'Example', toolId: 'example', commandId: 'whoami', name: 'Who am I',
  risk: 'read', requiresAuth: true, inputs: [] };
const tool = { packId: 'example', packName: 'Example', packVersion: '1.0.0', toolId: 'example', status: 'ready',
  requiresVendorSession: true, sessionCheck: { commandId: 'whoami' } };
const run = { runId: 'a'.repeat(32), packId: 'example', toolId: 'example', commandId: 'whoami', status: 'exited', exitCode: 0, events: [] };
const tasks = [task];

test('App guards route links and browser Back during a mutation and keeps pending work visible after an approved leave', async () => {
  window.history.replaceState({}, '', '/tasks');
  const change: Task = { ...task, commandId: 'change', name: 'Change example', risk: 'change',
    impact: { targetInput: 'id', targetLabel: 'Variable', effect: 'Update', scope: 'single' },
    inputs: [{ id: 'id', type: 'string', label: 'Variable ID', required: true, validation: { maxLength: 64 } }] };
  let finish!: (value: { status: number; body: typeof run }) => void;
  const waiting = new Promise<{ status: number; body: typeof run }>((resolve) => { finish = resolve; });
  installFakeBackend({ ...bootRoutes({ tools: [tool], tasks: [change] }),
    '/api/v1/platforms': { body: { platforms: [] } },
    'POST /api/v1/runs': () => waiting,
    'POST /api/v1/runs/preview': { body: {
      packId: 'example', commandId: 'change', toolId: 'example', executableName: 'example', args: ['change'], risk: 'change',
      impact: { targetLabel: 'Variable', target: 'apps/example', effect: 'Update', scope: 'single' },
      context: { fields: [{ label: 'Account', value: 'test-account' }, { label: 'Endpoint', value: 'https://example.test' }] },
      approval: { id: 'b'.repeat(32), mode: 'explicit', expiresAt: '2099-01-01T00:00:00Z' },
    } },
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<App />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Variable ID' }), { target: { value: 'apps/example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
  const start = await screen.findByRole('button', { name: 'Approve change and run' });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  fireEvent.click(screen.getByRole('link', { name: 'Diagnostics' }));
  expect(window.location.pathname).toBe('/tasks');
  expect(confirm).toHaveBeenCalled();
  window.history.pushState({}, '', '/runs');
  fireEvent.popState(window);
  expect(window.location.pathname).toBe('/tasks');
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('link', { name: 'Diagnostics' }));
  expect(window.location.pathname).toBe('/diagnostics');
  expect(screen.getByText('Working…')).toBeInTheDocument();
  await act(async () => finish({ status: 202, body: { ...run, commandId: 'change' } }));
  await waitFor(() => expect(screen.queryByText('Working…')).not.toBeInTheDocument());
  confirm.mockRestore();
});

test('quick session checks use the declared command once in StrictMode and do not rerun on later navigation', async () => {
  window.history.replaceState({}, '', '/tasks');
  const backend = installFakeBackend({ ...bootRoutes({ tools: [tool], tasks }),
    '/api/v1/platforms': { body: { platforms: [] } }, 'POST /api/v1/runs': { status: 202, body: run } });
  render(<StrictMode><App /></StrictMode>);
  fireEvent.click(await screen.findByLabelText(/CLI sign-in status, /));
  fireEvent.click(screen.getByRole('button', { name: 'Check session for Example / example' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check session for Example / example' }));
  expect(await screen.findByRole('heading', { name: 'Authenticated' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/authentication');
  expect(backend.bodies('POST /api/v1/runs')).toEqual([{ packId: 'example', commandId: 'whoami', values: {} }]);
  fireEvent.click(screen.getByRole('link', { name: 'Command Builder' }));
  fireEvent.click(screen.getByRole('link', { name: 'Sign in' }));
  expect(screen.getByRole('heading', { name: 'Authenticated' })).toBeInTheDocument();
  expect(backend.calls('POST /api/v1/runs')).toHaveLength(1);
});

test('missing-tool refresh is single flight and publishes qualified tasks without running them', async () => {
  window.history.replaceState({}, '', '/tools');
  let finish!: (value: { body: { status: string; ready: boolean; message: string } }) => void;
  const waiting = new Promise<{ body: { status: string; ready: boolean; message: string } }>((resolve) => { finish = resolve; });
  const backend = installFakeBackend({ ...bootRoutes({ tools: [{ ...tool, status: 'missing' }] }),
    '/api/v1/platforms': { body: { platforms: [] } }, 'POST /api/v1/tools/refresh': () => waiting });
  render(<App />);
  const check = await screen.findByRole('button', { name: 'Check installation of example' });
  fireEvent.click(check);
  fireEvent.click(check);
  expect(screen.getByRole('button', { name: 'Checking installation…' })).toBeDisabled();
  expect(backend.bodies('POST /api/v1/tools/refresh')).toEqual([{ packId: 'example', toolId: 'example' }]);
  expect(backend.calls('POST /api/v1/tools/refresh')[0].headers.get('X-CLIHarbor-CSRF')).toBe('test-csrf');
  backend.on({ '/api/v1/tools': { body: { tools: [tool] } }, '/api/v1/tasks': { body: { tasks } } });
  await act(async () => finish({ body: { status: 'ready', ready: true, message: 'CLI verified and ready.' } }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open 1 task' }));
  expect(window.location.pathname).toBe('/tasks');
  expect(screen.getByRole('heading', { name: 'Who am I', level: 4 })).toBeInTheDocument();
  expect(backend.calls('POST /api/v1/runs')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Check installation of example' })).not.toBeInTheDocument();
});

test('activity opens the exact run and preserves observed running metadata through a failed refresh', async () => {
  const onOpen = vi.fn();
  const backend = installFakeBackend({ '/api/v1/runs': { body: { runs: [{ ...run, events: undefined, status: 'running', exitCode: undefined }] } } });
  render(<OperationActivityProvider><OperationActivity tasks={tasks} onOpen={onOpen} /></OperationActivityProvider>);
  await screen.findByText('1 running');
  fireEvent.click(screen.getByLabelText(/^Operation activity,/));
  const panel = within(screen.getByLabelText(/^Operation activity,/).closest('details')!);
  fireEvent.click(panel.getByRole('link', { name: 'Details' }));
  expect(onOpen).toHaveBeenCalledWith('/runs', run.runId);
  backend.on({ '/api/v1/runs': () => { throw new Error('untrusted-error-must-not-render'); } });
  fireEvent.click(screen.getByLabelText(/^Operation activity,/));
  fireEvent.click(panel.getByRole('button', { name: 'Refresh activity' }));
  expect(await panel.findByText(/Activity could not be refreshed/)).toBeInTheDocument();
  expect(screen.getByText('Activity unavailable')).toBeInTheDocument();
  expect(panel.getByText('example · Running')).toBeInTheDocument();
  expect(screen.queryByText('untrusted-error-must-not-render')).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByLabelText(/^Operation activity,/), { key: 'Escape' });
  expect(screen.getByLabelText(/^Operation activity,/).closest('details')).not.toHaveAttribute('open');
});

test('pending mutation activity survives unmount, warns before leaving, and clears only when its request settles', async () => {
  installFakeBackend({ '/api/v1/runs': { body: { runs: [] } } });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  function Work() {
    const begin = useMutationActivity();
    return <button onClick={() => { const done = begin('Creating a secret…'); void waiting.finally(done); }}>Start change</button>;
  }
  function Harness() {
    const [shown, setShown] = useState(true);
    const activity = useOperationActivity();
    return <><OperationActivity tasks={tasks} onOpen={() => {}} />{shown && <Work />}
      <button onClick={() => { if (activity.confirmNavigation('/different-page')) setShown(false); }}>Leave workflow</button></>;
  }
  render(<OperationActivityProvider><Harness /></OperationActivityProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Start change' }));
  fireEvent.click(screen.getByRole('button', { name: 'Leave workflow' }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('later guided steps stop'));
  expect(screen.getByRole('button', { name: 'Start change' })).toBeInTheDocument();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Leave workflow' }));
  expect(screen.queryByRole('button', { name: 'Start change' })).not.toBeInTheDocument();
  expect(screen.getByText('Working…')).toBeInTheDocument();
  const leaving = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(true);
  await act(async () => finish());
  await waitFor(() => expect(screen.queryByText('Working…')).not.toBeInTheDocument());
  const settled = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(settled);
  expect(settled.defaultPrevented).toBe(false);
  confirm.mockRestore();
});
