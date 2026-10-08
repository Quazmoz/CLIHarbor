import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConjurAccessExplorer, parseConjurIDs, metadataFromID, parseExists, validConjurID } from './ConjurAccessExplorer';
import { cancelRun, createRun } from '../../api/runs';
import { fetchTools } from '../../api/tools';
import { fetchSecretAudit } from './secretAuditApi';
import type { Task } from '../../api/tasks';

vi.mock('../../api/runs', () => ({ createRun: vi.fn(), fetchRun: vi.fn(), cancelRun: vi.fn(),
  decodeRunOutput: (snapshot: { commandId: string }) => {
    switch (snapshot.commandId) {
      case 'whoami': return '{"username":"operator","account":"dev"}';
      case 'list-resources': return '["dev:variable:billing/password","dev:group:operators"]';
      case 'resource-exists': return '{"exists":true}';
      case 'role-exists': return '{"exists":true}';
      case 'resource-permitted-roles': return '["dev:group:operators","dev:group:operators"]';
      case 'role-members': return '["dev:user:alice","dev:user:alice","dev:group:operators"]';
      case 'role-memberships': return '["dev:group:operators","dev:group:parent","dev:group:parent"]';
      default: throw Error('unexpected command');
    }
  },
}));
vi.mock('../../api/tools', () => ({ fetchTools: vi.fn() }));
vi.mock('./secretAuditApi', () => ({ fetchSecretAudit: vi.fn() }));

const read = (commandId: string, inputs: Array<Pick<Task['inputs'][number], 'id' | 'type'>> = []): Task =>
  ({ packId: 'cyberark-conjur-v9', toolId: 'conjur', packName: 'Conjur', name: commandId,
    risk: 'read', commandId, inputs: inputs.map((input) => ({ ...input, label: input.id })) });
const tasks = [
  read('whoami'), read('list-resources', [{ id: 'limit', type: 'enum' },
    { id: 'kind', type: 'enum' }, { id: 'search', type: 'string' }, { id: 'offset', type: 'integer' }]),
  read('resource-exists', [{ id: 'resource-id', type: 'string' }]),
  read('role-exists', [{ id: 'role-id', type: 'string' }]),
  read('resource-permitted-roles', [{ id: 'resource-id', type: 'string' }, { id: 'privilege', type: 'string' }]),
  read('role-members', [{ id: 'role-id', type: 'string' }]),
  read('role-memberships', [{ id: 'role-id', type: 'string' }]),
  { ...read('secret-delete'), risk: 'destructive' as const },
];

beforeEach(() => {
  vi.mocked(fetchSecretAudit).mockResolvedValue({
    available: true, state: 'idle', target: { applianceUrl: 'https://conjur.example', account: 'dev' },
    total: 0, processed: 0, inspected: 0, findings: [], failures: [],
  });
  vi.mocked(fetchTools).mockResolvedValue([{
    packId: 'cyberark-conjur-v9', packName: 'Conjur', packVersion: '0.7.0', toolId: 'conjur',
    status: 'ready', version: '9.3.1',
  }]);
  vi.mocked(createRun).mockImplementation(async (_, request) => ({
    runId: 'run-' + request.commandId, packId: request.packId, toolId: 'conjur',
    commandId: request.commandId, status: 'exited', exitCode: 0, events: [],
  }));
  vi.mocked(cancelRun).mockResolvedValue({
    runId: 'cancel', packId: 'cyberark-conjur-v9', toolId: 'conjur', commandId: 'whoami',
    status: 'cancelled', events: [],
  });
});
afterEach(() => { vi.clearAllMocks(); });

describe('vendor output boundaries', () => {
  test('rejects malformed and cross-account IDs', () => {
    expect(validConjurID('dev:group:operators', 'dev')).toBe(true);
    expect(validConjurID('elsewhere:group:operators', 'dev')).toBe(false);
    expect(validConjurID('-dev:variable:id')).toBe(false);
    expect(validConjurID('dev:variable:ok\u202Ehidden')).toBe(false);
    expect(() => parseConjurIDs('{"results":[]}', 25, 'dev')).toThrow();
    expect(() => parseConjurIDs('["other:group:private"]', 25, 'dev')).toThrow();
    expect(() => parseConjurIDs('["dev:group:a","dev:group:b"]', 1, 'dev')).toThrow();
  });
  test('deduplicates cycles and never exports unapproved metadata', () => {
    expect(parseConjurIDs('["dev:group:a","dev:group:a","dev:group:b"]', 5, 'dev'))
      .toEqual(['dev:group:a', 'dev:group:b']);
    expect(metadataFromID('dev:variable:p')).toEqual({ id: 'dev:variable:p', kind: 'variable' });
    expect(() => metadataFromID('unqualified')).toThrow();
    expect(parseExists('{"exists":true}')).toBe(true);
    expect(parseExists('{"exists":false}')).toBe(false);
    expect(() => parseExists('{"exists":true,"value":"bad"}')).toThrow();
    expect(() => parseExists('true')).toThrow();
  });
});

