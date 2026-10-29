import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { installFakeBackend } from './test/fakeBackend';
import { newestFirst, OverviewPage } from './OverviewPage';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import type { TaskPreferences } from './taskPreferences';

const tasks: Task[] = [
  {
    packId: 'conjur',
    packName: 'Conjur',
    commandId: 'whoami',
    name: 'Current identity',
    toolId: 'conjur',
    risk: 'read',
    toolVersion: '9.3.1',
    requiresAuth: true,
    inputs: [],
  },
  {
    packId: 'docker',
    packName: 'Docker',
    commandId: 'containers',
    name: 'List containers',
    toolId: 'docker',
    risk: 'read',
    inputs: [],
  },
];

const readyTools: ToolDiagnostic[] = [
  {
    packId: 'conjur',
    packName: 'Conjur',
    packVersion: '0.2.0',
    toolId: 'conjur',
    status: 'ready',
    version: '9.3.1',
    requiresVendorSession: true,
    sessionCheck: {
      commandId: 'whoami',
      unauthenticatedStderrContains: 'please login again',
    },
    credentialLogin: {
      method: 'conjur-password',
    },
  },
  {
    packId: 'docker',
    packName: 'Docker',
    packVersion: '0.2.0',
    toolId: 'docker',
    status: 'ready',
  },
];

const preferences: TaskPreferences = {
  favorites: [{ packId: 'docker', commandId: 'containers' }],
  recent: [{ packId: 'conjur', commandId: 'whoami' }],
};

