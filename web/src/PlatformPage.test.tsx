import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installFakeBackend } from './test/fakeBackend';
import { PlatformPage } from './PlatformPage';
import type { Task } from './api/tasks';
import type { Platform } from './api/platforms';
import type { ToolDiagnostic } from './api/tools';

const platform: Platform = {
  id: 'conjur', name: 'CyberArk Conjur', summary: 'Conjur test toolbox',
  packId: 'cyberark-conjur-v9', toolId: 'conjur', ready: true,
  features: [{ id: 'tasks', name: 'Conjur tasks' }, { id: 'sign-in', name: 'Sign in' },
    { id: 'security-audit', name: 'Security audit' }, { id: 'access-explorer', name: 'Access explorer' }],
};
const tasks: Task[] = [
  { packId: 'cyberark-conjur-v9', packName: 'Conjur', toolId: 'conjur', commandId: 'list-variables', name: 'Browse secret variable IDs', risk: 'read', inputs: [] },
  { packId: 'cyberark-conjur-v9', packName: 'Conjur', toolId: 'conjur', commandId: 'role-members', name: 'List role members', risk: 'read', inputs: [] },
  { packId: 'cyberark-conjur-v9', packName: 'Conjur', toolId: 'conjur', commandId: 'secret-delete', name: 'Delete secret variable', risk: 'destructive', inputs: [] },
  { packId: 'cyberark-conjur-v9', packName: 'Conjur', toolId: 'conjur', commandId: 'list-policies', name: 'List policies', risk: 'read', inputs: [] },
  { packId: 'other', packName: 'Other', toolId: 'other', commandId: 'list-variables', name: 'Spoof task', risk: 'read', inputs: [] },
];
const permissions: Task[] = [
  { packId: platform.packId, packName: 'Conjur', toolId: platform.toolId,
    commandId: 'secret-permit', name: 'Grant secret permission', risk: 'change', inputs: [] },
  { packId: platform.packId, packName: 'Conjur', toolId: platform.toolId,
    commandId: 'secret-deny', name: 'Revoke secret permission', risk: 'change', inputs: [] },
];

const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

test('Conjur workspace leads with environment context and keyboard-navigable workflow tabs', () => {
  render(<PlatformPage platform={platform} tasks={tasks} onOpenFeature={vi.fn()} onOpenDiagnostics={() => {}} onOpenTask={vi.fn()} />);
  const env = screen.getByLabelText('Conjur environment');
  // CLI readiness is never presented as a verified vendor session.
  expect(within(env).getByText('Not verified')).toBeInTheDocument();
  expect(within(env).getByRole('button', { name: 'Check identity' })).toBeEnabled();
  const secrets = screen.getByRole('tab', { name: 'Secrets' });
  expect(secrets).toHaveAttribute('aria-selected', 'true');
  secrets.focus();
  fireEvent.keyDown(secrets, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Access' })).toHaveFocus();
  expect(screen.getByRole('tabpanel', { name: 'Access' })).toBeVisible();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Access' }), { key: 'End' });
  expect(screen.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('tabpanel', { name: 'Secrets' })).not.toBeInTheDocument();
});

test('Conjur permission actions prioritize reviewed grant, revoke and inspection without executing', () => {
  const onOpenTask = vi.fn();
  const onOpenFeature = vi.fn();
  render(<PlatformPage platform={platform} tasks={[...tasks, ...permissions]}
    onOpenFeature={onOpenFeature} onOpenDiagnostics={() => {}} onOpenTask={onOpenTask} />);
  openTab('Access');
  const actions = screen.getByRole('group', { name: 'Conjur permission management' });
  const grant = within(actions).getByRole('button', { name: 'Grant permission' });
  const revoke = within(actions).getByRole('button', { name: 'Revoke permission' });
  const change = within(actions).getByRole('button', { name: 'Inspect access' });
  expect(grant).toBeEnabled();
  expect(revoke).toBeEnabled();
  expect(change).toBeEnabled();
  fireEvent.click(grant);
  fireEvent.click(revoke);
  fireEvent.click(change);
  expect(onOpenTask).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: 'Conjur action' })).toHaveValue('secret-deny');
  expect(onOpenFeature).toHaveBeenCalledExactlyOnceWith('access-explorer');
});

