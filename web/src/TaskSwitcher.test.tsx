import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Task } from './api/tasks';
import { TaskSwitcher } from './TaskSwitcher';
import { emptyTaskPreferences } from './taskPreferences';

const tasks: Task[] = [
  {
    packId: 'conjur', packName: 'CyberArk Conjur', toolId: 'conjur', commandId: 'list',
    name: 'List variables', description: 'Inspect approved variable metadata.',
    risk: 'read', requiresAuth: true, inputs: [],
  },
  {
    packId: 'docker', packName: 'Docker', toolId: 'docker', commandId: 'remove',
    name: 'Remove container', description: 'Remove a named container.',
    risk: 'destructive', inputs: [],
  },
  {
    packId: 'github', packName: 'GitHub CLI', toolId: 'gh', commandId: 'status',
    name: 'Repository status', risk: 'read', inputs: [],
  },
];

const showModalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeEach(() => {
  // jsdom does not implement the browser's top-layer dialog behavior.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true, value(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    },
  });
});

afterEach(() => {
  if (showModalDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModalDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (closeDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'close', closeDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

test('searches only the approved catalog and opens configuration without executing', () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(<TaskSwitcher tasks={tasks} preferences={emptyTaskPreferences()} onSelect={onSelect} onClose={onClose} />);
  const dialog = screen.getByRole('dialog', { name: 'Find a task' });
  expect(within(dialog).getByRole('searchbox', { name: 'Search tasks and CLIs' })).toHaveFocus();
  expect(within(dialog).getByText(/nothing runs automatically/)).toBeInTheDocument();
  expect(within(dialog).getByText('Sign-in required')).toBeInTheDocument();
  expect(within(dialog).getByText('Destructive · approval required')).toBeInTheDocument();

  fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'conjur variable' } });
  expect(within(dialog).getByRole('button', { name: /List variables/ })).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: /Remove container/ })).not.toBeInTheDocument();

  fireEvent.submit(within(dialog).getByRole('searchbox').closest('form')!);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('conjur/list');
  expect(onClose).not.toHaveBeenCalled();
});

test('preserves favorite-first ordering and closes through native dialog semantics', () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  render(<TaskSwitcher tasks={tasks} preferences={{
    favorites: [{ packId: 'github', commandId: 'status' }],
    recent: [{ packId: 'conjur', commandId: 'list' }, { packId: 'github', commandId: 'status' }],
  }} onSelect={onSelect} onClose={onClose} />);
  const dialog = screen.getByRole('dialog', { name: 'Find a task' });
  const results = within(dialog).getAllByRole('button').filter((button) => button.classList.contains('task-switcher-item'));
  expect(results[0]).toHaveTextContent('Repository status');
  expect(results[0]).toHaveTextContent('Favorite');
  fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'absent tool' } });
  expect(within(dialog).getByText('No tasks found')).toBeInTheDocument();
  expect(within(dialog).getByText('No matching tasks')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close task search' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();
});

test('never fabricates results when the approved catalog is empty', () => {
  const onSelect = vi.fn();
  render(<TaskSwitcher tasks={[]} preferences={emptyTaskPreferences()} onSelect={onSelect} onClose={() => {}} />);
  const dialog = screen.getByRole('dialog', { name: 'Find a task' });
  expect(within(dialog).getByText('No tasks found')).toBeInTheDocument();
  fireEvent.submit(within(dialog).getByRole('searchbox').closest('form')!);
  expect(onSelect).not.toHaveBeenCalled();
});
