import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { Task } from './api/tasks';
import { TaskDiscovery } from './TaskDiscovery';

const tasks: Task[] = [
  {
    packId: 'alpha',
    packName: 'Alpha Pack',
    commandId: 'inspect',
    name: 'Inspect resource',
    description: 'Read metadata for a resource',
    toolId: 'conjur',
    requiresAuth: true,
    inputs: [],
  },
  {
    packId: 'beta',
    packName: 'Beta Pack',
    commandId: 'inspect',
    name: 'Inspect resource',
    description: 'Check another catalog',
    toolId: 'idsec',
    inputs: [],
  },
  {
    packId: 'beta',
    packName: 'Beta Pack',
    commandId: 'list',
    name: '<img id="pwn" onerror="alert(1)">',
    description: '<script>window.pwned=true</script>',
    toolId: 'idsec',
    inputs: [],
  },
];

describe('TaskDiscovery', () => {
  test('distinguishes favorites, recent tasks, and the full catalog with safe auth wording', () => {
    const onSelect = vi.fn();
    const onToggleFavorite = vi.fn();
    const { container } = render(
      <TaskDiscovery
        tasks={tasks}
        selectedTaskKey="alpha/inspect"
        preferences={{
          favorites: [{ packId: 'alpha', commandId: 'inspect' }],
          recent: [{ packId: 'beta', commandId: 'inspect' }],
        }}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Favorites' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recently used' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All tasks' })).toBeInTheDocument();
    expect(screen.getAllByText('Requires vendor session').length).toBeGreaterThan(0);
    expect(screen.queryByText(/currently authenticated/i)).not.toBeInTheDocument();

    const favoriteSelect = container.querySelector(
      '[data-task-section="favorites"][data-task-action="select"][data-task-key="alpha/inspect"]',
    );
    expect(favoriteSelect).not.toBeNull();
    fireEvent.click(favoriteSelect!);
    expect(onSelect).toHaveBeenCalledWith('alpha/inspect');

    const favoriteToggle = container.querySelector(
      '[data-task-section="favorites"][data-task-action="favorite"][data-task-key="alpha/inspect"]',
    );
    expect(favoriteToggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(favoriteToggle!);
    expect(onToggleFavorite).toHaveBeenCalledWith(tasks[0]);
  });

  test('filters by safe catalog metadata, clears easily, and shows a useful empty state', () => {
    render(
      <TaskDiscovery
        tasks={tasks}
        selectedTaskKey="alpha/inspect"
        preferences={{ favorites: [], recent: [] }}
        onSelect={vi.fn()}
        onToggleFavorite={vi.fn()}
      />,
    );

    const search = screen.getByRole('searchbox', { name: 'Search tasks' });
    fireEvent.change(search, { target: { value: 'conjur' } });
    expect(screen.getAllByText('Inspect resource')).toHaveLength(1);
    expect(screen.queryByText('Check another catalog')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'does-not-exist' } });
    expect(screen.getByText(/No tasks match/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(search).toHaveValue('');
    expect(screen.getAllByText('Inspect resource').length).toBeGreaterThan(1);
  });

  test('slash focuses search without stealing the key while typing', () => {
    render(
      <TaskDiscovery
        tasks={tasks}
        selectedTaskKey=""
        preferences={{ favorites: [], recent: [] }}
        onSelect={vi.fn()}
        onToggleFavorite={vi.fn()}
      />,
    );
    const search = screen.getByRole('searchbox', { name: 'Search tasks' });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(search).toHaveFocus();

    fireEvent.change(search, { target: { value: 'abc' } });
    fireEvent.keyDown(search, { key: '/' });
    expect(search).toHaveValue('abc');
  });

  test('hostile task metadata remains inert and duplicate names stay disambiguated', () => {
    const { container } = render(
      <TaskDiscovery
        tasks={tasks}
        selectedTaskKey=""
        preferences={{ favorites: [], recent: [] }}
        onSelect={vi.fn()}
        onToggleFavorite={vi.fn()}
      />,
    );
    expect(container.querySelector('#pwn')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getAllByText('Inspect resource')).toHaveLength(2);

    const all = screen.getByRole('heading', { name: 'All tasks' }).closest('section');
    expect(all).not.toBeNull();
    expect(within(all!).getByText(/Alpha Pack · conjur · inspect/)).toBeInTheDocument();
    expect(within(all!).getByText(/Beta Pack · idsec · inspect/)).toBeInTheDocument();
  });
});