describe('OverviewPage', () => {
  // OverviewPage always loads retained runs on mount.
  beforeEach(() => {
    installFakeBackend({ 'GET /api/v1/runs': { body: { runs: [] } } });
  });

  test('shows setup guidance only before setup or prior use', async () => {
    installFakeBackend({ 'GET /api/v1/runs': { body: { runs: [] } } });
    const props = { tasks: [], tools: [], preferences: { favorites: [], recent: [] }, onNavigate: vi.fn(), onOpenTask: vi.fn() };
    const view = render(<OverviewPage {...props} />);
    expect(await screen.findByRole('list', { name: 'Getting started' })).toBeInTheDocument();
    fireEvent.click(within(document.querySelector<HTMLElement>('.overview-hero')!).getByRole('button', { name: 'Add a CLI' }));
    expect(props.onNavigate).toHaveBeenCalledWith('tools');
    view.rerender(<OverviewPage {...props} tasks={tasks} tools={readyTools} />);
    expect(screen.queryByRole('list', { name: 'Getting started' })).not.toBeInTheDocument();
    view.rerender(<OverviewPage {...props} preferences={preferences} />);
    expect(screen.queryByRole('list', { name: 'Getting started' })).not.toBeInTheDocument();
  });

  test('does not repeat onboarding after a retained run, even if setup is now unavailable', async () => {
    installFakeBackend({ 'GET /api/v1/runs': { body: { runs: [
      { runId: 'r1', packId: 'docker', commandId: 'containers', toolId: 'docker', status: 'exited', exitCode: 1 },
    ] } } });
    render(<OverviewPage tasks={[]} tools={[]} preferences={{ favorites: [], recent: [] }} onNavigate={vi.fn()} onOpenTask={vi.fn()} />);
    expect(await screen.findByText('Failed · exit 1')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Getting started' })).not.toBeInTheDocument();
  });

  test('keeps one next action and opens favorite or recent tasks directly', () => {
    const navigate = vi.fn();
    const openTask = vi.fn();

    render(
      <OverviewPage
        tasks={tasks}
        tools={readyTools}
        preferences={preferences}
        onNavigate={navigate}
        onOpenTask={openTask}
      />,
    );

    expect(screen.getByRole('heading', { name: 'What would you like to do?' })).toBeInTheDocument();
    expect(screen.queryByText('Local only')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tools needing attention' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Getting started' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Workspace summary')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /List containers/i }));
    expect(openTask).toHaveBeenCalledWith('docker/containers');

    fireEvent.click(screen.getByRole('button', { name: 'Open tasks' }));
    expect(navigate).toHaveBeenCalledWith('tasks');
  });

  test('routes the primary recommendation to diagnostics when no tasks are available and a tool needs attention', () => {
    const navigate = vi.fn();
    const attentionTools: ToolDiagnostic[] = [
      readyTools[0],
      { ...readyTools[1], status: 'missing', message: 'Tool was not found.' },
    ];

    render(
      <OverviewPage
        tasks={[]}
        tools={attentionTools}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={navigate}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Resolve tool readiness' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review tool readiness' }));
    expect(navigate).toHaveBeenCalledWith('diagnostics');
  });

  test('keeps available tools usable when another optional tool is missing', () => {
    const navigate = vi.fn();
    render(
      <OverviewPage tasks={[tasks[0]]}
        tools={[readyTools[0], { ...readyTools[1], status: 'missing' }]}
        preferences={{ favorites: [], recent: [] }} onNavigate={navigate} onOpenTask={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { name: 'What would you like to do?' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Tools needing attention' })).not.toBeInTheDocument();
    const optional = screen.getByRole('article', { name: 'More CLIs available' });
    expect(within(optional).getByText(/1 optional CLI is not installed/)).toBeInTheDocument();
    fireEvent.click(within(optional).getByRole('button', { name: 'Browse optional CLIs' }));
    expect(navigate).toHaveBeenCalledWith('tools');
    fireEvent.click(screen.getByRole('button', { name: 'Open tasks' }));
    expect(navigate).toHaveBeenCalledWith('tasks');
  });

  test('offers an actionable empty history and keeps genuine readiness failures visible', async () => {
    const navigate = vi.fn();
    render(<OverviewPage tasks={[tasks[0]]} tools={[readyTools[0], { ...readyTools[1], status: 'incompatible' }]}
      preferences={{ favorites: [], recent: [] }} onNavigate={navigate} onOpenTask={vi.fn()} />);
    expect(screen.getByRole('article', { name: 'Tools needing attention' })).toHaveTextContent('Docker');
    fireEvent.click(await screen.findByRole('button', { name: 'Build your first command' }));
    expect(navigate).toHaveBeenCalledWith('tasks');
  });

  test('leaves sign-in to the universal Sign in page instead of duplicating session cards', () => {
    render(
      <OverviewPage
        tasks={tasks}
        tools={readyTools}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Check session' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
  test('shows recent executions newest first with individual outcomes', async () => {
    installFakeBackend({ 'GET /api/v1/runs': { body: { runs: [
      { runId: 'r1', packId: 'docker', commandId: 'containers', toolId: 'docker', status: 'exited', exitCode: 0, startedAt: '2026-10-14T09:00:00Z', endedAt: '2026-10-14T09:00:02Z' },
      { runId: 'r2', packId: 'conjur', commandId: 'whoami', toolId: 'conjur', status: 'exited', exitCode: 1, startedAt: '2026-10-14T10:00:00Z', endedAt: '2026-10-14T10:00:01Z' },
    ] } } });
    const navigate = vi.fn();
    render(<OverviewPage tasks={tasks} tools={readyTools} preferences={preferences} onNavigate={navigate} onOpenTask={vi.fn()} />);

    expect(await screen.findByText('Failed · exit 1')).toBeInTheDocument();
    const items = screen.getAllByRole('button', { name: /Current identity|List containers/ }).filter((button) => button.closest('.overview-timeline'));
    expect(items.map((button) => button.textContent)).toEqual([
      expect.stringMatching(/^Current identity.*Failed · exit 1$/),
      expect.stringMatching(/^List containers.*2\.0 s.*Succeeded$/),
    ]);
    fireEvent.click(items[0]);
    expect(navigate).toHaveBeenCalledWith('runs');
  });
});

describe('newestFirst', () => {
  test('orders by instant, not by RFC 3339 string, and sinks unparseable times', () => {
    // Go's RFC3339Nano trims trailing zeros, so a whole second ("…:00Z")
    // sorts lexically AFTER a later fractional instant ("…:00.5Z").
    const ordered = newestFirst([
      { id: 'whole', startedAt: '2026-10-14T10:00:00Z' },
      { id: 'later-fraction', startedAt: '2026-10-14T10:00:00.5Z' },
      { id: 'missing' },
      { id: 'offset-latest', startedAt: '2026-10-14T12:30:00+02:00' },
      { id: 'garbage', startedAt: 'not a time' },
    ]);
    expect(ordered.map((run) => run.id).slice(0, 3)).toEqual(['offset-latest', 'later-fraction', 'whole']);
    expect(ordered.slice(3).map((run) => run.id).sort()).toEqual(['garbage', 'missing']);
  });
});
