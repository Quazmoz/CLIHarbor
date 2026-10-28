import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConjurTaskPanel } from './ConjurTaskPanel';
import { createRun, previewRun, type RunSnapshot } from '../../api/runs';
import type { Task, TaskInput } from '../../api/tasks';
import { clientError } from '../../api/errors';

vi.mock('../../api/runs', async (original) => ({ ...(await original<typeof import('../../api/runs')>()), createRun: vi.fn(), previewRun: vi.fn() }));
const PACK = 'cyberark-conjur-v9';
const input = (id: string, type: TaskInput['type'] = 'string'): TaskInput => ({ id, type, label: id, required: type !== 'boolean', validation: { maxLength: 2048 } });
const task = (commandId: string, risk: Task['risk'], inputs: TaskInput[]): Task => ({ packId: PACK, packName: 'Conjur', toolId: 'conjur', commandId, risk, name: commandId, requiresAuth: true, inputs });
const set = task('secret-set-value', 'change', [input('variable-id'), input('value', 'secret')]);
const remove = task('secret-delete', 'destructive', [input('policy-branch'), input('variable-id'), input('dry-run', 'boolean')]);
const inventory = task('list-resources', 'read', []);
const exists = task('resource-exists', 'read', [input('resource-id')]);
const tasks = [set, remove, inventory, exists];
const run = (commandId: string, value: unknown = 'Value added'): RunSnapshot => ({
  packId: PACK, toolId: 'conjur', commandId, runId: 'a'.repeat(32), status: 'exited', exitCode: 0,
  events: [{ sequence: 1, type: 'stdout.chunk', timestamp: '', dataBase64: btoa(typeof value === 'string' ? value : JSON.stringify(value)) }],
});
const props = { tasks, csrfToken: 'csrf', account: 'dev', endpoint: 'https://example.test' };

beforeEach(() => {
  vi.mocked(createRun).mockImplementation(async (_, request) => request.commandId === 'list-resources'
    ? run(request.commandId, request.values.kind === 'variable' ? ['dev:variable:apps/db/password'] : request.values.kind === 'policy' ? ['dev:policy:apps'] : request.values.kind === 'group' ? ['dev:group:operators'] : [])
    : run(request.commandId, request.commandId === 'resource-exists' ? { exists: true } : 'Value added'));
  vi.mocked(previewRun).mockImplementation(async (_, request) => ({
    packId: PACK, toolId: 'conjur', commandId: request.commandId, executableName: 'conjur', args: ['policy', 'update'],
    risk: request.commandId === 'secret-delete' ? 'destructive' : 'change',
    impact: { target: String(request.values['variable-id'] ?? request.values['group-name']), targetLabel: 'Variable', effect: 'Change selected target', scope: 'single' },
    context: { fields: [{ label: 'Account', value: 'dev' }, { label: 'Endpoint', value: 'https://example.test' }] },
    approval: { id: 'b'.repeat(32), expiresAt: '2099-01-01T00:00:00Z', mode: request.commandId === 'secret-delete' ? 'typed' : 'explicit',
      ...(request.commandId === 'secret-delete' ? { requiredText: 'DELETE apps/db/password' } : {}) },
  }));
});
afterEach(() => vi.resetAllMocks());

async function selectVariable() {
  const select = screen.getByRole('combobox', { name: 'variable-id' });
  await within(select).findByRole('option', { name: 'apps/db/password' });
  fireEvent.change(select, { target: { value: 'value:apps/db/password' } });
}

test('updates a selected secret with bound approval, clears its value during the request, and guards duplicate submits', async () => {
  render(<ConjurTaskPanel {...props} task={set} />);
  await selectVariable();
  const secret = screen.getByLabelText(/^value/);
  fireEvent.change(secret, { target: { value: 'write-only-fixture-sentinel' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review action' }));
  await screen.findByRole('region', { name: 'Conjur action approval' });
  expect(screen.queryByText('write-only-fixture-sentinel')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve this exact action/ }));
  let finish!: (value: RunSnapshot) => void;
  vi.mocked(createRun).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const apply = screen.getByRole('button', { name: 'Approve and run' });
  fireEvent.click(apply); fireEvent.click(apply);
  expect(secret).toHaveValue('');
  expect(vi.mocked(createRun).mock.calls.filter(([, request]) => request.commandId === 'secret-set-value')).toHaveLength(1);
  expect(vi.mocked(createRun).mock.calls.at(-1)?.[1]).toMatchObject({ values: { 'variable-id': 'apps/db/password', value: 'write-only-fixture-sentinel' }, approval: { id: 'b'.repeat(32) } });
  await act(async () => finish(run('secret-set-value')));
  expect(await screen.findByText(/secret-set-value completed/)).toBeInTheDocument();
  expect(screen.queryByText('write-only-fixture-sentinel')).not.toBeInTheDocument();
});

test('requires exact typed confirmation for deletion and consumes approval before execution', async () => {
  render(<ConjurTaskPanel {...props} task={remove} />);
  await selectVariable();
  fireEvent.click(screen.getByRole('button', { name: 'Review action' }));
  const typed = await screen.findByRole('textbox', { name: 'Typed confirmation' });
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve this exact action/ }));
  fireEvent.change(typed, { target: { value: 'wrong target' } });
  expect(screen.getByRole('button', { name: 'Approve and run' })).toBeDisabled();
  fireEvent.change(typed, { target: { value: 'DELETE apps/db/password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve and run' }));
  await screen.findByText(/secret-delete completed/);
  expect(vi.mocked(createRun).mock.calls.at(-1)?.[1]).toMatchObject({ commandId: 'secret-delete', approval: { confirmation: 'DELETE apps/db/password' } });
  expect(screen.queryByRole('button', { name: 'Approve and run' })).not.toBeInTheDocument();
});

