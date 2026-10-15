import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConjurCreateSecret, fullVariableID } from './ConjurCreateSecret';
import { createRun, fetchRun, previewRun, subscribeRunEvents } from '../../api/runs';
import type { Task } from '../../api/tasks';
import type { RunPreview, RunSnapshot } from '../../api/runs';

vi.mock('../../api/runs', async (importOriginal) => ({
  createRunOutputDecoder: (await importOriginal<typeof import('../../api/runs')>()).createRunOutputDecoder,
  createRun: vi.fn(), previewRun: vi.fn(), fetchRun: vi.fn(),
  subscribeRunEvents: vi.fn(),
}));

const PACK = 'cyberark-conjur-v9';
const task = (commandId: string, risk: Task['risk'], inputs: Array<[string, Task['inputs'][number]['type']]>): Task => ({
  packId: PACK, toolId: 'conjur', packName: 'Conjur', commandId, name: commandId,
  risk, requiresAuth: true, inputs: inputs.map(([id, type]) => ({
    id, type, label: id, required: type !== 'boolean',
  })),
});
const tasks: Task[] = [
  task('resource-exists', 'read', [['resource-id', 'string']]),
  task('secret-create', 'change', [['policy-branch', 'string'], ['variable-id', 'string'], ['dry-run', 'boolean']]),
  task('secret-set-value', 'change', [['variable-id', 'string'], ['value', 'secret']]),
];
const approval = { id: 'a'.repeat(32), mode: 'explicit' as const, expiresAt: '2026-11-01T00:00:00Z' };
const context = { fields: [{ label: 'Account', value: 'dev' }, { label: 'Endpoint', value: 'https://example.test' }] };
const preview = (commandId: string): RunPreview => ({
  packId: PACK, commandId, toolId: 'conjur', executableName: 'conjur',
  args: ['policy'], risk: 'change',
  impact: { targetLabel: 'Variable', target: commandId === 'secret-set-value' ? 'apps/db/password' : 'db/password', effect: 'Write', scope: 'single' },
  approval, context,
  ...(commandId === 'secret-set-value' ? {} : { stdin: '- !' + commandId + '\n' }),
});
const snapshot = (commandId: string, ok = true): RunSnapshot => ({
  packId: PACK, commandId, toolId: 'conjur', runId: commandId + '-run',
  status: ok ? 'exited' : 'failed', exitCode: ok ? 0 : 1,
  ...(commandId === 'resource-exists' ? { structured: {
    status: 'available' as const, renderer: 'cards' as const,
    fields: [{ key: 'exists', label: 'Exists', type: 'boolean' as const, present: true, value: 'false' }],
  } } : {}),
});
const setup = (onOpenRuns?: () => void) => {
  render(<ConjurCreateSecret tasks={tasks} csrfToken="test-csrf" account="dev" endpoint="https://example.test"
    contextKey="current" onOpenRuns={onOpenRuns} />);
  const region = screen.getByRole('region', { name: 'Create Conjur secret' });
  fireEvent.click(within(region).getByRole('button', { name: /Create secret/ }));
  fireEvent.change(within(region).getByRole('textbox', { name: /Policy branch/ }), {
    target: { value: 'apps' },
  });
  fireEvent.change(within(region).getByRole('textbox', { name: /New variable ID/ }), {
    target: { value: 'db/password' },
  });
  fireEvent.change(within(region).getByLabelText('Initial secret value'), {
    target: { value: 'never-store-me' },
  });
  return region;
};
beforeEach(() => {
  vi.mocked(previewRun).mockImplementation(async (_, request) => preview(request.commandId));
  vi.mocked(createRun).mockImplementation(async (_, request) => snapshot(request.commandId));
});
afterEach(() => { vi.resetAllMocks(); });

