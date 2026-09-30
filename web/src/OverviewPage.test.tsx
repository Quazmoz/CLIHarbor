import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { OverviewPage } from './OverviewPage';
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
  test('summarizes readiness and opens favorite or recent tasks directly', () => {
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

    expect(screen.getByRole('heading', { name: 'Ready for local operator work' })).toBeInTheDocument();
    expect(screen.getByText('2/2 ready')).toBeInTheDocument();
    expect(screen.getByText('2 tasks')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /List containers/i }));
    expect(openTask).toHaveBeenCalledWith('docker/containers');

    fireEvent.click(screen.getByRole('button', { name: 'Review authentication' }));
    expect(navigate).toHaveBeenCalledWith('authentication');
  });

  test('routes the primary recommendation to diagnostics when a tool needs attention', () => {
    const navigate = vi.fn();
    const attentionTools: ToolDiagnostic[] = [
      readyTools[0],
      { ...readyTools[1], status: 'missing', message: 'Tool was not found.' },
    ];

    render(
      <OverviewPage
        tasks={tasks}
        tools={attentionTools}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={navigate}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Resolve tool readiness' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Review tool readiness' })[0]);
    expect(navigate).toHaveBeenCalledWith('diagnostics');
  });

  test('keeps authentication status conservative rather than inventing a signed-in verdict', () => {
    render(
      <OverviewPage
        tasks={tasks}
        tools={readyTools}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.getByText('1 task declares vendor-session requirements')).toBeInTheDocument();
    expect(screen.queryByText(/^Authenticated$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Signed in$/i)).not.toBeInTheDocument();
  });
});
