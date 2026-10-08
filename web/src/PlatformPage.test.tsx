import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PlatformPage } from './PlatformPage';
import type { Task } from './api/tasks';
import type { Platform } from './api/platforms';
import type { ToolDiagnostic } from './api/tools';

const platform: Platform = {
  id: 'conjur', name: 'CyberArk Conjur', summary: 'Conjur test toolbox',
  packId: 'cyberark-conjur-v9', toolId: 'conjur', ready: true,
  features: [{ id: 'tasks', name: 'Conjur tasks' }, { id: 'sign-in', name: 'Sign in' },
    { id: 'security-audit', name: 'Security audit' }],
};
const tasks: Task[] = [
  { packId: 'cyberark-conjur-v9', packName: 'Conjur', toolId: 'conjur', commandId: 'list-variables', name: 'Browse secret variable IDs', risk: 'read', inputs: [] },
  { packId: 'cyberark-conjur-v9', packName: 'Conjur', toolId: 'conjur', commandId: 'role-members', name: 'List role members', risk: 'read', inputs: [] },
  { packId: 'cyberark-conjur-v9', packName: 'Conjur', toolId: 'conjur', commandId: 'secret-delete', name: 'Delete secret variable', risk: 'destructive', inputs: [] },
  { packId: 'other', packName: 'Other', toolId: 'other', commandId: 'list-variables', name: 'Spoof task', risk: 'read', inputs: [] },
];
test('Conjur toolbox only shows backend-advertised tasks owned by this platform', () => {
  const onOpenTask = vi.fn();
  render(<PlatformPage platform={platform} tasks={tasks} onOpenFeature={() => {}} onOpenDiagnostics={() => {}} onOpenTask={onOpenTask} />);
  const toolbox = screen.getByRole('region', { name: 'Conjur toolbox' });
  expect(within(toolbox).getByRole('button', { name: /Browse secret variable IDs/ })).toBeInTheDocument();
  expect(within(toolbox).getByRole('button', { name: /List role members/ })).toBeInTheDocument();
  expect(within(toolbox).getByRole('button', { name: /Delete secret variable/ })).toHaveTextContent('Approval required');
  expect(within(toolbox).queryByText('Spoof task')).not.toBeInTheDocument();
  fireEvent.click(within(toolbox).getByRole('button', { name: /Browse secret variable IDs/ }));
  expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('cyberark-conjur-v9/list-variables');
});

afterEach(() => vi.unstubAllGlobals());

test('Conjur environment overview clears stale account and endpoint on unavailable refresh', async () => {
  let requests = 0;
  vi.stubGlobal('fetch', vi.fn(() => {
    requests += 1;
    return Promise.resolve(new Response(JSON.stringify({
      available: requests === 1,
      state: 'idle',
      total: 0, processed: 0, inspected: 0,
      findings: [], failures: [],
      ...(requests === 1 ? { target: { applianceUrl: 'https://previous.example.test', account: 'previous' } } : {}),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }));

  const ready: ToolDiagnostic = {
    packId: platform.packId, packName: 'Conjur', packVersion: '1.0',
    toolId: platform.toolId, status: 'ready',
  };
  const props = {
    platform, tasks, onOpenFeature: vi.fn(), onOpenDiagnostics: vi.fn(), onOpenTask: vi.fn(),
  };
  const view = render(<PlatformPage {...props} tools={[ready]} />);
  expect(await screen.findByText('https://previous.example.test')).toBeInTheDocument();
  expect(screen.getByText('previous')).toBeInTheDocument();

  view.rerender(<PlatformPage {...props} tools={[{ ...ready, status: 'missing' }]} />);
  await waitFor(() => expect(requests).toBe(2));
  expect(screen.queryByText('https://previous.example.test')).not.toBeInTheDocument();
  expect(screen.queryByText('previous')).not.toBeInTheDocument();
  expect(screen.getAllByText('Not available')).toHaveLength(2);
});