test('defaults to the data branch on SaaS and refuses root before any approval', async () => {
  render(<ConjurCreateSecret tasks={tasks} csrfToken="test-csrf" account="conjur"
    endpoint="https://tenant.secretsmgr.cyberark.cloud/api" contextKey="current" />);
  const region = screen.getByRole('region', { name: 'Create Conjur secret' });
  fireEvent.click(within(region).getByRole('button', { name: /Create secret/ }));
  const branch = within(region).getByRole('textbox', { name: /Policy branch/ });
  expect(branch).toHaveValue('data');
  fireEvent.change(within(region).getByRole('textbox', { name: /New variable ID/ }), { target: { value: 'db/password' } });
  fireEvent.change(within(region).getByLabelText('Initial secret value'), { target: { value: 'v' } });
  expect(within(region).getByText('data/db/password')).toBeInTheDocument();
  fireEvent.change(branch, { target: { value: 'root' } });
  expect(within(region).getByRole('alert')).toHaveTextContent(/root policy/);
  expect(within(region).getByRole('button', { name: 'Review creation and value' })).toBeDisabled();
  expect(createRun).not.toHaveBeenCalled();
});

test('normalizes simple branch paths and rejects ambiguous identifiers', () => {
  expect(fullVariableID('root', 'db/password')).toBe('db/password');
  expect(fullVariableID('apps', 'db/password')).toBe('apps/db/password');
  expect(fullVariableID('apps/../../escape', 'pass')).toBeNull();
  expect(fullVariableID('apps', '-flag')).toBeNull();
  expect(fullVariableID('apps', 'db\npassword')).toBeNull();
});

test('one form reviews two approved plans and executes them in sequence without revealing value', async () => {
  const region = setup();
  expect(createRun).not.toHaveBeenCalled();
  fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
  await waitFor(() => expect(previewRun).toHaveBeenCalledTimes(2));
  expect(vi.mocked(createRun).mock.calls[0][1]).toMatchObject({
    commandId: 'resource-exists', values: { 'resource-id': 'dev:variable:apps/db/password' },
  });
  expect(within(region).getByText(/2. Set initial value/)).toBeInTheDocument();
  expect(within(region).queryByText('never-store-me')).not.toBeInTheDocument();
  fireEvent.click(within(region).getByRole('checkbox', { name: /I approve both changes/ }));
  fireEvent.click(within(region).getByRole('button', { name: 'Create secret and store value' }));
  await waitFor(() => expect(within(region).getByText(/initial value stored/)).toBeInTheDocument());
  expect(vi.mocked(createRun).mock.calls.map((call) => call[1].commandId))
    .toEqual(['resource-exists', 'resource-exists', 'secret-create', 'secret-set-value']);
  expect(vi.mocked(createRun).mock.calls[3][1]).toMatchObject({
    commandId: 'secret-set-value', values: { 'variable-id': 'apps/db/password', value: 'never-store-me' },
    approval: { id: approval.id },
  });
  expect(within(region).getByLabelText('Initial secret value')).toHaveValue('');
});

test('failure to store value stops workflow with explicit partial-completion guidance', async () => {
  vi.mocked(createRun).mockImplementation(async (_, request) =>
    snapshot(request.commandId, request.commandId !== 'secret-set-value'));
  const region = setup();
  fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
  await waitFor(() => expect(previewRun).toHaveBeenCalledTimes(2));
  fireEvent.click(within(region).getByRole('checkbox', { name: /I approve both changes/ }));
  fireEvent.click(within(region).getByRole('button', { name: 'Create secret and store value' }));
  await waitFor(() => expect(within(region).getByRole('alert')).toHaveTextContent('Partial completion'));
  expect(within(region).getByRole('alert')).not.toHaveTextContent('never-store-me');
  expect(within(region).getByLabelText('Initial secret value')).toHaveValue('');
});

test('failed Conjur existence checks preserve the run ID without permitting writes', async () => {
  vi.mocked(createRun).mockResolvedValue(snapshot('resource-exists', false));
  const onOpenRuns = vi.fn();
  const region = setup(onOpenRuns);
  fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
  await waitFor(() => expect(within(region).getByRole('alert')).toHaveTextContent('read-only existence check failed'));
  expect(within(region).getByText('resource-exists-run')).toBeInTheDocument();
  fireEvent.click(within(region).getByRole('button', { name: 'Inspect failed check in Runs' }));
  expect(onOpenRuns).toHaveBeenCalledTimes(1);
  expect(within(region).queryByText('never-store-me')).not.toBeInTheDocument();
  expect(previewRun).not.toHaveBeenCalled();
  expect(vi.mocked(createRun).mock.calls.map(([, request]) => request.commandId))
    .toEqual(['resource-exists']);
});

