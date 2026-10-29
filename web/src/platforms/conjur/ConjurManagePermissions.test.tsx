import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConjurManagePermissions, parseVariableAccess, policyRelativeVariableID } from './ConjurManagePermissions';
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

function chooseVariable(region: HTMLElement, value: string) {
  fireEvent.change(within(region).getByRole('combobox', { name: 'Secret variable ID' }), { target: { value: 'manual' } });
  fireEvent.change(within(region).getByRole('textbox', { name: 'Secret variable ID — enter ID' }), { target: { value } });
}

test('keeps permission work visible and disabled through mutation and refresh, without duplicate requests', async () => {
  let finishChange!: (value: RunSnapshot) => void;
  let finishRead!: (value: RunSnapshot) => void;
  let finishRefresh!: (value: RunSnapshot) => void;
  const changing = new Promise<RunSnapshot>((resolve) => { finishChange = resolve; });
  const reading = new Promise<RunSnapshot>((resolve) => { finishRead = resolve; });
  const refreshing = new Promise<RunSnapshot>((resolve) => { finishRefresh = resolve; });
  render(<ConjurManagePermissions tasks={tasks} csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="k" />);
  const region = screen.getByRole('region', { name: 'Manage Conjur secret permissions' });
  fireEvent.click(within(region).getByRole('button', { name: /Manage permissions/ }));
  await within(region).findByRole('option', { name: 'apps/db/password' });
  chooseVariable(region, 'apps/db/password');
  vi.mocked(createRun).mockImplementationOnce(() => reading);
  const form = within(region).getByRole('button', { name: 'Show current permissions' }).closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  const status = region.querySelector('.working-status')!;
  expect(status).toHaveTextContent('Reading current permissions…');
  expect(within(region).getByRole('button', { name: 'Working…' })).toHaveAttribute('aria-busy', 'true');
  expect(vi.mocked(createRun).mock.calls.filter(([, request]) => request.commandId === 'resource-show')).toHaveLength(1);
  await act(async () => finishRead(run('resource-show', resource)));
  fireEvent.click(within(region).getByRole('button', { name: 'Revoke execute from apps/web' }));
  fireEvent.click(await within(region).findByRole('checkbox', { name: /I approve this change/ }));
  vi.mocked(createRun).mockImplementationOnce(() => changing);
  fireEvent.click(within(region).getByRole('button', { name: 'Apply permission change' }));
  expect(status).toHaveTextContent('Applying the permission change…');
  expect(within(region).getByRole('button', { name: 'Working…' })).toBeDisabled();
  fireEvent.submit(form);
  expect(vi.mocked(createRun).mock.calls.filter(([, request]) => request.commandId === 'secret-deny')).toHaveLength(1);
  vi.mocked(createRun).mockImplementationOnce(() => refreshing);
  await act(async () => finishChange(run('secret-deny')));
  expect(status).toHaveTextContent('Verifying current permissions…');
  expect(within(region).getByRole('button', { name: 'Working…' })).toBeDisabled();
  await act(async () => finishRefresh(run('resource-show', resource)));
  expect(await within(region).findByText(/applied\. Current permissions were reloaded/)).toBeInTheDocument();
  expect(status).toBeEmptyDOMElement();
  expect(within(region).getByRole('button', { name: 'Show current permissions' })).toBeEnabled();
});

test('shows current grants, revokes from the granting branch and grants from dropdowns', async () => {
  render(<ConjurManagePermissions tasks={tasks} csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="k" />);
  const region = screen.getByRole('region', { name: 'Manage Conjur secret permissions' });
  fireEvent.click(within(region).getByRole('button', { name: /Manage permissions/ }));
  chooseVariable(region, 'apps/db/password');
  fireEvent.click(within(region).getByRole('button', { name: 'Show current permissions' }));
  const table = await within(region).findByRole('table');
  expect(within(table).getByText('apps/web')).toBeInTheDocument();
  expect(within(region).queryByText('never-rendered')).not.toBeInTheDocument();

  fireEvent.click(within(table).getByRole('button', { name: 'Revoke execute from apps/web' }));
  await within(region).findByRole('region', { name: 'Permission change approval' });
  expect(vi.mocked(previewRun).mock.calls[0][1]).toMatchObject({ commandId: 'secret-deny', values: {
    'policy-branch': 'root', 'variable-id': 'apps/db/password', 'role-kind': 'host', 'role-id': '/apps/web', privileges: 'execute',
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
    'policy-branch': 'apps', 'variable-id': 'db/password', 'role-kind': 'group', 'role-id': '/admins', privileges: 'read',
  } });
});

