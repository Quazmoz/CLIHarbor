import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import { CliSessionStatus } from './CliSessionStatus';
import { AuthenticationPage, authenticationContextKey, type AuthenticationCheck } from './AuthenticationPage';
import type { ToolDiagnostic } from './api/tools';
import { bootRoutes, defaultStatus, FakeEventSource, installFakeBackend } from './test/fakeBackend';
import type { Task } from './api/tasks';

const tool: ToolDiagnostic = {
  packId: 'example', packName: 'Example CLI', packVersion: '1.0.0', toolId: 'example',
  status: 'ready', version: '1.0.0', requiresVendorSession: true,
  sessionCheck: { commandId: 'whoami', unauthenticatedStderrContains: 'please sign in' },
};
const task: Task = {
  packId: tool.packId, packName: tool.packName, commandId: 'whoami', name: 'Check example session',
  toolId: tool.toolId, risk: 'read', requiresAuth: true, inputs: [],
};
const run = {
  runId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', packId: tool.packId, commandId: 'whoami',
  toolId: tool.toolId, status: 'exited', exitCode: 0, events: [],
};

function boot() {
  window.history.replaceState({}, '', '/authentication');
  return installFakeBackend({
    ...bootRoutes({ tools: [tool], tasks: [task] }),
    '/api/v1/platforms': { body: { platforms: [] } },
    'POST /api/v1/runs': { status: 202, body: run },
  });
}

function sessions() {
  const summary = screen.getByLabelText(/CLI sign-in status, /);
  fireEvent.click(summary);
  return within(summary.closest('details')!);
}

afterEach(() => window.history.replaceState({}, '', '/'));

test('shows only verified sessions, preserves results across navigation, and re-checks signed-out evidence', async () => {
  const backend = boot();
  render(<App />);
  await screen.findByRole('heading', { name: 'Sign in' });
  expect(sessions().getByText('Not checked')).toBeVisible();
  expect(backend.calls('POST /api/v1/runs')).toHaveLength(0);
  fireEvent.keyDown(screen.getByLabelText(/CLI sign-in status, /), { key: 'Escape' });

  fireEvent.click(screen.getByRole('button', { name: 'Check session' }));
  expect(await screen.findByText('1 signed in')).toBeVisible();
  expect(backend.bodies('POST /api/v1/runs')).toEqual([{ packId: 'example', commandId: 'whoami', values: {} }]);
  fireEvent.click(screen.getByRole('button', { name: 'Continue to tasks' }));
  expect(window.location.pathname).toBe('/tasks');
  const menu = sessions();
  expect(menu.getByText('Signed in')).toBeVisible();
  expect(menu.getByText('example')).toBeVisible();
  expect(menu.getByText('Checked', { exact: false })).toBeVisible();
  fireEvent.click(menu.getByRole('link', { name: /Manage sign-ins/ }));
  expect(window.location.pathname).toBe('/authentication');
  expect(screen.getByRole('heading', { name: 'Authenticated' })).toBeVisible();
  expect(screen.getByRole('main')).toHaveFocus();
  expect(backend.calls('POST /api/v1/runs')).toHaveLength(1);

  backend.on({ 'POST /api/v1/runs': { status: 202, body: {
    ...run, exitCode: 1, events: [{ sequence: 1, type: 'stderr.chunk', timestamp: '2026-10-26T10:00:00Z', dataBase64: btoa('please sign in') }],
  } } });
  fireEvent.click(screen.getByRole('button', { name: 'Re-check session' }));
  await screen.findByRole('heading', { name: 'Authentication required' });
  expect(screen.queryByText('1 signed in')).not.toBeInTheDocument();
  expect(sessions().getByText('Sign-in required')).toBeVisible();
});

test('abandoning a pending check clears Checking and ignores its late completion', async () => {
  const backend = boot();
  let finish!: (value: { status: number; body: typeof run }) => void;
  backend.on({ 'POST /api/v1/runs': () => new Promise((resolve) => { finish = resolve; }) });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check session' }));
  expect(sessions().getByText('Checking…')).toBeVisible();
  fireEvent.click(screen.getByRole('link', { name: 'Diagnostics' }));
  await act(async () => finish({ status: 202, body: run }));
  expect(screen.queryByText('1 signed in')).not.toBeInTheDocument();
  const details = screen.getByLabelText(/CLI sign-in status, /).closest('details')!;
  if (!details.open) fireEvent.click(details.querySelector('summary')!);
  expect(within(details).getByText('Not checked')).toBeVisible();
  expect(within(details).queryByText('Checking…')).not.toBeInTheDocument();
});