test('checks the account-prefixed resource ID against the Conjur input length limit', () => {
  render(<ConjurCreateSecret tasks={tasks} csrfToken="test-csrf" account="dev" endpoint="https://example.test"
    contextKey="current" />);
  const region = screen.getByRole('region', { name: 'Create Conjur secret' });
  fireEvent.click(within(region).getByRole('button', { name: /Create secret/ }));
  fireEvent.change(within(region).getByRole('textbox', { name: /New variable ID/ }), {
    target: { value: 'a'.repeat(2040) },
  });
  fireEvent.change(within(region).getByLabelText('Initial secret value'), { target: { value: 'v' } });
  expect(within(region).getByRole('alert')).toHaveTextContent('2,048-character limit');
  expect(within(region).getByRole('button', { name: 'Review creation and value' })).toBeDisabled();
  expect(createRun).not.toHaveBeenCalled();
});

test('existing variable prevents all mutating previews and execution', async () => {
  vi.mocked(createRun).mockImplementation(async () => ({
    ...snapshot('resource-exists'), structured: {
      status: 'available', renderer: 'cards',
      fields: [{ key: 'exists', label: 'Exists', type: 'boolean', present: true, value: 'true' }],
    },
  }));
  const region = setup();
  fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
  await waitFor(() => expect(within(region).getByRole('alert')).toHaveTextContent('already exists'));
  expect(previewRun).not.toHaveBeenCalled();
  expect(createRun).toHaveBeenCalledTimes(1);
});

test('asynchronous existence completion fetches the authoritative structured result', async () => {
  vi.mocked(createRun).mockImplementation(async (_, request) => request.commandId === 'resource-exists'
    ? { ...snapshot('resource-exists'), status: 'running', exitCode: undefined, structured: undefined }
    : snapshot(request.commandId));
  vi.mocked(subscribeRunEvents).mockImplementation((runId, _onEvent, onComplete) => {
    queueMicrotask(() => onComplete({ runId, sequence: 0, status: 'exited', exitCode: 0 }));
    return () => {};
  });
  vi.mocked(fetchRun).mockResolvedValue(snapshot('resource-exists'));

  const region = setup();
  fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
  await waitFor(() => expect(previewRun).toHaveBeenCalledTimes(2));
  expect(fetchRun).toHaveBeenCalledWith('resource-exists-run', expect.any(AbortSignal));
  expect(within(region).getByText(/2. Set initial value/)).toBeInTheDocument();
});

test('asynchronous existence check blocks creation when the final snapshot reports existing', async () => {
  vi.mocked(createRun).mockResolvedValue({
    ...snapshot('resource-exists'), status: 'running', exitCode: undefined, structured: undefined,
  });
  vi.mocked(subscribeRunEvents).mockImplementation((runId, _onEvent, onComplete) => {
    queueMicrotask(() => onComplete({ runId, sequence: 0, status: 'exited', exitCode: 0 }));
    return () => {};
  });
  vi.mocked(fetchRun).mockResolvedValue({
    ...snapshot('resource-exists'), structured: {
      status: 'available', renderer: 'cards',
      fields: [{ key: 'exists', label: 'Exists', type: 'boolean', present: true, value: 'true' }],
    },
  });
  const region = setup();
  fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
  await waitFor(() => expect(within(region).getByRole('alert')).toHaveTextContent('already exists'));
  expect(previewRun).not.toHaveBeenCalled();
});

test('invalid structured existence evidence never falls back to unvalidated stdout', async () => {
  vi.mocked(createRun).mockResolvedValue({
    ...snapshot('resource-exists'), structured: {
      status: 'invalid', renderer: 'cards', error: 'duplicate_key',
    },
  });
  const region = setup();
  fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
  await waitFor(() => expect(within(region).getByRole('alert')).toHaveTextContent('unrecognized existence result'));
  expect(previewRun).not.toHaveBeenCalled();
});