test('resource descriptions with cross-account or malformed grants fail closed', () => {
  expect(parseVariableAccess(JSON.stringify(resource), 'dev', 'apps/db/password').permissions).toHaveLength(1);
  const duplicate = '{"id":"dev:variable:other",' + JSON.stringify(resource).slice(1);
  expect(() => parseVariableAccess(duplicate, 'dev', 'apps/db/password')).toThrow(/duplicate/);
  for (const permissions of [[{ privilege: 'execute', role: 'other:host:x', policy: 'dev:policy:root' }],
    [{ privilege: 'exec ute', role: 'dev:host:x', policy: 'dev:policy:root' }],
    [{ privilege: 'execute', role: 'dev:host:x', policy: 'dev:group:root' }]]) {
    expect(() => parseVariableAccess(JSON.stringify({ ...resource, permissions }), 'dev', 'apps/db/password')).toThrow(/unexpected/);
  }
  expect(() => parseVariableAccess('[]', 'dev', 'apps/db/password')).toThrow(/unexpected/);
});

test('policy YAML uses a branch-relative resource ID, including the SaaS data branch', () => {
  const variable = 'data/vault/app/password';
  expect(policyRelativeVariableID(variable, 'data')).toBe('vault/app/password');
  expect(policyRelativeVariableID(variable, 'data/vault')).toBe('app/password');
  expect(policyRelativeVariableID(variable, 'root')).toBe(variable);
  expect(policyRelativeVariableID(variable, 'other')).toBeNull();
  expect(policyRelativeVariableID(variable, 'dat')).toBeNull();
  expect(policyRelativeVariableID('data', 'data')).toBeNull();
});

test('a data-policy grant previews the relative variable and absolute role', async () => {
  vi.mocked(createRun).mockImplementation(async (_, request) =>
    request.commandId === 'list-resources' ? run('list-resources', lists[request.values.kind as string])
      : request.commandId === 'resource-show' ? run('resource-show', {
        ...resource, id: 'dev:variable:data/vault/app/password',
        owner: 'dev:policy:data', policy: 'dev:policy:data', permissions: [],
      }) : run(request.commandId));
  render(<ConjurManagePermissions tasks={tasks} csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="k" />);
  const region = screen.getByRole('region', { name: 'Manage Conjur secret permissions' });
  fireEvent.click(within(region).getByRole('button', { name: /Manage permissions/ }));
  chooseVariable(region, 'data/vault/app/password');
  fireEvent.click(within(region).getByRole('button', { name: 'Show current permissions' }));
  await within(region).findByRole('region', { name: 'Current permissions' });
  await within(region).findByRole('option', { name: 'admins' });
  fireEvent.change(within(region).getByRole('combobox', { name: /Grant access to/ }),
    { target: { value: 'group:admins' } });
  fireEvent.click(within(region).getByRole('button', { name: 'Review grant' }));
  await waitFor(() => expect(previewRun).toHaveBeenCalledTimes(1));
  expect(vi.mocked(previewRun).mock.calls[0][1]).toMatchObject({
    commandId: 'secret-permit', values: {
      'policy-branch': 'data', 'variable-id': 'vault/app/password',
      'role-kind': 'group', 'role-id': '/admins',
    },
  });
});