describe('Conjur access workflow', () => {
  test('queries only backend-advertised read tasks and navigates metadata without running changes', async () => {
    const onOpenTask = vi.fn();
    render(<ConjurAccessExplorer tasks={tasks} csrfToken="csrf" onOpenTask={onOpenTask}
      onOpenSignIn={() => {}} onOpenDiagnostics={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search inventory' }));
    const results = await screen.findByRole('region', { name: 'Explorer results' });
    const idButton = await within(results).findByRole('button', { name: 'dev:variable:billing/password' });
    fireEvent.click(idButton);
    await screen.findByRole('button', { name: 'Query Conjur-permitted roles (execute)' });
    expect(screen.queryByText('SHOULD_NOT_RENDER')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Query Conjur-permitted roles (execute)' }));
    const roles = await screen.findByRole('region', { name: 'Permitted roles' });
    expect(within(roles).getAllByRole('button')).toHaveLength(1);
    expect(roles).toHaveTextContent('not certify an individual identity');
    fireEvent.click(screen.getByRole('button', { name: 'Open read-only task form' }));
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('resource-permitted-roles',
      { 'resource-id': 'dev:variable:billing/password', privilege: 'execute' });
    expect(vi.mocked(createRun).mock.calls.map(([, request]) => request.commandId))
      .toEqual(['whoami', 'list-resources', 'whoami',
        'whoami', 'resource-exists', 'whoami', 'whoami', 'resource-permitted-roles', 'whoami']);
  });
  test('traverses nested roles without inventing effective permissions or executing mutations', async () => {
    render(<ConjurAccessExplorer tasks={tasks} csrfToken="csrf" onOpenTask={() => {}}
      onOpenSignIn={() => {}} onOpenDiagnostics={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('account:group:name'), { target: { value: 'dev:group:operators' } });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect role' }));
    await screen.findByRole('button', { name: 'List direct members' });
    fireEvent.click(screen.getByRole('button', { name: 'List direct members' }));
    const members = await screen.findByRole('region', { name: 'Direct members' });
    expect(within(members).getAllByRole('button')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'List memberships' }));
    const expanded = await screen.findByRole('region', { name: 'Expanded memberships' });
    expect(within(expanded).getAllByRole('button')).toHaveLength(2);
    expect(expanded).toHaveTextContent('not necessarily direct edges');
    expect(vi.mocked(createRun).mock.calls.every(([, req]) => req.commandId !== 'secret-delete')).toBe(true);
    expect(vi.mocked(createRun).mock.calls.every(([, req]) => req.commandId !== 'role-show')).toBe(true);
  });
  test('rejects context switch without showing stale inspection', async () => {
    let reads = 0;
    vi.mocked(fetchSecretAudit).mockImplementation(async () => ({
      available: true, state: 'idle', target: { applianceUrl: 'https://conjur.example',
        account: ++reads > 1 ? 'other' : 'dev' },
      total: 0, processed: 0, inspected: 0, findings: [], failures: [],
    }));
    render(<ConjurAccessExplorer tasks={tasks} csrfToken="csrf" onOpenTask={() => {}}
      onOpenSignIn={() => {}} onOpenDiagnostics={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search inventory' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/account|changed/);
    expect(screen.queryByRole('region', { name: 'Explorer results' })).not.toBeInTheDocument();
  });
  test('rejects denied reads instead of claiming no access', async () => {
    vi.mocked(createRun).mockImplementation(async (_, request) => ({
      runId: 'read', packId: request.packId, toolId: 'conjur', commandId: request.commandId,
      status: request.commandId === 'resource-permitted-roles' ? 'failed' : 'exited',
      exitCode: request.commandId === 'resource-permitted-roles' ? 1 : 0, events: [],
    }));
    render(<ConjurAccessExplorer tasks={tasks} csrfToken="csrf" onOpenTask={() => {}}
      onOpenSignIn={() => {}} onOpenDiagnostics={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('account:variable:path'), {
      target: { value: 'dev:variable:billing/password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect resource' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Query Conjur-permitted roles (execute)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not evidence of absent access');
    expect(screen.queryByRole('region', { name: 'Explorer results' })).not.toBeInTheDocument();
  });
  test('all actions remain disabled when no approved list command exists', async () => {
    render(<ConjurAccessExplorer tasks={[{ ...read('list-resources'), risk: 'change' }]} csrfToken="csrf"
      onOpenTask={() => {}} onOpenSignIn={() => {}} onOpenDiagnostics={() => {}} />);
    expect(screen.getByRole('button', { name: 'Search inventory' })).toBeDisabled();
    expect(createRun).not.toHaveBeenCalled();
  });
});