test('Conjur permission changes remain unavailable when CLI is missing or tasks are not approved', () => {
  const onOpenTask = vi.fn();
  const onOpenFeature = vi.fn();
  const mismatched: Task[] = [
    { ...permissions[0], risk: 'read' },
    { ...permissions[1], packId: 'other' },
  ];
  const view = render(<PlatformPage platform={platform} tasks={mismatched}
    onOpenFeature={onOpenFeature} onOpenDiagnostics={() => {}} onOpenTask={onOpenTask} />);
  openTab('Access');
  let actions = screen.getByRole('group', { name: 'Conjur permission management' });
  expect(within(actions).getByRole('button', { name: 'Grant permission' })).toBeDisabled();
  expect(within(actions).getByRole('button', { name: 'Revoke permission' })).toBeDisabled();
  expect(within(actions).getByRole('button', { name: 'Inspect access' })).toBeEnabled();
  view.rerender(<PlatformPage platform={{ ...platform, ready: false }} tasks={permissions}
    onOpenFeature={onOpenFeature} onOpenDiagnostics={() => {}} onOpenTask={onOpenTask} />);
  actions = screen.getByRole('group', { name: 'Conjur permission management' });
  expect(within(actions).getAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(true);
  // A stale platform-ready snapshot cannot override a missing CLI diagnostic.
  view.rerender(<PlatformPage platform={platform} tasks={permissions}
    tools={[{ packId: platform.packId, toolId: platform.toolId, packName: 'Conjur', packVersion: '0.7.0', status: 'missing' }]}
    onOpenFeature={onOpenFeature} onOpenDiagnostics={() => {}} onOpenTask={onOpenTask} />);
  actions = screen.getByRole('group', { name: 'Conjur permission management' });
  expect(within(actions).getAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(true);
  expect(onOpenTask).not.toHaveBeenCalled();
  expect(onOpenFeature).not.toHaveBeenCalled();
});

test('Conjur workflows only show backend-advertised tasks owned by this platform, each in one place', () => {
  const onOpenTask = vi.fn();
  render(<PlatformPage platform={platform} tasks={tasks} onOpenFeature={() => {}} onOpenDiagnostics={() => {}} onOpenTask={onOpenTask} />);
  expect(screen.getByRole('button', { name: 'Delete variable' })).toHaveTextContent('Destructive · approval required');
  // aria-label replaces the content, so the risk must reach screen readers as the description.
  expect(screen.getByRole('button', { name: 'Delete variable' })).toHaveAccessibleDescription(/Destructive · approval required/);
  expect(screen.queryByText('Spoof task')).not.toBeInTheDocument();
  openTab('Access');
  const inspection = screen.getByRole('group', { name: 'Access inspection' });
  fireEvent.click(within(inspection).getByRole('button', { name: 'List role members' }));
  openTab('Tools');
  const toolbox = screen.getByRole('group', { name: 'Conjur toolbox' });
  // Browsing variables has one canonical home under Secrets.
  expect(within(toolbox).queryByRole('button', { name: 'Browse secret variable IDs' })).not.toBeInTheDocument();
  expect(within(toolbox).queryByRole('button', { name: /All approved tasks|Diagnostics/ })).not.toBeInTheDocument();
  fireEvent.click(within(toolbox).getByRole('button', { name: 'List policies' }));
  expect(onOpenTask).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: 'Conjur action' })).toHaveValue('list-policies');
});