test('updates the header from streamed check completion and keeps other tools unknown', async () => {
  const backend = boot();
  backend.on({
    '/api/v1/tools': { body: { tools: [tool, { ...tool, packId: 'another', packName: 'Another pack', sessionCheck: undefined }] } },
    'POST /api/v1/runs': { status: 202, body: { ...run, status: 'running', exitCode: undefined } },
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check session' }));
  await screen.findByRole('button', { name: 'Cancel check' });
  await act(async () => FakeEventSource.latest!.emit('run-complete', {
    runId: run.runId, sequence: 0, status: 'exited', exitCode: 0,
  }));
  expect(await screen.findByText('1 signed in')).toBeVisible();
  const menu = sessions();
  expect(menu.getAllByText('example')).toHaveLength(2);
  expect(menu.getByText('Signed in')).toBeVisible();
  expect(menu.getByText('Check unavailable')).toBeVisible();
});

test('an unchanged tool refresh preserves a pending check and connection edits clear its evidence', async () => {
  installFakeBackend({ 'POST /api/v1/runs': { status: 202, body: { ...run, status: 'running', exitCode: undefined } } });
  const onCheckChange = vi.fn();
  const props = {
    status: defaultStatus, tasks: [task], onOpenTasks: vi.fn(), onOpenDiagnostics: vi.fn(), onCheckChange,
    signInFor: () => ({ render: ({ invalidateSession }: { invalidateSession?: () => void }) => (
      <button onClick={invalidateSession}>Change connection</button>
    ) }),
  };
  const view = render(<AuthenticationPage {...props} tools={[tool]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check session' }));
  await screen.findByRole('button', { name: 'Cancel check' });
  view.rerender(<AuthenticationPage {...props} tools={[{ ...tool }]} />);
  expect(FakeEventSource.latest!.closed).toBe(false);
  expect(onCheckChange).toHaveBeenLastCalledWith(tool, expect.objectContaining({ kind: 'checking' }));
  await act(async () => FakeEventSource.latest!.emit('run-complete', {
    runId: run.runId, sequence: 0, status: 'exited', exitCode: 0,
  }));
  expect(screen.getByRole('heading', { name: 'Authenticated' })).toBeVisible();
  expect(onCheckChange).toHaveBeenLastCalledWith(tool, expect.objectContaining({ kind: 'authenticated' }));
  fireEvent.click(screen.getByRole('button', { name: 'Change connection' }));
  expect(onCheckChange).toHaveBeenLastCalledWith(tool, { kind: 'unchecked' });
  expect(screen.getByRole('heading', { name: 'Authentication not verified' })).toBeVisible();
});

test.each([
  { kind: 'required', checkedAt: '2026-10-26T10:00:00Z' },
  { kind: 'cancelled', checkedAt: '2026-10-26T10:00:00Z' },
  { kind: 'failed', checkedAt: '2026-10-26T10:00:00Z', failure: { message: 'Failed', remediation: 'Retry' } },
] satisfies AuthenticationCheck[])('never promotes a $kind check to signed in', (check) => {
  render(<CliSessionStatus tools={[tool]} checks={{
    'example/example': { context: authenticationContextKey(tool), check },
  }} onOpenSignIn={vi.fn()} />);
  expect(screen.queryByText('1 signed in')).not.toBeInTheDocument();
  expect(sessions().queryByText('Signed in')).not.toBeInTheDocument();
});

test.each([
  { ...tool, version: '1.0.1' },
  { ...tool, packVersion: '2.0.0' },
  { ...tool, status: 'missing' as const },
  { ...tool, sessionCheck: undefined },
  { ...tool, sessionCheck: { commandId: 'different-check' } },
])('discards evidence after tool or check context changes: %j', (changedTool) => {
  render(<CliSessionStatus tools={[changedTool]} checks={{
    'example/example': { context: authenticationContextKey(tool), check: {
      kind: 'authenticated', checkedAt: '2026-10-26T10:00:00Z', identity: {},
    } },
  }} onOpenSignIn={vi.fn()} />);
  expect(screen.queryByText('1 signed in')).not.toBeInTheDocument();
  expect(sessions().queryByText('Signed in')).not.toBeInTheDocument();
});

test('escapes CLI metadata and closes the disclosure with Escape while restoring focus', () => {
  const { container } = render(<CliSessionStatus tools={[{ ...tool, packName: '<img src=x onerror=alert(1)>' }]}
    checks={{}} onOpenSignIn={vi.fn()} />);
  expect(sessions().getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  expect(container.querySelector('img')).toBeNull();
  const summary = screen.getByLabelText(/CLI sign-in status, /);
  fireEvent.keyDown(summary, { key: 'Escape' });
  expect(summary.closest('details')).not.toHaveAttribute('open');
  expect(summary).toHaveFocus();
});
