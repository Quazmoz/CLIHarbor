import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Task } from '../../api/tasks';
import { ConjurMigrationWorkbench, generateConjurPolicyDraft, type MigrationDraft } from './ConjurMigrationWorkbench';

const draft: MigrationDraft = {
  kind: 'variable-grant', branch: 'apps/myapp', variableId: 'db/password',
  roleKind: 'group', roleId: '/operators', privileges: 'read, execute',
};

const task = (id: string, risk: Task['risk'] = 'read', packId = 'cyberark-conjur-v9'): Task => ({
  packId, packName: 'Conjur', toolId: 'conjur', commandId: id,
  name: id, risk, inputs: [],
});

afterEach(() => vi.unstubAllGlobals());

test('generates only fixed reviewed variable and permit YAML with quoted identifiers', () => {
  expect(generateConjurPolicyDraft(draft)).toBe(
    '- !variable\n  id: "db/password"\n- !permit\n  role: !group "/operators"\n  privileges: [ read, execute ]\n  resource: !variable "db/password"\n',
  );
  expect(generateConjurPolicyDraft({ ...draft, kind: 'variable' })).toBe(
    '- !variable\n  id: "db/password"\n',
  );
  expect(generateConjurPolicyDraft({ ...draft, kind: 'grant' })).toBe(
    '- !permit\n  role: !group "/operators"\n  privileges: [ read, execute ]\n  resource: !variable "db/password"\n',
  );
});

test('rejects policy injection, multiline IDs, malformed branch and unapproved privilege values', () => {
  for (const malicious of ['db/password\n- !delete', 'db/../password', '-delete', 'db/#comment', '', 'a'.repeat(2049)]) {
    expect(generateConjurPolicyDraft({ ...draft, variableId: malicious })).toBeNull();
  }
  expect(generateConjurPolicyDraft({ ...draft, branch: 'apps\nroot' })).toBeNull();
  expect(generateConjurPolicyDraft({ ...draft, roleId: '/../../admins' })).toBeNull();
  expect(generateConjurPolicyDraft({ ...draft, privileges: 'admin' as MigrationDraft['privileges'] })).toBeNull();
  expect(generateConjurPolicyDraft({ ...draft, roleKind: 'admin' as MigrationDraft['roleKind'] })).toBeNull();
  expect(generateConjurPolicyDraft({ ...draft, kind: 'unknown' as MigrationDraft['kind'] })).toBeNull();
});

test('only opens matching backend-advertised tasks and never directly creates a run', () => {
  const onOpenTask = vi.fn();
  render(<ConjurMigrationWorkbench
    packId="cyberark-conjur-v9" toolId="conjur"
    tasks={[task('whoami'), task('secret-create', 'change'), task('secret-permit', 'change'),
      task('list-variables', 'read', 'spoof-pack'), task('secret-set-value', 'read')]}
    onOpenTask={onOpenTask}
  />);
  const planning = screen.getByRole('region', { name: 'Conjur migration planning' });
  fireEvent.click(within(planning).getByRole('button', { name: 'Verify identity' }));
  expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('cyberark-conjur-v9/whoami', undefined);
  expect(within(planning).getByRole('button', { name: 'Variable IDs · unavailable' })).toBeDisabled();
  expect(within(planning).getByRole('button', { name: 'Set value separately · unavailable' })).toBeDisabled();
  expect(within(planning).getByRole('button', { name: 'Create variable declaration · approval required' })).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Variable ID (relative to branch)' }),
    { target: { value: 'db/password' } });
  fireEvent.change(screen.getByRole('textbox', { name: /Role ID/ }),
    { target: { value: '/operators' } });
  expect(within(planning).getByRole('button', { name: 'Review access grant · approval required' })).toBeEnabled();
  expect(onOpenTask).toHaveBeenCalledTimes(1);
});

test('prefills approved create and permit workbench tasks, but never starts a mutation', () => {
  const onOpenTask = vi.fn();
  render(<ConjurMigrationWorkbench
    packId="cyberark-conjur-v9" toolId="conjur"
    tasks={[task('secret-create', 'change'), task('secret-permit', 'change')]}
    onOpenTask={onOpenTask}
  />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Policy branch' }), { target: { value: 'apps/prod' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Variable ID (relative to branch)' }), { target: { value: 'db/password' } });
  fireEvent.change(screen.getByRole('textbox', { name: /Role ID/ }), { target: { value: '/operators' } });
  expect(screen.getByRole('textbox', { name: 'Review-only policy YAML' })).toHaveValue(
    '- !variable\n  id: "db/password"\n- !permit\n  role: !group "/operators"\n  privileges: [ read, execute ]\n  resource: !variable "db/password"\n',
  );

  fireEvent.click(screen.getByRole('button', { name: 'Review variable creation · approval required' }));
  expect(onOpenTask).toHaveBeenLastCalledWith('cyberark-conjur-v9/secret-create',
    { 'policy-branch': 'apps/prod', 'variable-id': 'db/password' });
  fireEvent.click(screen.getByRole('button', { name: 'Review access grant · approval required' }));
  expect(onOpenTask).toHaveBeenLastCalledWith('cyberark-conjur-v9/secret-permit', {
    'policy-branch': 'apps/prod', 'variable-id': 'db/password',
    'role-kind': 'group', 'role-id': '/operators', privileges: 'read, execute',
  });
  expect(onOpenTask).toHaveBeenCalledTimes(2);
});

test('invalid policy input hides preview and approved action buttons', () => {
  render(<ConjurMigrationWorkbench
    packId="cyberark-conjur-v9" toolId="conjur"
    tasks={[task('secret-create', 'change'), task('secret-permit', 'change')]}
    onOpenTask={vi.fn()}
  />);
  expect(screen.queryByRole('button', { name: 'Copy policy draft' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Variable ID (relative to branch)' }),
    { target: { value: '- !delete' } });
  expect(screen.getByRole('alert')).toHaveTextContent('No draft can be generated yet');
  expect(screen.queryByRole('button', { name: 'Review variable creation · approval required' })).not.toBeInTheDocument();
});
