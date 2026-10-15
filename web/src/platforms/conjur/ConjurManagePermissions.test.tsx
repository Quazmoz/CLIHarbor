import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConjurManagePermissions, parseVariableAccess } from './ConjurManagePermissions';
import { createRun, previewRun } from '../../api/runs';
import type { RunSnapshot } from '../../api/runs';
import type { Task } from '../../api/tasks';

vi.mock('../../api/runs', async (importOriginal) => ({
  decodeRunOutput: (await importOriginal<typeof import('../../api/runs')>()).decodeRunOutput,
  createRun: vi.fn(), previewRun: vi.fn(), fetchRun: vi.fn(), subscribeRunEvents: vi.fn(),
}));

const PACK = 'cyberark-conjur-v9';
const task = (commandId: string, risk: Task['risk'], inputs: Array<[string, Task['inputs'][number]['type']]>): Task => ({
  packId: PACK, toolId: 'conjur', packName: 'Conjur', commandId, name: commandId, risk, requiresAuth: true,
  inputs: inputs.map(([id, type]) => ({ id, type, label: id, required: type !== 'boolean' })),
});
const permission: Array<[string, Task['inputs'][number]['type']]> = [['policy-branch', 'string'], ['variable-id', 'string'],
  ['role-kind', 'enum'], ['role-id', 'string'], ['privileges', 'enum'], ['dry-run', 'boolean']];
const tasks = [
  task('list-resources', 'read', [['kind', 'enum'], ['limit', 'enum']]),
  task('resource-show', 'read', [['resource-id', 'string']]),
  task('secret-permit', 'change', permission),
  task('secret-deny', 'change', permission),
];
const resource = {
  id: 'dev:variable:apps/db/password', owner: 'dev:policy:apps', policy: 'dev:policy:apps',
  permissions: [{ privilege: 'execute', role: 'dev:host:apps/web', policy: 'dev:policy:root' }],
  annotations: [{ name: 'never-rendered', value: 'x' }],
};
const lists: Record<string, string[]> = {
  variable: ['dev:variable:apps/db/password'], group: ['dev:group:admins'], host: ['dev:host:apps/web'], layer: [], user: [],
};
const run = (commandId: string, stdout?: unknown): RunSnapshot => ({
  packId: PACK, toolId: 'conjur', commandId, runId: commandId + '-run', status: 'exited', exitCode: 0,
  ...(stdout === undefined ? {} : { events: [{ sequence: 1, type: 'stdout.chunk', timestamp: '', dataBase64: btoa(JSON.stringify(stdout)) }] }),
});
const approval = { id: 'a'.repeat(32), mode: 'explicit' as const, expiresAt: '2099-01-01T00:00:00Z' };

beforeEach(() => {
  vi.mocked(createRun).mockImplementation(async (_, request) =>
    request.commandId === 'list-resources' ? run('list-resources', lists[request.values.kind as string])
      : request.commandId === 'resource-show' ? run('resource-show', resource) : run(request.commandId));
  vi.mocked(previewRun).mockImplementation(async (_, request) => ({
    packId: PACK, commandId: request.commandId, toolId: 'conjur', executableName: 'conjur', args: ['policy'], risk: 'change',
    impact: { targetLabel: 'Variable', target: request.values['variable-id'] as string, effect: 'Write', scope: 'single' },
    approval, stdin: '- !' + request.commandId + '\n',
    context: { fields: [{ label: 'Account', value: 'dev' }, { label: 'Endpoint', value: 'https://example.test' }] },
  }));
});
afterEach(() => { vi.resetAllMocks(); });

test('shows current grants, revokes from the granting branch and grants from dropdowns', async () => {
  render(<ConjurManagePermissions tasks={tasks} csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="k" />);
  const region = screen.getByRole('region', { name: 'Manage Conjur secret permissions' });
  fireEvent.click(within(region).getByRole('button', { name: /Manage permissions/ }));
  fireEvent.change(within(region).getByRole('combobox', { name: /Secret variable ID/ }), { target: { value: 'apps/db/password' } });
  fireEvent.click(within(region).getByRole('button', { name: 'Show current permissions' }));
  const table = await within(region).findByRole('table');
  expect(within(table).getByText('apps/web')).toBeInTheDocument();
  expect(within(region).queryByText('never-rendered')).not.toBeInTheDocument();

  fireEvent.click(within(table).getByRole('button', { name: 'Revoke execute from apps/web' }));
  await within(region).findByRole('region', { name: 'Permission change approval' });
  expect(vi.mocked(previewRun).mock.calls[0][1]).toMatchObject({ commandId: 'secret-deny', values: {
    'policy-branch': 'root', 'variable-id': '/apps/db/password', 'role-kind': 'host', 'role-id': '/apps/web', privileges: 'execute',
  } });
  fireEvent.click(within(region).getByRole('checkbox', { name: /I approve this change/ }));
  fireEvent.click(within(region).getByRole('button', { name: 'Apply permission change' }));
  await waitFor(() => expect(within(region).getByText(/applied\. Current permissions were reloaded/)).toBeInTheDocument());
  const commands = vi.mocked(createRun).mock.calls.map(([, request]) => request);
  expect(commands.find((request) => request.commandId === 'secret-deny')?.approval?.id).toBe(approval.id);
  expect(commands.filter((request) => request.commandId === 'resource-show')).toHaveLength(2);

  await within(region).findByRole('option', { name: 'admins' });
  fireEvent.change(within(region).getByRole('combobox', { name: /Grant access to/ }), { target: { value: 'group:admins' } });
  fireEvent.change(within(region).getByRole('combobox', { name: /^Privileges/ }), { target: { value: 'read' } });
  fireEvent.click(within(region).getByRole('button', { name: 'Review grant' }));
  await waitFor(() => expect(previewRun).toHaveBeenCalledTimes(2));
  expect(vi.mocked(previewRun).mock.calls[1][1]).toMatchObject({ commandId: 'secret-permit', values: {
    'policy-branch': 'apps', 'variable-id': '/apps/db/password', 'role-kind': 'group', 'role-id': '/admins', privileges: 'read',
  } });
});

test('resource descriptions with cross-account or malformed grants fail closed', () => {
  expect(parseVariableAccess(JSON.stringify(resource), 'dev').permissions).toHaveLength(1);
  for (const permissions of [[{ privilege: 'execute', role: 'other:host:x', policy: 'dev:policy:root' }],
    [{ privilege: 'exec ute', role: 'dev:host:x', policy: 'dev:policy:root' }],
    [{ privilege: 'execute', role: 'dev:host:x', policy: 'dev:group:root' }]]) {
    expect(() => parseVariableAccess(JSON.stringify({ ...resource, permissions }), 'dev')).toThrow(/unexpected/);
  }
  expect(() => parseVariableAccess('[]', 'dev')).toThrow(/unexpected/);
});
