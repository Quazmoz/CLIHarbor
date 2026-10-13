import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OverviewPage } from './OverviewPage';
import type { RuntimeStatus } from './api/status';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import type { TaskPreferences } from './taskPreferences';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const status: RuntimeStatus = {
  name: 'CLIHarbor',
  version: 'dev',
  session: 'active',
  csrfToken: 'csrf-overview-test',
};

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OverviewPage', () => {
  test('summarizes readiness and opens favorite or recent tasks directly', () => {
    const navigate = vi.fn();
    const openTask = vi.fn();

    render(
      <OverviewPage
        status={status}
        tasks={tasks}
        tools={readyTools}
        preferences={preferences}
        onNavigate={navigate}
        onOpenTask={openTask}
        onOpenTool={vi.fn()} />,
    );

    expect(screen.getByRole('heading', { name: 'What would you like to do?' })).toBeInTheDocument();
    expect(screen.getByText('2/2 ready')).toBeInTheDocument();
    expect(screen.getByText('2 tasks')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /List containers/i }));
    expect(openTask).toHaveBeenCalledWith('docker/containers');

    fireEvent.click(screen.getByRole('button', { name: 'Open tasks' }));
    expect(navigate).toHaveBeenCalledWith('tasks');
  });

  test('sends dedicated-platform CLIs to their dedicated sign-in instead of rendering vendor forms', () => {
    const open = vi.fn();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(404, {}))));
    render(
      <OverviewPage
        status={status}
        tasks={tasks}
        tools={readyTools}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={vi.fn()}
        onOpenTask={vi.fn()}
        dedicatedSignInFor={(tool) => (tool.toolId === 'conjur' ? { platformName: 'CyberArk Conjur', open } : undefined)}
        onOpenTool={vi.fn()} />,
    );

    expect(screen.getByRole('heading', { name: 'Connect your CLIs' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Identity' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open CyberArk Conjur sign-in' }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  test('keeps a detected Conjur CLI visible when browser credential capability is unavailable', () => {
    const detectedWithoutBrowserLogin: ToolDiagnostic[] = [
      {
        ...readyTools[0],
        credentialLogin: undefined,
      },
      readyTools[1],
    ];

    render(
      <OverviewPage
        status={status}
        tasks={tasks}
        tools={detectedWithoutBrowserLogin}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={vi.fn()}
        onOpenTask={vi.fn()}
        onOpenTool={vi.fn()} />,
    );

    expect(screen.getByRole('heading', { name: 'CLI session checks' })).toBeInTheDocument();
    expect(screen.getByText('2/2 ready')).toBeInTheDocument();
    expect(
      screen.getByText(/approved conjur flow, then use the session check/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check session' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Identity' })).not.toBeInTheDocument();
  });

  test('routes the primary recommendation to diagnostics when no tasks are available and a tool needs attention', () => {
    const navigate = vi.fn();
    const attentionTools: ToolDiagnostic[] = [
      readyTools[0],
      { ...readyTools[1], status: 'missing', message: 'Tool was not found.' },
    ];

    render(
      <OverviewPage
        status={status}
        tasks={[]}
        tools={attentionTools}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={navigate}
        onOpenTask={vi.fn()}
        onOpenTool={vi.fn()} />,
    );

    expect(screen.getByRole('heading', { name: 'Resolve tool readiness' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review tool readiness' }));
    expect(navigate).toHaveBeenCalledWith('diagnostics');
  });

  test('keeps available tools usable when another optional tool is missing', () => {
    const navigate = vi.fn();
    render(
      <OverviewPage status={status} tasks={[tasks[0]]}
        tools={[readyTools[0], { ...readyTools[1], status: 'missing' }]}
        preferences={{ favorites: [], recent: [] }} onNavigate={navigate} onOpenTask={vi.fn()} onOpenTool={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { name: 'What would you like to do?' })).toBeInTheDocument();
    expect(screen.getByText('1/2 ready')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open tasks' }));
    expect(navigate).toHaveBeenCalledWith('tasks');
  });

  test('keeps authentication status conservative rather than inventing a signed-in verdict', () => {
    render(
      <OverviewPage
        status={status}
        tasks={tasks}
        tools={readyTools}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={vi.fn()}
        onOpenTask={vi.fn()}
        onOpenTool={vi.fn()} />,
    );

    expect(screen.getByText('1 task requires sign-in before use.')).toBeInTheDocument();
    expect(screen.queryByText(/^Authenticated$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Signed in$/i)).not.toBeInTheDocument();
  });

  test('shows every CLI independently and opens the selected approved tool catalog', () => {
    const navigate = vi.fn();
    const openTool = vi.fn();
    render(
      <OverviewPage status={status} tasks={tasks} tools={readyTools} preferences={preferences}
        onNavigate={navigate} onOpenTask={vi.fn()} onOpenTool={openTool} />,
    );
    expect(screen.getByRole('heading', { name: 'Your command-line tools' })).toBeInTheDocument();
    const toolList = screen.getByRole('list', { name: 'Configured command-line tools' });
    expect(toolList.querySelectorAll('.overview-tool--ready')).toHaveLength(2);
    expect(screen.getByText('1 approved task available. Vendor sign-in is checked separately.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Browse Conjur conjur tasks' }));
    expect(openTool).toHaveBeenCalledWith('conjur/conjur');
    expect(navigate).not.toHaveBeenCalled();
  });

  test('distinguishes an unavailable tool from a usable CLI without claiming sign-in', () => {
    const navigate = vi.fn();
    const openTool = vi.fn();
    render(
      <OverviewPage status={status} tasks={[tasks[0]]}
        tools={[readyTools[0], { ...readyTools[1], status: 'ambiguous', message: 'Multiple installations need review.' }]}
        preferences={{ favorites: [], recent: [] }} onNavigate={navigate}
        onOpenTask={vi.fn()} onOpenTool={openTool} />,
    );
    expect(screen.getByText('Multiple installations need review.')).toBeInTheDocument();
    expect(screen.getByText('ambiguous')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Diagnose Docker docker' }));
    expect(navigate).toHaveBeenCalledWith('diagnostics');
    expect(openTool).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Signed in$/i)).not.toBeInTheDocument();
  });

  test('provides a diagnostics path for a detected tool with no browser tasks', () => {
    const navigate = vi.fn();
    render(
      <OverviewPage status={status} tasks={[]} tools={[readyTools[0]]}
        preferences={{ favorites: [], recent: [] }} onNavigate={navigate} onOpenTask={vi.fn()} onOpenTool={vi.fn()} />,
    );
    expect(screen.getByText('Executable detected. No approved browser tasks are available.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Diagnose Conjur conjur' }));
    expect(navigate).toHaveBeenCalledWith('diagnostics');
  });

  test('keeps one clear Add a CLI action when no reviewed tools are configured', () => {
    const navigate = vi.fn();
    render(
      <OverviewPage status={status} tasks={[]} tools={[]}
        preferences={{ favorites: [], recent: [] }} onNavigate={navigate} onOpenTask={vi.fn()} onOpenTool={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { name: 'Get your CLIs ready' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add a CLI' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add a CLI' }));
    expect(navigate).toHaveBeenCalledWith('tools');
  });

  test('signals incomplete readiness without a green indicator', () => {
    const { container, rerender } = render(
      <OverviewPage status={status} tasks={[]} tools={[]}
        preferences={{ favorites: [], recent: [] }} onNavigate={vi.fn()} onOpenTask={vi.fn()} onOpenTool={vi.fn()} />,
    );
    expect(container.querySelector('.overview-status-indicator--attention')).not.toBeNull();
    rerender(
      <OverviewPage status={status} tasks={tasks} tools={readyTools}
        preferences={preferences} onNavigate={vi.fn()} onOpenTask={vi.fn()} onOpenTool={vi.fn()} />,
    );
    expect(container.querySelector('.overview-status-indicator--attention')).toBeNull();
  });

  test('keeps next-step shortcuts above CLI inventory and locks task switches during a run', () => {
    const onOpenTask = vi.fn();
    const onOpenTool = vi.fn();
    const { container } = render(
      <OverviewPage status={status} tasks={tasks} tools={readyTools}
        preferences={preferences} onNavigate={vi.fn()} onOpenTask={onOpenTask}
        onOpenTool={onOpenTool} navigationLocked />,
    );
    const layout = container.querySelector('.overview-layout');
    const inventory = container.querySelector('.overview-tool-section');
    expect(layout).not.toBeNull();
    expect(inventory).not.toBeNull();
    expect(Boolean(layout!.compareDocumentPosition(inventory!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    const shortcut = screen.getByRole('button', { name: /List containers/i });
    expect(shortcut).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Browse Conjur conjur tasks' })).toBeDisabled();
    expect(screen.getByText('Finish or cancel the active run before selecting another task.')).toBeInTheDocument();
    fireEvent.click(shortcut);
    fireEvent.click(screen.getByRole('button', { name: 'Browse Conjur conjur tasks' }));
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(onOpenTool).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'View diagnostics' })).toBeEnabled();
  });

  test('renders untrusted tool names as inert text rather than HTML', () => {
    const { container } = render(
      <OverviewPage status={status} tasks={[]} tools={[{
        ...readyTools[0], packName: '<img src=x onerror=alert(1)>', status: 'missing',
      }]} preferences={{ favorites: [], recent: [] }} onNavigate={vi.fn()} onOpenTask={vi.fn()} onOpenTool={vi.fn()} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  test('renders version strings without inventing a duplicate prefix', () => {
    render(
      <OverviewPage status={status} tasks={tasks} tools={[{ ...readyTools[0], version: 'v9.3.1' }]}
        preferences={{ favorites: [], recent: [] }} onNavigate={vi.fn()}
        onOpenTask={vi.fn()} onOpenTool={vi.fn()} />,
    );
    expect(screen.getByText('conjur · v9.3.1')).toBeInTheDocument();
    expect(screen.queryByText('conjur · vv9.3.1')).not.toBeInTheDocument();
  });

});