test('invalidates approval after edits and refuses a mismatched backend context', async () => {
  render(<ConjurTaskPanel {...props} task={set} />);
  await selectVariable();
  fireEvent.change(screen.getByLabelText(/^value/), { target: { value: 'test-value' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review action' }));
  await screen.findByRole('region', { name: 'Conjur action approval' });
  fireEvent.change(screen.getByLabelText(/^value/), { target: { value: 'changed-value' } });
  expect(screen.queryByRole('region', { name: 'Conjur action approval' })).not.toBeInTheDocument();
  vi.mocked(previewRun).mockResolvedValueOnce({ packId: PACK, toolId: 'conjur', commandId: set.commandId, executableName: 'conjur', args: [], risk: 'change', context: { fields: [{ label: 'Account', value: 'other' }] } });
  fireEvent.click(screen.getByRole('button', { name: 'Review action' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('matching approved plan');
  expect(vi.mocked(createRun).mock.calls.some(([, request]) => request.commandId === set.commandId)).toBe(false);
});

test('provides role multi-selection for LDAP mapping and keeps its exact selected roles in review', async () => {
  const ldap = task('ldap-group-create', 'change', [input('group-name'), input('roles'), input('service-id')]);
  render(<ConjurTaskPanel {...props} task={ldap} />);
  const roles = screen.getByRole('listbox', { name: /Conjur roles — select one or more/ });
  const option = await within(roles).findByRole('option', { name: 'dev:group:operators' }) as HTMLOptionElement;
  option.selected = true; fireEvent.change(roles);
  fireEvent.change(screen.getByRole('textbox', { name: 'group-name' }), { target: { value: 'LDAP operators' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'service-id' }), { target: { value: 'directory' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review action' }));
  await screen.findByRole('region', { name: 'Conjur action approval' });
  expect(vi.mocked(previewRun).mock.calls.at(-1)?.[1].values).toMatchObject({ roles: 'dev:group:operators', 'service-id': 'directory' });
});

test('an unconfirmed start consumes the UI approval and never automatically resubmits a secret value', async () => {
  render(<ConjurTaskPanel {...props} task={set} />);
  await selectVariable();
  fireEvent.change(screen.getByLabelText(/^value/), { target: { value: 'unconfirmed-fixture-value' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review action' }));
  await screen.findByRole('region', { name: 'Conjur action approval' });
  vi.mocked(createRun).mockRejectedValueOnce(clientError('run_start_unknown'));
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve this exact action/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Approve and run' }));
  await screen.findByRole('heading', { name: /Conjur action is unconfirmed/ });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review action' })).toBeEnabled());
  expect(screen.getByLabelText(/^value/)).toHaveValue('');
  expect(screen.queryByRole('button', { name: 'Approve and run' })).not.toBeInTheDocument();
  expect(vi.mocked(createRun).mock.calls.filter(([, request]) => request.commandId === set.commandId)).toHaveLength(1);
});

test('read query results keep hostile-looking output inert in the Conjur workspace', async () => {
  const read = task('whoami', 'read', []);
  vi.mocked(createRun).mockResolvedValueOnce(run('whoami', '<img id="conjur-task-pwn" onerror=alert(1)>'));
  render(<ConjurTaskPanel {...props} task={read} />);
  fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
  expect(await screen.findByText('<img id="conjur-task-pwn" onerror=alert(1)>')).toBeInTheDocument();
  expect(document.querySelector('#conjur-task-pwn')).toBeNull();
  expect(vi.mocked(previewRun)).not.toHaveBeenCalled();
});
