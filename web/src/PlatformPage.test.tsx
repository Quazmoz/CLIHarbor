import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      ...(requests === 1 ? {
        packId: platform.packId, toolId: platform.toolId,
        target: { applianceUrl: 'https://previous.example.test', account: 'previous' },
      } : {}),
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

test('Conjur homepage reveals migration playbooks without dispatching any CLI operation', () => {
  const onOpenTask = vi.fn();
  const props = {
    platform, tasks, onOpenFeature: vi.fn(), onOpenDiagnostics: vi.fn(), onOpenTask,
  };
  render(<PlatformPage {...props} />);
  const section = document.getElementById('conjur-migration');
  expect(section).not.toBeNull();
  expect(section).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: 'Migration playbooks & templates' }));
  expect(section).toHaveAttribute('open');
  expect(screen.getByRole('heading', { name: 'Migration playbooks and policy templates' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Variable IDs · unavailable' })).not.toBeInTheDocument();
  const stage = screen.getByRole('region', { name: '1 · Inventory the source' });
  expect(within(stage).getByRole('button', { name: 'Variable IDs' })).toBeEnabled();
  fireEvent.click(within(stage).getByRole('button', { name: 'Variable IDs' }));
  expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('cyberark-conjur-v9/list-variables', undefined);
});

test('Conjur overview invalidates a changed ready CLI and ignores late superseded audit responses', async () => {
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
    pending.push(resolve);
  })));
  const ready: ToolDiagnostic = {
    packId: platform.packId, packName: 'Conjur', packVersion: '1.0',
    toolId: platform.toolId, status: 'ready', version: '9.3.1',
  };
  const props = {
    platform, tasks, onOpenFeature: vi.fn(), onOpenDiagnostics: vi.fn(), onOpenTask: vi.fn(),
  };
  const reply = (url: string, packId = platform.packId) => new Response(JSON.stringify({
    available: true, packId, toolId: platform.toolId,
    state: 'idle', total: 0, processed: 0, inspected: 0, findings: [], failures: [],
    target: { applianceUrl: url, account: 'conjur' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const view = render(<PlatformPage {...props} tools={[ready]} />);
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => { pending[0](reply('https://old.example.test')); });
  expect(screen.getByText('https://old.example.test')).toBeInTheDocument();

  // Readiness remains ready, but the discovered CLI identity has changed.
  view.rerender(<PlatformPage {...props} tools={[{ ...ready, version: '9.3.2' }]} />);
  expect(screen.queryByText('https://old.example.test')).not.toBeInTheDocument();
  await waitFor(() => expect(pending).toHaveLength(2));

  // An older pending response cannot overwrite the latest context.
  view.rerender(<PlatformPage {...props} tools={[{ ...ready, version: '9.3.3' }]} />);
  await waitFor(() => expect(pending).toHaveLength(3));
  await act(async () => { pending[2](reply('https://current.example.test')); });
  await act(async () => { pending[1](reply('https://stale.example.test')); });
  expect(screen.getByText('https://current.example.test')).toBeInTheDocument();
  expect(screen.queryByText('https://stale.example.test')).not.toBeInTheDocument();

  // A response claiming a different pack must not become displayed authority.
  view.rerender(<PlatformPage {...props} tools={[{ ...ready, packVersion: '2.0' }]} />);
  await waitFor(() => expect(pending).toHaveLength(4));
  await act(async () => { pending[3](reply('https://foreign.example.test', 'foreign-pack')); });
  expect(screen.queryByText('https://foreign.example.test')).not.toBeInTheDocument();
  expect(screen.getAllByText('Not available')).toHaveLength(2);

  // An available payload without authoritative pack/tool ownership is also unsafe.
  view.rerender(<PlatformPage {...props} tools={[{ ...ready, packVersion: '3.0' }]} />);
  await waitFor(() => expect(pending).toHaveLength(5));
  await act(async () => {
    pending[4](new Response(JSON.stringify({
      available: true, state: 'idle', total: 0, processed: 0, inspected: 0,
      findings: [], failures: [],
      target: { applianceUrl: 'https://unknown.example.test', account: 'conjur' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });
  expect(screen.queryByText('https://unknown.example.test')).not.toBeInTheDocument();
  expect(screen.getAllByText('Not available')).toHaveLength(2);
});

test('Conjur migration draft identifiers are discarded when the vendor context changes', () => {
  const tool: ToolDiagnostic = {
    packId: platform.packId, packName: 'Conjur', packVersion: '1.0',
    toolId: platform.toolId, status: 'ready', version: '9.3.1',
  };
  const onOpenTask = vi.fn();
  const props = {
    platform, tasks, onOpenFeature: vi.fn(), onOpenDiagnostics: vi.fn(), onOpenTask,
  };
  const view = render(<PlatformPage {...props} tools={[tool]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Migration playbooks & templates' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Policy branch' }), {
    target: { value: 'previous/prod' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Variable ID (relative to branch)' }), {
    target: { value: 'old/secret' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: /Role ID/ }), {
    target: { value: '/old-group' },
  });
  expect(screen.getByRole('textbox', { name: 'Review-only policy YAML' }))
    .toHaveDisplayValue(/old\/secret/);

  // A changed CLI must not reuse identifiers entered for the previous target.
  view.rerender(<PlatformPage {...props} tools={[{ ...tool, version: '9.3.2' }]} />);
  expect(screen.getByRole('textbox', { name: 'Policy branch' })).toHaveValue('root');
  expect(screen.getByRole('textbox', { name: 'Variable ID (relative to branch)' })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: /Role ID/ })).toHaveValue('');
  expect(screen.queryByRole('textbox', { name: 'Review-only policy YAML' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Review access grant · approval required' })).not.toBeInTheDocument();
  expect(onOpenTask).not.toHaveBeenCalled();
});
