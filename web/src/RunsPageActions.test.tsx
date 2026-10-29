import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { RunsPage } from './RunsPage';
import { App } from './App';
import type { RunSnapshot } from './api/runs';
import type { Task } from './api/tasks';
import { bootRoutes, installFakeBackend, type RouteReply } from './test/fakeBackend';

const task: Task = { packId: 'fixture', packName: 'Fixture', commandId: 'inspect', name: 'Inspect resources', toolId: 'fixture', risk: 'read', inputs: [] };
const running: RunSnapshot = { runId: 'a'.repeat(32), packId: task.packId, commandId: task.commandId, toolId: task.toolId, status: 'running' };
const path = '/api/v1/runs/' + running.runId;
const cancelled = { ...running, status: 'cancelled' as const };

test('history cancellation is single-flight, carries CSRF and waits for the observed final outcome', async () => {
  let acknowledge!: (reply: RouteReply) => void;
  const response = new Promise<RouteReply>((resolve) => { acknowledge = resolve; });
  const backend = installFakeBackend({
    '/api/v1/runs': { body: { runs: [running] } }, [path]: { body: running },
    ['POST ' + path + '/cancel']: () => response,
  });
  render(<StrictMode><RunsPage tasks={[task]} csrfToken="browser-csrf" requestedRun={{ runId: running.runId }} /></StrictMode>);
  const cancel = await screen.findByRole('button', { name: 'Cancel this run' });
  cancel.focus();
  fireEvent.click(cancel);
  fireEvent.click(cancel);
  expect(screen.getByRole('button', { name: 'Requesting cancellation…' })).toBeDisabled();
  expect(backend.calls('POST ' + path + '/cancel')).toHaveLength(1);
  expect(backend.calls('POST ' + path + '/cancel')[0].headers.get('X-CLIHarbor-CSRF')).toBe('browser-csrf');
  await act(async () => acknowledge({ body: running }));
  expect(screen.getByText('Cancellation requested. Waiting for the final run outcome.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancellation requested' })).toBeDisabled();
  expect(screen.queryByText('Run finished: Cancelled.')).not.toBeInTheDocument();
  backend.on({ [path]: { body: cancelled }, '/api/v1/runs': { body: { runs: [cancelled] } } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh run' }));
  await screen.findByText('Run finished: Cancelled.');
  expect(screen.getByLabelText('Run cancellation')).toHaveFocus();
  expect(screen.queryByRole('button', { name: /Cancel this run|Cancellation requested/ })).not.toBeInTheDocument();
  expect(backend.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
});

test('a terminal observation wins over a late running cancellation acknowledgement', async () => {
  let acknowledge!: (reply: RouteReply) => void;
  const response = new Promise<RouteReply>((resolve) => { acknowledge = resolve; });
  const backend = installFakeBackend({
    '/api/v1/runs': { body: { runs: [running] } }, [path]: { body: running }, ['POST ' + path + '/cancel']: () => response,
  });
  render(<RunsPage tasks={[task]} csrfToken="browser-csrf" requestedRun={{ runId: running.runId }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel this run' }));
  backend.on({ [path]: { body: { ...running, status: 'exited', exitCode: 0 } } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh run' }));
  await screen.findByText('Run finished: Succeeded.');
  await act(async () => acknowledge({ body: running }));
  expect(screen.getByText('Run finished: Succeeded.')).toBeInTheDocument();
  expect(screen.queryByText(/Waiting for the final run outcome/)).not.toBeInTheDocument();
  expect(backend.calls('POST ' + path + '/cancel')).toHaveLength(1);
});

test('a lost cancellation acknowledgement retains output and permits an explicit cancellation retry', async () => {
  let reject!: (error: unknown) => void;
  const response = new Promise<RouteReply>((_, fail) => { reject = fail; });
  const snapshot = { ...running, events: [{ sequence: 1, type: 'stdout.chunk', timestamp: '2026-10-29T10:00:00Z', dataBase64: btoa('retained evidence') }] };
  const backend = installFakeBackend({
    '/api/v1/runs': { body: { runs: [running] } }, [path]: { body: snapshot }, ['POST ' + path + '/cancel']: () => response,
  });
  render(<RunsPage tasks={[task]} csrfToken="browser-csrf" requestedRun={{ runId: running.runId }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel this run' }));
  await act(async () => reject(new TypeError('network disconnected')));
  await screen.findByText(/Cancellation is unconfirmed/);
  expect(screen.getByRole('button', { name: 'Cancel this run' })).toBeEnabled();
  expect(screen.getByText('retained evidence')).toBeInTheDocument();
  backend.on({ ['POST ' + path + '/cancel']: { body: cancelled }, [path]: { body: cancelled } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel this run' }));
  await screen.findByText('Run finished: Cancelled.');
  expect(backend.calls('POST ' + path + '/cancel')).toHaveLength(2);
  expect(screen.queryByText(/Cancellation is unconfirmed/)).not.toBeInTheDocument();
});

test('leaving a pending cancellation cannot refresh or overwrite another selected run', async () => {
  let acknowledge!: (reply: RouteReply) => void;
  const response = new Promise<RouteReply>((resolve) => { acknowledge = resolve; });
  const other = { ...running, runId: 'b'.repeat(32), status: 'exited' as const, exitCode: 0 };
  const backend = installFakeBackend({
    '/api/v1/runs': { body: { runs: [running, other] } }, [path]: { body: running },
    ['/api/v1/runs/' + other.runId]: { body: other }, ['POST ' + path + '/cancel']: () => response,
  });
  const view = render(<RunsPage tasks={[task]} csrfToken="browser-csrf" requestedRun={{ runId: running.runId }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel this run' }));
  view.rerender(<RunsPage tasks={[task]} csrfToken="browser-csrf" requestedRun={{ runId: other.runId }} />);
  await screen.findByText('Command completed successfully. No stdout or stderr was returned.');
  const requests = backend.requests.length;
  await act(async () => acknowledge({ body: cancelled }));
  expect(backend.requests).toHaveLength(requests);
  expect(screen.getByText(other.runId)).toBeInTheDocument();
  expect(screen.queryByText('Run finished: Cancelled.')).not.toBeInTheDocument();
});

test('configuring history uses only a matching current task and respects the active-work guard', async () => {
  const completed = { ...running, status: 'exited' as const, exitCode: 0 };
  const open = vi.fn();
  const backend = installFakeBackend({ '/api/v1/runs': { body: { runs: [completed] } }, [path]: { body: completed } });
  const view = render(<RunsPage tasks={[task]} onConfigureTask={open} tasksLocked requestedRun={{ runId: running.runId }} />);
  const configure = await screen.findByRole('button', { name: 'Configure this task' });
  expect(configure).toBeDisabled();
  view.rerender(<RunsPage tasks={[task]} onConfigureTask={open} requestedRun={{ runId: running.runId }} />);
  fireEvent.click(configure);
  expect(open).toHaveBeenCalledExactlyOnceWith(task);
  view.rerender(<RunsPage tasks={[{ ...task, toolId: 'other-tool' }]} onConfigureTask={open} requestedRun={{ runId: running.runId }} />);
  expect(configure).toBeDisabled();
  expect(screen.getByText(/no longer available in the current CLI catalog/)).toBeInTheDocument();
  expect(backend.requests.every((request) => request.method === 'GET')).toBe(true);
});

test('history opens the command builder with fresh defaults and no new execution or preview', async () => {
  window.history.replaceState({}, '', '/tasks');
  const withInput = { ...task, inputs: [{ id: 'query', label: 'Query', type: 'string' as const, required: false }] };
  const completed = { ...running, status: 'exited' as const, exitCode: 0 };
  const backend = installFakeBackend({
    ...bootRoutes({ tasks: [withInput], runs: [completed] }),
    '/api/v1/platforms': { body: { platforms: [] } },
    [path]: { body: completed }, 'POST /api/v1/runs': { status: 202, body: completed },
  });
  render(<App />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Query' }), { target: { value: 'previous target' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run command' }));
  await screen.findByRole('heading', { name: 'Succeeded' });
  fireEvent.click(screen.getByRole('link', { name: 'Execution History' }));
  await waitFor(() => expect(document.querySelector('.run-history-entry')).not.toBeNull());
  fireEvent.click(document.querySelector<HTMLButtonElement>('.run-history-entry')!);
  fireEvent.click(await screen.findByRole('button', { name: 'Configure this task' }));
  expect(await screen.findByRole('textbox', { name: 'Query' })).toHaveValue('');
  expect(window.location.pathname).toBe('/tasks');
  expect(backend.calls('POST /api/v1/runs')).toHaveLength(1);
  expect(backend.calls('POST /api/v1/runs/preview')).toHaveLength(0);
});