test('reads IDs with spaces through an exact list search, never the CLI path that encodes spaces as +', async () => {
  const id = 'data/vault/Operating System-svc/password';
  const record = { ...resource, id: 'dev:variable:' + id, owner: 'dev:policy:data', policy: 'dev:policy:data' };
  vi.mocked(createRun).mockImplementation(async (_, request) => request.commandId !== 'list-resources' ? run(request.commandId)
    : request.values.search ? run('list-resources', [{ ...record, id: 'dev:variable:' + id + '-old' }, record])
      : run('list-resources', lists[request.values.kind as string]));
  render(<ConjurManagePermissions tasks={tasks} csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="k" />);
  const region = screen.getByRole('region', { name: 'Manage Conjur secret permissions' });
  fireEvent.click(within(region).getByRole('button', { name: /Manage permissions/ }));
  chooseVariable(region, id);
  fireEvent.click(within(region).getByRole('button', { name: 'Show current permissions' }));
  expect(await within(region).findByRole('table')).toHaveTextContent('apps/web');
  const requests = vi.mocked(createRun).mock.calls.map(([, request]) => request);
  expect(requests.some((request) => request.commandId === 'resource-show')).toBe(false);
  expect(requests).toContainEqual(expect.objectContaining({ commandId: 'list-resources',
    values: { kind: 'variable', search: id, limit: '100', inspect: true } }));
});

test('does not offer an unsafe revoke when the granting policy is unrelated', async () => {
  vi.mocked(createRun).mockImplementation(async (_, request) =>
    request.commandId === 'list-resources' ? run('list-resources', lists[request.values.kind as string])
      : request.commandId === 'resource-show' ? run('resource-show', {
        ...resource, permissions: [{ ...resource.permissions[0], policy: 'dev:policy:other' }],
      }) : run(request.commandId));
  render(<ConjurManagePermissions tasks={tasks} csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="k" />);
  const region = screen.getByRole('region', { name: 'Manage Conjur secret permissions' });
  fireEvent.click(within(region).getByRole('button', { name: /Manage permissions/ }));
  chooseVariable(region, 'apps/db/password');
  fireEvent.click(within(region).getByRole('button', { name: 'Show current permissions' }));
  const table = await within(region).findByRole('table');
  expect(within(table).queryByRole('button', { name: /Revoke execute/ })).not.toBeInTheDocument();
  expect(within(table).getByText('Other policy branch')).toBeInTheDocument();
  expect(previewRun).not.toHaveBeenCalled();
});

test('permission dropdown indicates an active CLI read and clears loading on success', async () => {
  let resolveVariables!: (run: RunSnapshot) => void;
  const pending = new Promise<RunSnapshot>((resolve) => { resolveVariables = resolve; });
  vi.mocked(createRun).mockImplementation(async (_, request) =>
    request.commandId === 'list-resources'
      ? (request.values.kind === 'variable' ? pending : run('list-resources', lists[request.values.kind as string]))
      : request.commandId === 'resource-show' ? run('resource-show', resource) : run(request.commandId));
  render(<ConjurManagePermissions tasks={tasks} csrfToken="csrf" account="dev"
    endpoint="https://example.test" contextKey="k" />);
  const region = screen.getByRole('region', { name: 'Manage Conjur secret permissions' });
  fireEvent.click(within(region).getByRole('button', { name: /Manage permissions/ }));
  const status = within(region).getByText('Loading dropdown options from Conjur…');
  expect(status.querySelector('.conjur-inventory-spinner')).toBeInTheDocument();
  expect(within(region).getByRole('combobox', { name: /Secret variable ID/ })).toHaveAttribute('aria-busy', 'true');
  chooseVariable(region, 'apps/db/password');
  fireEvent.click(within(region).getByRole('button', { name: 'Show current permissions' }));
  const grantee = await within(region).findByRole('combobox', { name: /Grant access to/ });
  expect(grantee).toBeDisabled();
  expect(grantee).toHaveAttribute('aria-busy', 'true');
  expect(within(grantee).getByRole('option', { name: 'Loading roles…' })).toBeInTheDocument();
  await act(async () => { resolveVariables(run('list-resources', lists.variable)); });
  await within(grantee).findByRole('option', { name: 'admins' });
  expect(grantee).toBeEnabled();
  expect(within(region).queryByText('Loading dropdown options from Conjur…')).not.toBeInTheDocument();
});