test('successful stream completion never substitutes for a failed authoritative creation run', async () => {
  vi.mocked(createRun).mockImplementation(async (_, request) => request.commandId === 'secret-create'
    ? { ...snapshot('secret-create'), status: 'running', exitCode: undefined }
    : snapshot(request.commandId));
  vi.mocked(subscribeRunEvents).mockImplementation((runId, _onEvent, onComplete) => {
    queueMicrotask(() => onComplete({ runId, sequence: 0, status: 'exited', exitCode: 0 }));
    return () => {};
  });
  vi.mocked(fetchRun).mockResolvedValue(snapshot('secret-create', false));

  const region = setup();
  fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
  await waitFor(() => expect(previewRun).toHaveBeenCalledTimes(2));
  fireEvent.click(within(region).getByRole('checkbox', { name: /I approve both changes/ }));
  fireEvent.click(within(region).getByRole('button', { name: 'Create secret and store value' }));
  await waitFor(() => expect(within(region).getByRole('alert')).toHaveTextContent('did not confirm variable creation'));
  expect(vi.mocked(createRun).mock.calls.map(([, request]) => request.commandId))
    .toEqual(['resource-exists', 'resource-exists', 'secret-create']);
  expect(fetchRun).toHaveBeenCalledWith('secret-create-run', expect.any(AbortSignal));
});

test('duplicate run-completion notifications reconcile only once', async () => {
  vi.mocked(createRun).mockImplementation(async (_, request) => request.commandId === 'resource-exists'
    ? { ...snapshot('resource-exists'), status: 'running', exitCode: undefined, structured: undefined }
    : snapshot(request.commandId));
  vi.mocked(subscribeRunEvents).mockImplementation((runId, _onEvent, onComplete) => {
    queueMicrotask(() => {
      onComplete({ runId, sequence: 0, status: 'exited', exitCode: 0 });
      onComplete({ runId, sequence: 0, status: 'exited', exitCode: 0 });
    });
    return () => {};
  });
  vi.mocked(fetchRun).mockResolvedValue(snapshot('resource-exists'));

  const region = setup();
  fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
  await waitFor(() => expect(previewRun).toHaveBeenCalledTimes(2));
  expect(fetchRun).toHaveBeenCalledTimes(1);
});

test('hung final snapshot lookup fails closed without starting previews', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(createRun).mockResolvedValue({
      ...snapshot('resource-exists'), status: 'running', exitCode: undefined, structured: undefined,
    });
    vi.mocked(subscribeRunEvents).mockImplementation((runId, _onEvent, onComplete) => {
      queueMicrotask(() => onComplete({ runId, sequence: 0, status: 'exited', exitCode: 0 }));
      return () => {};
    });
    vi.mocked(fetchRun).mockImplementation(async (_runId, signal) =>
      new Promise<RunSnapshot>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));

    const region = setup();
    fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_100);
    });
    expect(within(region).getByRole('alert')).toHaveTextContent('Run outcome is unknown');
    expect(previewRun).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('absent approved capability disables the create entry point', () => {
  render(<ConjurCreateSecret tasks={tasks.filter((entry) => entry.commandId !== 'secret-set-value')}
    csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="current" />);
  expect(screen.getByRole('button', { name: /Create secret/ })).toBeDisabled();
});

test('a preview for a different Conjur account fails closed before any write', async () => {
  vi.mocked(previewRun).mockImplementation(async (_, request) => ({
    ...preview(request.commandId),
    context: { fields: [{ label: 'Account', value: 'other-tenant' },
      { label: 'Endpoint', value: 'https://example.test' }] },
  }));
  const region = setup();
  fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
  await waitFor(() => expect(within(region).getByRole('alert')).toHaveTextContent('matching approved plans'));
  expect(vi.mocked(createRun).mock.calls.map(([, request]) => request.commandId))
    .toEqual(['resource-exists']);
  expect(within(region).queryByRole('button', { name: 'Create secret and store value' })).not.toBeInTheDocument();
});

const roleLists: Record<string, string[]> = {
  policy: ['dev:policy:root', 'dev:policy:apps'], group: ['dev:group:admins'],
  host: ['dev:host:apps/web'], layer: [], user: ['dev:user:alice', 'other:user:mallory'],
};
const listed = (kind: string): RunSnapshot => ({
  ...snapshot('list-resources'), events: [{ sequence: 1, type: 'stdout.chunk', timestamp: '',
    dataBase64: btoa(JSON.stringify(roleLists[kind])) }],
});

