import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import { bootRoutes, installFakeBackend } from './test/fakeBackend';
import type { Task, TaskInput } from './api/tasks';

const PACK = 'cyberark-conjur-v9';
const field = (id: string, type: TaskInput['type'] = 'string'): TaskInput => ({ id, type, label: id, required: type !== 'boolean',
  validation: type === 'enum' ? { enum: id === 'role-kind' ? ['group', 'host', 'layer', 'user'] : ['read, execute', 'read', 'execute', 'update'] } : { maxLength: 2048 } });
const task = (commandId: string, risk: Task['risk'], inputs: TaskInput[]): Task => ({
  packId: PACK, packName: 'Conjur', toolId: 'conjur', commandId, name: commandId, risk, inputs, requiresAuth: true,
  ...(risk === 'read' ? {} : { impact: { targetInput: 'variable-id', targetLabel: 'Variable', effect: 'Change the selected variable', scope: 'single' } }),
});
const permissions = ['secret-permit', 'secret-deny'].map((id) => task(id, 'change', [field('policy-branch'), field('variable-id'), field('role-kind', 'enum'), field('role-id'), field('privileges', 'enum'), field('dry-run', 'boolean')]));
const tasks = [...permissions, task('list-resources', 'read', []), task('resource-show', 'read', [field('resource-id')]),
  task('secret-set-value', 'change', [field('variable-id'), field('value', 'secret')])];
const tool = { packId: PACK, toolId: 'conjur', packName: 'Conjur', packVersion: '0.8.0', status: 'ready', version: '9.3.1' };
const platform = { id: 'conjur', packId: PACK, toolId: 'conjur', name: 'CyberArk Conjur', summary: 'Conjur workspace', ready: true,
  features: [{ id: 'tasks', name: 'Tasks' }, { id: 'access-explorer', name: 'Access explorer' }] };
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); });

test('Access Explorer permission shortcuts stay dedicated and complete a selected-secret grant', async () => {
  window.history.replaceState({}, '', '/dedicated/conjur/access-explorer');
  let sequence = 0;
  let granted = false;
  const backend = installFakeBackend({
    ...bootRoutes({ tasks, tools: [tool] }),
    '/api/v1/platforms': { body: { platforms: [platform] } },
    '/api/v1/conjur/secret-audit': { body: { available: true, packId: PACK, toolId: 'conjur', state: 'idle',
      total: 0, processed: 0, inspected: 0, findings: [], failures: [], target: { account: 'dev', applianceUrl: 'https://example.test' } } },
    'POST /api/v1/runs': ({ body }) => {
      const request = body as { commandId: string; values: Record<string, string> };
      let output: unknown = '';
      if (request.commandId === 'list-resources') output = request.values.kind === 'variable' ? ['dev:variable:apps/db/password'] : request.values.kind === 'group' ? ['dev:group:admins'] : [];
      if (request.commandId === 'resource-show') output = { id: request.values['resource-id'], owner: 'dev:policy:apps', policy: 'dev:policy:apps', permissions: granted ? [{ role: 'dev:group:admins', privilege: 'execute', policy: 'dev:policy:apps' }] : [] };
      if (request.commandId === 'secret-permit') granted = true;
      return { body: { packId: PACK, toolId: 'conjur', commandId: request.commandId, runId: (++sequence).toString(16).padStart(32, '0'), status: 'exited', exitCode: 0,
        events: [{ sequence: 1, type: 'stdout.chunk', timestamp: '2026-10-28T10:00:00Z', dataBase64: btoa(JSON.stringify(output)) }] } };
    },
    'POST /api/v1/runs/preview': ({ body }) => {
      const request = body as { commandId: string; values: Record<string, string> };
      return { body: { packId: PACK, toolId: 'conjur', commandId: request.commandId, executableName: 'conjur', args: ['policy', 'update'], risk: 'change',
        impact: { target: request.values['variable-id'], targetLabel: 'Variable', effect: 'Grant selected privileges', scope: 'single' }, stdin: '- !permit\n',
        context: { fields: [{ label: 'Account', value: 'dev' }, { label: 'Endpoint', value: 'https://example.test' }] },
        approval: { id: 'b'.repeat(32), mode: 'explicit', expiresAt: '2099-01-01T00:00:00Z' } } };
    },
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Grant secret permission · Approval required' }));
  await screen.findByRole('option', { name: 'apps/db/password' });
  const variable = screen.getByRole('combobox', { name: 'Secret variable ID' });
  expect(window.location.pathname).toBe('/dedicated/conjur');
  expect(screen.getByRole('tab', { name: 'Access' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('heading', { name: 'Command Builder' })).not.toBeInTheDocument();
  fireEvent.change(variable, { target: { value: 'value:apps/db/password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Show current permissions' }));
  const grantee = await screen.findByRole('combobox', { name: 'Grant access to' });
  await within(grantee).findByRole('option', { name: 'admins' });
  fireEvent.change(grantee, { target: { value: 'group:admins' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review grant' }));
  await screen.findByRole('region', { name: 'Permission change approval' });
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve this change/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply permission change' }));
  await screen.findByRole('heading', { name: /Permissions updated/ });
  expect(window.location.pathname).toBe('/dedicated/conjur');
  const writes = backend.bodies('POST /api/v1/runs').filter((body) => (body as { commandId: string }).commandId === 'secret-permit');
  expect(writes).toEqual([{ packId: PACK, commandId: 'secret-permit', values: { 'policy-branch': 'apps', 'variable-id': 'db/password', 'role-kind': 'group', 'role-id': '/admins', privileges: 'read, execute', 'dry-run': false }, approval: { id: 'b'.repeat(32) } }]);
  fireEvent.click(screen.getByRole('tab', { name: 'Secrets' }));
  fireEvent.click(screen.getByRole('button', { name: 'Update value' }));
  expect(await screen.findByRole('region', { name: 'Dedicated Conjur action' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'variable-id' })).toBeEnabled());
  expect(window.location.pathname).toBe('/dedicated/conjur');
});
