import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { Task } from '../../api/tasks';
import { installFakeBackend } from '../../test/fakeBackend';
import { ConjurRenameSecret } from './ConjurRenameSecret';
import type { RenameResult } from './secretRenameApi';

const tasks: Task[] = ['secret-create-owned', 'secret-annotate-owned', 'secret-permit', 'secret-set-value', 'secret-delete'].map((commandId) => ({
  packId: 'cyberark-conjur-v9', toolId: 'conjur', packName: 'Conjur', commandId, name: commandId,
  risk: commandId === 'secret-delete' ? 'destructive' : 'change', requiresAuth: true, inputs: [],
}));
const response = (status: RenameResult['status']): RenameResult => ({
  status, source: 'apps/old', destination: 'apps/new',
  owner: 'acct:group:owners', policy: 'acct:policy:apps', grants: 2, annotations: 1, runIds: [],
  versions: [{ source: 7, destination: status === 'reviewed' ? 0 : 1 }, { source: 9, destination: status === 'reviewed' ? 0 : 2 }],
  ...(status === 'reviewed' || status === 'copied' ? { approvalId: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' } : {}),
});

function open() {
  const view = render(<ConjurRenameSecret tasks={tasks} csrfToken="csrf" account="acct" endpoint="https://conjur.example.test" />);
  fireEvent.click(screen.getByRole('button', { name: /Rename secret/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Original variable ID' }), { target: { value: 'apps/old' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'New variable ID' }), { target: { value: 'apps/new' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /I authorize backend reads/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review rename' }));
  return view;
}

test('requires a separate typed delete after verified historical copy and shows the mapping', async () => {
  const backend = installFakeBackend({
    'POST /api/v1/conjur/secrets/rename/review': { body: response('reviewed') },
    'POST /api/v1/conjur/secrets/rename/copy': { body: response('copied') },
    'POST /api/v1/conjur/secrets/rename/delete': { body: response('deleted') },
  });
  open();
  await screen.findByRole('heading', { name: 'Review secret rename' });
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Review secret rename' })).toHaveFocus());
  expect(screen.getByRole('button', { name: 'Copy and verify all versions' })).toBeDisabled();
  expect(backend.calls('POST /api/v1/conjur/secrets/rename/copy')).toHaveLength(0);
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve copying/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy and verify all versions' }));
  await screen.findByRole('heading', { name: 'Copy verified; original retained' });
  expect(screen.getByRole('list', { name: 'Version mapping' })).toHaveTextContent('Original version 7 → new version 1');
  const deleteButton = screen.getByRole('button', { name: 'Delete original after verification' });
  expect(deleteButton).toBeDisabled();
  expect(backend.calls('POST /api/v1/conjur/secrets/rename/delete')).toHaveLength(0);
  fireEvent.change(screen.getByRole('textbox', { name: 'Type DELETE: apps/old' }), { target: { value: 'DELETE: apps/new' } });
  expect(deleteButton).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Type DELETE: apps/old' }), { target: { value: 'DELETE: apps/old' } });
  fireEvent.click(deleteButton);
  await screen.findByRole('heading', { name: 'Rename completed' });
  expect(backend.bodies('POST /api/v1/conjur/secrets/rename/delete')[0]).toMatchObject({
    destination: 'apps/new', approvalId: 'a'.repeat(64), confirmation: 'DELETE: apps/old',
    target: { account: 'acct', applianceUrl: 'https://conjur.example.test', variableId: 'apps/old' },
  });
  expect(document.querySelector('input[type="password"]')).toBeNull();
});

test('a verification failure never offers deletion or retries the copy', async () => {
  const failed = { ...response('stopped'), failureCode: 'verification_failed' };
  const backend = installFakeBackend({
    'POST /api/v1/conjur/secrets/rename/review': { body: response('reviewed') },
    'POST /api/v1/conjur/secrets/rename/copy': { body: failed },
  });
  open();
  fireEvent.click(await screen.findByRole('checkbox', { name: /I approve copying/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy and verify all versions' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Deletion is blocked');
  expect(screen.queryByRole('button', { name: 'Delete original after verification' })).toBeNull();
  expect(backend.calls('POST /api/v1/conjur/secrets/rename/copy')).toHaveLength(1);
});

test('an operator can keep both without issuing a destructive request', async () => {
  const backend = installFakeBackend({
    'POST /api/v1/conjur/secrets/rename/review': { body: response('reviewed') },
    'POST /api/v1/conjur/secrets/rename/copy': { body: response('copied') },
    'POST /api/v1/conjur/secrets/rename/discard': { body: { ...response('discarded'), versions: [] } },
  });
  open();
  fireEvent.click(await screen.findByRole('checkbox', { name: /I approve copying/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy and verify all versions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Keep both; discard deletion approval' }));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Copy verified; original retained' })).toBeNull());
  expect(backend.calls('POST /api/v1/conjur/secrets/rename/discard')).toHaveLength(1);
  expect(backend.calls('POST /api/v1/conjur/secrets/rename/delete')).toHaveLength(0);
});

test('malformed copy evidence cannot enable cutover', async () => {
  installFakeBackend({
    'POST /api/v1/conjur/secrets/rename/review': { body: response('reviewed') },
    'POST /api/v1/conjur/secrets/rename/copy': { body: { ...response('copied'), versions: [{ source: 7, destination: 0 }] } },
  });
  open();
  fireEvent.click(await screen.findByRole('checkbox', { name: /I approve copying/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy and verify all versions' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Outcome may be unknown');
  expect(screen.queryByRole('button', { name: 'Delete original after verification' })).toBeNull();
});
