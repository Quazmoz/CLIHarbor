import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { AuthenticationPage } from './AuthenticationPage';
import { CliSessionStatus } from './CliSessionStatus';
import { OperationActivityProvider } from './OperationActivity';
import { conjurSignIn } from './platforms/conjur/ConjurSignIn';
import { defaultStatus, FakeEventSource, installFakeBackend } from './test/fakeBackend';
import type { ToolDiagnostic } from './api/tools';
import type { Task } from './api/tasks';

const tool: ToolDiagnostic = {
  packId: 'cyberark-conjur-v9', toolId: 'conjur', packName: 'Conjur', packVersion: '1.0.0',
  status: 'ready', requiresVendorSession: true, credentialLogin: { method: 'conjur-password' },
  sessionCheck: { commandId: 'whoami' },
};
const task: Task = {
  packId: tool.packId, packName: 'Conjur', commandId: 'whoami', toolId: 'conjur',
  name: 'Who am I', risk: 'read', requiresAuth: true, inputs: [],
};
const run = {
  runId: 'a'.repeat(32), packId: tool.packId, toolId: tool.toolId, commandId: 'whoami',
  status: 'exited', exitCode: 0, events: [],
};
const connection = {
  environment: 'saas', applianceUrl: 'https://old.secretsmgr.cyberark.cloud/api', account: 'conjur', configurable: true,
};
const changed = vi.fn();
function page(show = true) {
  return <OperationActivityProvider>
    <CliSessionStatus tools={[tool]} tasks={[task]} checks={{}} onOpenSignIn={vi.fn()} onCheckSession={vi.fn()} />
    {show && <AuthenticationPage status={defaultStatus} tools={[tool]} tasks={[task]}
      onOpenTasks={vi.fn()} onOpenDiagnostics={vi.fn()} onCheckChange={changed} signInFor={() => conjurSignIn} />}
  </OperationActivityProvider>;
}

test('abandoned password login stays locked across navigation and cannot start a late session check', async () => {
  let finish!: (response: Response) => void;
  const backend = installFakeBackend({
    'POST /api/v1/auth/login': () => new Promise((resolve) => { finish = resolve; }),
    'POST /api/v1/runs': { status: 202, body: run },
  });
  const view = render(page());
  fireEvent.change(screen.getByRole('textbox', { name: 'Identity' }), { target: { value: 'fixture-user' } });
  fireEvent.change(document.querySelector('input[type=password]')!, { target: { value: 'fixture-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in and verify' }));
  expect(screen.getByRole('button', { name: 'Check session' })).toBeDisabled();
  expect(screen.getByLabelText('Conjur settings')).toBeDisabled();
  expect(screen.getByLabelText('Check session for Conjur / conjur')).toBeDisabled();
  view.rerender(page(false));
  view.rerender(page());
  expect(screen.getByRole('textbox', { name: 'Identity' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Check session' })).toBeDisabled();
  await act(async () => finish(new Response(null, { status: 204 })));
  expect(screen.getByRole('button', { name: 'Check session' })).toBeEnabled();
  expect(screen.getByRole('heading', { name: 'Authentication not verified' })).toBeVisible();
  expect(backend.calls('POST /api/v1/auth/login')).toHaveLength(1);
  expect(backend.calls('POST /api/v1/runs')).toHaveLength(0);
});

test('a connection change invalidates session evidence and locks sibling actions until readback', async () => {
  let finish!: (response: Response) => void;
  const backend = installFakeBackend({
    '/api/v1/auth/configure': { body: connection },
    'POST /api/v1/auth/configure': () => new Promise((resolve) => { finish = resolve; }),
    'POST /api/v1/runs': { status: 202, body: run },
  });
  render(page());
  fireEvent.click(screen.getByRole('button', { name: 'Check session' }));
  await screen.findByRole('heading', { name: 'Authenticated' });
  fireEvent.click(screen.getByLabelText('Conjur settings'));
  fireEvent.click(await screen.findByRole('button', { name: 'Change API endpoint' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Secrets Manager API URL' }), {
    target: { value: 'https://new.secretsmgr.cyberark.cloud/api' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /replace the existing/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Replace CLI API endpoint' }));
  expect(screen.getByRole('heading', { name: 'Authentication not verified' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Check session' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Identity' })).toBeDisabled();
  expect(screen.getByLabelText('Check session for Conjur / conjur')).toBeDisabled();
  expect(screen.getByText('Updating CLI sign-in or connection…')).toBeVisible();
  backend.on({ '/api/v1/auth/configure': { body: { ...connection, applianceUrl: 'https://new.secretsmgr.cyberark.cloud/api' } } });
  await act(async () => finish(new Response(null, { status: 204 })));
  expect(screen.getByRole('button', { name: 'Check session' })).toBeEnabled();
  expect(screen.getByRole('heading', { name: 'Authentication not verified' })).toBeVisible();
  expect(backend.calls('POST /api/v1/runs')).toHaveLength(1);
  expect(backend.calls('POST /api/v1/auth/configure')).toHaveLength(1);
});

test('connection controls remain disabled while an explicit session check owns the card', async () => {
  installFakeBackend({
    '/api/v1/auth/configure': { body: connection },
    'POST /api/v1/runs': { status: 202, body: { ...run, status: 'running', exitCode: undefined } },
  });
  render(page());
  fireEvent.click(screen.getByLabelText('Conjur settings'));
  await screen.findByRole('button', { name: 'Change API endpoint' });
  fireEvent.click(screen.getByRole('button', { name: 'Check session' }));
  await screen.findByRole('button', { name: 'Cancel check' });
  const settings = within(screen.getByRole('region', { name: 'Conjur API backend configuration' }));
  expect(settings.getByRole('button', { name: 'Change API endpoint' })).toBeDisabled();
  await act(async () => FakeEventSource.latest!.emit('run-complete', {
    runId: run.runId, sequence: 0, status: 'exited', exitCode: 0,
  }));
  expect(settings.getByRole('button', { name: 'Change API endpoint' })).toBeEnabled();
});