test('a change whose reload fails does not claim the table is current', async () => {
  let shows = 0;
  vi.mocked(createRun).mockImplementation(async (_, request) => {
    if (request.commandId === 'list-resources') return run('list-resources', lists[request.values.kind as string]);
    if (request.commandId !== 'resource-show') return run(request.commandId);
    shows += 1;
    return shows === 1 ? run('resource-show', resource) : { ...run('resource-show'), exitCode: 1 };
  });
  render(<ConjurManagePermissions tasks={tasks} csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="k" />);
  const region = screen.getByRole('region', { name: 'Manage Conjur secret permissions' });
  fireEvent.click(within(region).getByRole('button', { name: /Manage permissions/ }));
  chooseVariable(region, 'apps/db/password');
  fireEvent.click(within(region).getByRole('button', { name: 'Show current permissions' }));
  const table = await within(region).findByRole('table');
  fireEvent.click(within(table).getByRole('button', { name: 'Revoke execute from apps/web' }));
  await within(region).findByRole('region', { name: 'Permission change approval' });
  fireEvent.click(within(region).getByRole('checkbox', { name: /I approve this change/ }));
  fireEvent.click(within(region).getByRole('button', { name: 'Apply permission change' }));
  expect(await within(region).findByText(/applied, but current permissions could not be reloaded/)).toBeInTheDocument();
  expect(within(region).queryByText(/Current permissions were reloaded/)).not.toBeInTheDocument();
  expect(within(region).queryByRole('table')).not.toBeInTheDocument();
});

test.each(['other/secret', undefined])('refuses ownership and grants without the exact requested variable ID (%s)', async (id) => {
  vi.mocked(createRun).mockImplementation(async (_, request) => request.commandId === 'resource-show'
    ? run('resource-show', { ...resource, id: id === undefined ? undefined : 'dev:variable:' + id })
    : run('list-resources', lists[request.values.kind as string]));
  render(<ConjurManagePermissions tasks={tasks} csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="k" />);
  fireEvent.click(screen.getByRole('button', { name: /Manage permissions/ }));
  chooseVariable(screen.getByRole('region', { name: 'Manage Conjur secret permissions' }), 'apps/db/password');
  fireEvent.click(screen.getByRole('button', { name: 'Show current permissions' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('unexpected resource description');
  expect(screen.queryByRole('region', { name: 'Current permissions' })).not.toBeInTheDocument();
  expect(vi.mocked(previewRun)).not.toHaveBeenCalled();
});

test('does not derive permission actions from raw output rejected by the pack parser', async () => {
  vi.mocked(createRun).mockImplementation(async (_, request) => request.commandId === 'resource-show'
    ? { ...run('resource-show', resource), structured: { status: 'invalid', renderer: 'cards', error: 'duplicate_key' } }
    : run('list-resources', lists[request.values.kind as string]));
  render(<ConjurManagePermissions tasks={tasks} csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="k" />);
  fireEvent.click(screen.getByRole('button', { name: /Manage permissions/ }));
  chooseVariable(screen.getByRole('region', { name: 'Manage Conjur secret permissions' }), 'apps/db/password');
  fireEvent.click(screen.getByRole('button', { name: 'Show current permissions' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('reviewed output schema');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(vi.mocked(previewRun)).not.toHaveBeenCalled();
});

test('changing variables clears the prior grantee before another grant can be reviewed', async () => {
  render(<ConjurManagePermissions tasks={tasks} csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="k" />);
  fireEvent.click(screen.getByRole('button', { name: /Manage permissions/ }));
  const region = screen.getByRole('region', { name: 'Manage Conjur secret permissions' });
  await screen.findByRole('option', { name: 'apps/db/password' });
  chooseVariable(region, 'apps/db/password');
  fireEvent.click(screen.getByRole('button', { name: 'Show current permissions' }));
  const grantee = await screen.findByRole('combobox', { name: 'Grant access to' });
  await within(grantee).findByRole('option', { name: 'admins' });
  fireEvent.change(grantee, { target: { value: 'group:admins' } });
  chooseVariable(region, 'apps/other');
  vi.mocked(createRun).mockResolvedValueOnce(run('resource-show', { ...resource, id: 'dev:variable:apps/other' }));
  fireEvent.click(screen.getByRole('button', { name: 'Show current permissions' }));
  expect(await screen.findByRole('combobox', { name: 'Grant access to' })).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Review grant' })).toBeDisabled();
});
