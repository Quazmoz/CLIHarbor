import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConjurCreateSecret, fullVariableID } from './ConjurCreateSecret';
import { createRun, previewRun } from '../../api/runs';
import type { Task } from '../../api/tasks';
import type { RunPreview, RunSnapshot } from '../../api/runs';

vi.mock('../../api/runs', () => ({
  createRun: vi.fn(), previewRun: vi.fn(), fetchRun: vi.fn(),
  subscribeRunEvents: vi.fn(),
  decodeRunOutput: () => '{"exists":false}',
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
  impact: { targetLabel: 'Variable', target: commandId === 'secret-create' ? 'db/password' : 'apps/db/password', effect: 'Write', scope: 'single' },
  approval, context,
  ...(commandId === 'secret-create' ? { stdin: '- !variable\n  id: "db/password"\n' } : {}),
});
const snapshot = (commandId: string, ok = true): RunSnapshot => ({
  packId: PACK, commandId, toolId: 'conjur', runId: commandId + '-run',
  status: ok ? 'exited' : 'failed', exitCode: ok ? 0 : 1,
  ...(commandId === 'resource-exists' ? { structured: {
    status: 'available' as const, renderer: 'cards' as const,
    fields: [{ key: 'exists', label: 'Exists', type: 'boolean' as const, present: true, value: 'false' }],
  } } : {}),
});
const setup = () => {
  render(<ConjurCreateSecret tasks={tasks} csrfToken="test-csrf" account="dev" endpoint="https://example.test" contextKey="current" />);
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
afterEach(() => { vi.clearAllMocks(); });

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

test('absent approved capability disables the create entry point', () => {
  render(<ConjurCreateSecret tasks={tasks.filter((entry) => entry.commandId !== 'secret-set-value')}
    csrfToken="csrf" account="dev" endpoint="https://example.test" contextKey="current" />);
  expect(screen.getByRole('button', { name: /Create secret/ })).toBeDisabled();
});
