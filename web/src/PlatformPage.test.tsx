import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { PlatformPage } from './PlatformPage';
import type { Task } from './api/tasks';
import type { Platform } from './api/platforms';

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