test('dropdowns pick parent policy, owner and access, then run three approved steps in order', async () => {
  vi.mocked(createRun).mockImplementation(async (_, request) => request.commandId === 'list-resources'
    ? listed(request.values.kind as string) : snapshot(request.commandId));
  render(<ConjurCreateSecret csrfToken="test-csrf" account="dev" endpoint="https://example.test" contextKey="current"
    tasks={[...tasks,
      task('list-resources', 'read', [['kind', 'enum'], ['limit', 'enum']]),
      task('secret-create-owned', 'change', [['policy-branch', 'string'], ['variable-id', 'string'],
        ['owner-kind', 'enum'], ['owner-id', 'string'], ['dry-run', 'boolean']]),
      task('secret-permit', 'change', [['policy-branch', 'string'], ['variable-id', 'string'],
        ['role-kind', 'enum'], ['role-id', 'string'], ['privileges', 'enum'], ['dry-run', 'boolean']]),
    ]} />);
  const region = screen.getByRole('region', { name: 'Create Conjur secret' });
  fireEvent.click(within(region).getByRole('button', { name: /Create secret/ }));
  const parent = await within(region).findByRole('combobox', { name: /^Parent policy/ });
  expect(within(parent).getAllByRole('option').map((option) => option.textContent)).toEqual(['root', 'apps']);
  // Roles from another account are never offered.
  expect(within(region).queryByRole('option', { name: 'mallory' })).not.toBeInTheDocument();
  fireEvent.change(parent, { target: { value: 'apps' } });
  fireEvent.change(within(region).getByRole('combobox', { name: /^Owner/ }), { target: { value: 'group:admins' } });
  fireEvent.change(within(region).getByRole('combobox', { name: /^Accessible by/ }), { target: { value: 'host:apps/web' } });
  fireEvent.change(within(region).getByRole('textbox', { name: /New variable ID/ }), { target: { value: 'db/password' } });
  fireEvent.change(within(region).getByLabelText('Initial secret value'), { target: { value: 'never-store-me' } });
  fireEvent.click(within(region).getByRole('button', { name: 'Review creation and value' }));
  await waitFor(() => expect(previewRun).toHaveBeenCalledTimes(3));
  fireEvent.click(within(region).getByRole('checkbox', { name: /I approve all three changes/ }));
  fireEvent.click(within(region).getByRole('button', { name: 'Create secret and store value' }));
  await waitFor(() => expect(within(region).getByText(/access granted/)).toBeInTheDocument());
  const writes = vi.mocked(createRun).mock.calls.map(([, request]) => request)
    .filter((request) => request.commandId.startsWith('secret-'));
  expect(writes.map((request) => request.commandId)).toEqual(['secret-create-owned', 'secret-set-value', 'secret-permit']);
  expect(writes[0].values).toMatchObject({ 'policy-branch': 'apps', 'owner-kind': 'group', 'owner-id': '/admins' });
  expect(writes[2].values).toMatchObject({
    'policy-branch': 'apps', 'variable-id': 'db/password', 'role-kind': 'host', 'role-id': '/apps/web', privileges: 'read, execute',
  });
  expect(writes.every((request) => request.approval?.id === approval.id)).toBe(true);
});

test('an unlistable inventory keeps the typed branch and default owner without blocking creation', async () => {
  vi.mocked(createRun).mockImplementation(async (_, request) => snapshot(request.commandId, request.commandId !== 'list-resources'));
  render(<ConjurCreateSecret csrfToken="test-csrf" account="dev" endpoint="https://example.test" contextKey="current"
    tasks={[...tasks, task('list-resources', 'read', [['kind', 'enum'], ['limit', 'enum']])]} />);
  const region = screen.getByRole('region', { name: 'Create Conjur secret' });
  fireEvent.click(within(region).getByRole('button', { name: /Create secret/ }));
  await waitFor(() => expect(within(region).getByRole('alert')).toHaveTextContent('could not be listed'));
  expect(within(region).getByRole('textbox', { name: /Policy branch/ })).toHaveValue('root');
  expect(within(region).getByRole('combobox', { name: /^Owner/ })).toBeDisabled();
});
