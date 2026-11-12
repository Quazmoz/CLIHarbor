import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createRun, previewRun, type RunPreview, type RunSnapshot } from '../../api/runs';
import type { Task } from '../../api/tasks';
import { OperationActivityProvider } from '../../OperationActivity';
import { installFakeBackend, type RouteReply } from '../../test/fakeBackend';
import { ConjurSecretVersions } from './ConjurSecretVersions';

vi.mock('../../api/runs', async (original) => ({ ...(await original<typeof import('../../api/runs')>()), createRun: vi.fn(), previewRun: vi.fn() }));
const PACK = 'cyberark-conjur-v9';
const SECRET_MARKER = 'previous-fixture-value';
const SECRET = '  ' + SECRET_MARKER + '\r\ncertificate-line\n尾  ';
const fullID = 'acct:variable:apps/db';
const tasks: Task[] = [{ packId: PACK, packName: 'Conjur', commandId: 'secret-set-value', name: 'Set value', toolId: 'conjur', risk: 'change', requiresAuth: true,
  inputs: [{ id: 'variable-id', label: 'ID', type: 'string', required: true }, { id: 'value', label: 'Value', type: 'secret', required: true }],
  impact: { targetInput: 'variable-id', targetLabel: 'Variable', effect: 'Stores a new version', scope: 'single' } }];
const props = { packId: PACK, toolId: 'conjur', csrfToken: 'csrf', account: 'acct', endpoint: 'https://conjur.example.test', available: true, active: true, tasks };
const preview = (): RunPreview => ({ packId: PACK, commandId: 'secret-set-value', toolId: 'conjur', executableName: 'conjur',
  args: ['variable', 'set', '--id', fullID, '--file', '-'], risk: 'change',
  impact: { target: fullID, targetLabel: 'Variable', effect: 'Stores a new secret version', scope: 'single' },
  context: { fields: [{ label: 'Account', value: props.account }, { label: 'Endpoint', value: props.endpoint }] },
  approval: { id: 'b'.repeat(32), mode: 'explicit', expiresAt: '2099-01-01T00:00:00Z' } });
const completed: RunSnapshot = { runId: 'a'.repeat(32), packId: PACK, commandId: 'secret-set-value', toolId: 'conjur', status: 'exited', exitCode: 0 };
let backend: ReturnType<typeof installFakeBackend>;

beforeEach(() => {
  backend = installFakeBackend({
    '/api/v1/conjur/secrets/access-log': { body: { entries: [] } },
    'POST /api/v1/conjur/secrets/versions': { body: { variableId: 'apps/db', versions: [{ version: 3 }, { version: 2 }, { version: 1 }] } },
    'POST /api/v1/conjur/secrets/reveal': { body: { variableId: 'apps/db', version: 2, value: SECRET } },
  });
  vi.mocked(previewRun).mockImplementation(async (_, request) => ({ ...preview(),
    args: ['variable', 'set', '--id', String(request.values['variable-id']), '--file', '-'],
    impact: { ...preview().impact!, target: String(request.values['variable-id']) } }));
  vi.mocked(createRun).mockResolvedValue(completed);
});
afterEach(() => vi.resetAllMocks());