// The Conjur workspace polls the secret-audit snapshot on mount; declare it so
// the fail-loud backend accepts it. Tests that stub fetch themselves replace this.
beforeEach(() => {
  installFakeBackend({
    'GET /api/v1/conjur/secret-audit': {
      body: { available: false, state: 'idle', total: 0, processed: 0, inspected: 0, findings: [], failures: [] },
    },
  });
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
  openTab('Tools');
  fireEvent.click(screen.getByText('Migration playbooks & policy templates'));
  expect(section).toHaveAttribute('open');
  expect(screen.getByRole('heading', { name: 'Migration playbooks and policy templates' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Variable IDs · unavailable' })).not.toBeInTheDocument();
  const stage = screen.getByRole('region', { name: '1 · Inventory the source' });
  expect(within(stage).getByRole('button', { name: 'Variable IDs' })).toBeEnabled();
  fireEvent.click(within(stage).getByRole('button', { name: 'Variable IDs' }));
  expect(onOpenTask).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: 'Conjur action' })).toHaveValue('list-variables');
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

test('Conjur overview re-reads an externally changed target on return without discovery drift', async () => {
  const pending: Array<{ resolve: (response: Response) => void; signal?: AbortSignal | null }> = [];
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    pending.push({ resolve, signal: init?.signal });
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })));
  const ready: ToolDiagnostic = {
    packId: platform.packId, packName: 'Conjur', packVersion: '1.0',
    toolId: platform.toolId, status: 'ready', version: '9.3.1',
  };
  const reply = (url: string, account = 'conjur') => new Response(JSON.stringify({
    available: true, packId: platform.packId, toolId: platform.toolId,
    state: 'idle', total: 0, processed: 0, inspected: 0, findings: [], failures: [],
    target: { applianceUrl: url, account },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const view = render(<PlatformPage platform={platform} tasks={tasks} tools={[ready]}
    onOpenFeature={vi.fn()} onOpenDiagnostics={vi.fn()} onOpenTask={vi.fn()} />);
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => { pending[0].resolve(reply('https://old.example.test', 'old')); });
  expect(screen.getByText('https://old.example.test')).toBeInTheDocument();

  // `conjur init` rewrote ~/.conjurrc in a terminal; tool metadata is unchanged.
  act(() => { window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => { pending[1].resolve(reply('https://new.example.test', 'new')); });
  expect(screen.getByText('https://new.example.test')).toBeInTheDocument();
  expect(screen.getByText('new')).toBeInTheDocument();
  expect(screen.queryByText('https://old.example.test')).not.toBeInTheDocument();

  // A superseded refresh resolving late cannot restore its older target.
  act(() => { window.dispatchEvent(new Event('focus')); });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(pending).toHaveLength(4));
  expect(pending[2].signal?.aborted).toBe(true);
  await act(async () => { pending[3].resolve(reply('https://new.example.test', 'new')); });
  await act(async () => { pending[2].resolve(reply('https://stale.example.test', 'stale')); });
  expect(screen.queryByText('https://stale.example.test')).not.toBeInTheDocument();
  expect(screen.getByText('https://new.example.test')).toBeInTheDocument();

  // A failed refresh fails closed instead of keeping the last known target.
  act(() => { window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(pending).toHaveLength(5));
  await act(async () => { pending[4].resolve(new Response('{}', { status: 500 })); });
  expect(screen.queryByText('https://new.example.test')).not.toBeInTheDocument();
  expect(screen.getAllByText('Not available')).toHaveLength(2);

  // Unmount aborts the in-flight read and stops listening for returns.
  act(() => { window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(pending).toHaveLength(6));
  view.unmount();
  expect(pending[5].signal?.aborted).toBe(true);
  window.dispatchEvent(new Event('focus'));
  expect(pending).toHaveLength(6);
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
  openTab('Tools');
  fireEvent.click(screen.getByText('Migration playbooks & policy templates'));
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

test('Conjur Secrets tab exposes all four guarded CRUD operations', () => {
  const onOpenTask = vi.fn();
  render(<PlatformPage platform={platform} tasks={[...tasks, ...permissions,
    { packId: platform.packId, packName: 'Conjur', toolId: platform.toolId,
      commandId: 'secret-set-value', name: 'Update value', risk: 'change', inputs: [] }]}
    onOpenFeature={() => {}} onOpenDiagnostics={() => {}} onOpenTask={onOpenTask} />);
  const crud = screen.getByRole('group', { name: 'Conjur secret management' });
  expect(within(crud).getByRole('button', { name: 'Create secret' })).toBeDisabled();
  fireEvent.click(within(crud).getByRole('button', { name: 'Browse variables' }));
  fireEvent.click(within(crud).getByRole('button', { name: 'Update value' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete variable' }));
  expect(onOpenTask).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: 'Conjur action' })).toHaveValue('secret-delete');
});