async function selectPrevious(variableId = 'apps/db') {
  fireEvent.click(screen.getByRole('button', { name: /View secret versions/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Variable ID' }), { target: { value: variableId } });
  fireEvent.click(screen.getByRole('button', { name: 'List versions' }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Version' }), { target: { value: '2' } });
}
async function review() {
  await selectPrevious();
  fireEvent.click(screen.getByRole('checkbox', { name: /I need this value now/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review restore of version 2' }));
  return screen.findByRole('heading', { name: 'Approve restoring version 2' });
}
function approve() {
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve restoring version 2/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Restore version 2' }));
}

test('restores the exact previous value only after read consent, matching preview and separate approval', async () => {
  let finish!: (run: RunSnapshot) => void;
  vi.mocked(createRun).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<StrictMode><OperationActivityProvider><ConjurSecretVersions {...props} /></OperationActivityProvider></StrictMode>);
  await selectPrevious();
  expect(screen.getByRole('button', { name: 'Review restore of version 2' })).toBeDisabled();
  expect(backend.calls('POST /api/v1/conjur/secrets/reveal')).toHaveLength(0);
  fireEvent.click(screen.getByRole('checkbox', { name: /I need this value now/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review restore of version 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review restore of version 2' }));
  expect(await screen.findByRole('heading', { name: 'Approve restoring version 2' })).toHaveFocus();
  expect(backend.calls('POST /api/v1/conjur/secrets/reveal')).toHaveLength(1);
  expect(backend.bodies('POST /api/v1/conjur/secrets/reveal')).toEqual([{ packId: PACK, toolId: 'conjur', account: props.account,
    applianceUrl: props.endpoint, variableId: 'apps/db', version: 2 }]);
  expect(vi.mocked(previewRun)).toHaveBeenCalledExactlyOnceWith('csrf', { packId: PACK, commandId: 'secret-set-value', values: { 'variable-id': fullID, value: SECRET } });
  expect(createRun).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(SECRET_MARKER);
  expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Secret value' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Restore version 2' })).toBeDisabled();
  approve();
  expect(createRun).toHaveBeenCalledExactlyOnceWith('csrf', { packId: PACK, commandId: 'secret-set-value', values: { 'variable-id': fullID, value: SECRET }, approval: { id: 'b'.repeat(32) } });
  expect(screen.queryByRole('button', { name: 'Restore version 2' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review restore of version 2' })).toBeDisabled();
  await act(async () => finish(completed));
  await screen.findByText(/Restore command completed/);
  expect(document.body.textContent).not.toContain(SECRET_MARKER);
});

test.each<[string, Partial<RunPreview>]>([
  ['different variable', { impact: { ...preview().impact!, target: 'acct:variable:other' } }],
  ['different account', { context: { fields: [{ label: 'Account', value: 'other' }, { label: 'Endpoint', value: props.endpoint }] } }],
  ['different command', { commandId: 'secret-delete' }],
  ['different pack', { packId: 'other' }],
  ['missing approval', { approval: undefined }],
  ['wrong approval mode', { approval: { ...preview().approval!, mode: 'typed' as const } }],
  ['echoed stdin', { stdin: SECRET }],
  ['expired approval', { approval: { ...preview().approval!, expiresAt: '2000-01-01T00:00:00Z' } }],
])('refuses a preview with %s', async (_name, changes) => {
  vi.mocked(previewRun).mockResolvedValue({ ...preview(), ...changes });
  render(<ConjurSecretVersions {...props} />);
  await selectPrevious();
  fireEvent.click(screen.getByRole('checkbox', { name: /I need this value now/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review restore of version 2' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Restore version 2' })).not.toBeInTheDocument();
  expect(createRun).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(SECRET_MARKER);
});

test('a denied retained version never prepares or starts a write', async () => {
  backend.on({ 'POST /api/v1/conjur/secrets/reveal': { body: { variableId: 'apps/db', version: 2, failureCode: 'forbidden' } } });
  render(<ConjurSecretVersions {...props} />);
  await selectPrevious();
  fireEvent.click(screen.getByRole('checkbox', { name: /I need this value now/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review restore of version 2' }));
  await screen.findByRole('alert');
  expect(previewRun).not.toHaveBeenCalled();
  expect(createRun).not.toHaveBeenCalled();
});

test.each(['hidden', 'selection', 'target', 'tab', 'readiness', 'cancel', 'read consent', 'timeout'] as const)('discards the review on %s without a write', async (reason) => {
  if (reason === 'timeout') vi.useFakeTimers({ shouldAdvanceTime: true });
  const view = render(<ConjurSecretVersions {...props} />);
  await review();
  if (reason === 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    Reflect.deleteProperty(document, 'visibilityState');
  } else if (reason === 'selection') fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '1' } });
  else if (reason === 'target') view.rerender(<ConjurSecretVersions {...props} account="other" />);
  else if (reason === 'tab') view.rerender(<ConjurSecretVersions {...props} active={false} />);
  else if (reason === 'readiness') view.rerender(<ConjurSecretVersions {...props} available={false} />);
  else if (reason === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel restore review' }));
  else if (reason === 'read consent') fireEvent.click(screen.getByRole('checkbox', { name: /I need this value now/ }));
  else {
    await act(async () => { vi.advanceTimersByTime(60_001); });
    vi.useRealTimers();
  }
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Approve restoring version 2' })).not.toBeInTheDocument());
  expect(createRun).not.toHaveBeenCalled();
});

test('an abandoned read cannot prepare a write after the selected variable changes', async () => {
  let finish!: (reply: RouteReply) => void;
  backend.on({ 'POST /api/v1/conjur/secrets/reveal': () => new Promise((resolve) => { finish = resolve; }) });
  render(<ConjurSecretVersions {...props} />);
  await selectPrevious();
  fireEvent.click(screen.getByRole('checkbox', { name: /I need this value now/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review restore of version 2' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Variable ID' }), { target: { value: 'other' } });
  await act(async () => finish({ body: { variableId: 'apps/db', version: 2, value: SECRET } }));
  expect(previewRun).not.toHaveBeenCalled();
  expect(createRun).not.toHaveBeenCalled();
});

test('a lost write acknowledgement is unconfirmed and is never automatically replayed', async () => {
  vi.mocked(createRun).mockRejectedValue(new TypeError('connection lost ' + SECRET));
  render(<ConjurSecretVersions {...props} />);
  await review(); approve();
  await screen.findByText(/Restore is unconfirmed/);
  expect(createRun).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Restore version 2' })).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain(SECRET_MARKER);
});

test('only a historical version and an approved write task offer restore', async () => {
  const view = render(<ConjurSecretVersions {...props} />);
  await selectPrevious();
  fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '3' } });
  expect(screen.queryByRole('button', { name: /Review restore/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '2' } });
  view.rerender(<ConjurSecretVersions {...props} tasks={[]} />);
  expect(screen.queryByRole('button', { name: /Review restore/ })).not.toBeInTheDocument();
  expect(backend.calls('POST /api/v1/conjur/secrets/reveal')).toHaveLength(0);
});

test('fully qualifies colon-containing IDs identically for the read and approved write', async () => {
  const variableId = 'acct:variable:literal-name';
  const qualified = 'acct:variable:' + variableId;
  backend.on({
    'POST /api/v1/conjur/secrets/versions': { body: { variableId, versions: [{ version: 3 }, { version: 2 }] } },
    'POST /api/v1/conjur/secrets/reveal': { body: { variableId, version: 2, value: SECRET } },
  });
  render(<ConjurSecretVersions {...props} />);
  await selectPrevious(variableId);
  fireEvent.click(screen.getByRole('checkbox', { name: /I need this value now/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review restore of version 2' }));
  await screen.findByRole('heading', { name: 'Approve restoring version 2' });
  approve();
  await screen.findByText(/Restore command completed/);
  expect(vi.mocked(createRun).mock.calls[0][1].values).toEqual({ 'variable-id': qualified, value: SECRET });
});

test('a value refused by the existing write validator is never truncated or executed', async () => {
  const oversized = SECRET + 'x'.repeat(4096);
  backend.on({ 'POST /api/v1/conjur/secrets/reveal': { body: { variableId: 'apps/db', version: 2, value: oversized } } });
  vi.mocked(previewRun).mockRejectedValue(new Error('validator refused ' + SECRET));
  render(<ConjurSecretVersions {...props} />);
  await selectPrevious();
  fireEvent.click(screen.getByRole('checkbox', { name: /I need this value now/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review restore of version 2' }));
  await screen.findByRole('alert');
  expect(vi.mocked(previewRun).mock.calls[0][1].values.value).toBe(oversized);
  expect(createRun).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(SECRET_MARKER);
});

test('a restore already submitted stays locked across unmount and remount until it settles', async () => {
  let finish!: (run: RunSnapshot) => void;
  vi.mocked(createRun).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const view = render(<OperationActivityProvider><ConjurSecretVersions key="first" {...props} /></OperationActivityProvider>);
  await review(); approve();
  view.rerender(<OperationActivityProvider><ConjurSecretVersions key="second" {...props} /></OperationActivityProvider>);
  expect(screen.getByRole('button', { name: /View secret versions/ })).toBeDisabled();
  await act(async () => finish(completed));
  await waitFor(() => expect(screen.getByRole('button', { name: /View secret versions/ })).toBeEnabled());
  expect(createRun).toHaveBeenCalledTimes(1);
});

test('a late preview cannot resurrect an expired source value', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let finish!: (plan: RunPreview) => void;
  vi.mocked(previewRun).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<ConjurSecretVersions {...props} />);
  await selectPrevious();
  fireEvent.click(screen.getByRole('checkbox', { name: /I need this value now/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review restore of version 2' }));
  await waitFor(() => expect(previewRun).toHaveBeenCalledTimes(1));
  await act(async () => { vi.advanceTimersByTime(60_001); finish(preview()); });
  expect(screen.queryByRole('heading', { name: 'Approve restoring version 2' })).not.toBeInTheDocument();
  expect(createRun).not.toHaveBeenCalled();
});
