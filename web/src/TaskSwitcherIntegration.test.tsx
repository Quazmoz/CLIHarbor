import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './App';

const showModalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function requestPath(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
}

const approvedTasks = [
  { packId: 'fixture', packName: 'Fixture CLI', toolId: 'fixture', commandId: 'inspect',
    name: 'Inspect fixture', risk: 'read', inputs: [{ id: 'query', type: 'string', label: 'Query', required: true }] },
  { packId: 'cyberark-conjur-v9', packName: 'CyberArk Conjur', toolId: 'conjur', commandId: 'list',
    name: 'List variables', risk: 'read', requiresAuth: true, inputs: [] },
];

function mockRuntime(tasks: unknown[] = approvedTasks) {
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const path = requestPath(input);
    requested.push(path);
    if (path === '/api/v1/status') return Promise.resolve(response(200, { name: 'CLIHarbor', version: 'test', session: 'active', csrfToken: 'test-csrf' }));
    if (path === '/api/v1/tasks') return Promise.resolve(response(200, { tasks }));
    if (path === '/api/v1/tools') return Promise.resolve(response(200, { tools: [] }));
    if (path === '/api/v1/platforms') return Promise.resolve(response(200, { platforms: [] }));
    return Promise.resolve(response(404, {}));
  }));
  return requested;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/tools');
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
  cleanup();
  if (showModalDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModalDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  if (closeDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'close', closeDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

test('Ctrl+K opens search across CLIs and selects an existing task without executing', async () => {
  const requests = mockRuntime();
  render(<App />);
  const trigger = await screen.findByRole('button', { name: /Find task/ });
  expect(trigger).toBeEnabled();

  // Exercise the header trigger first; then confirm the keyboard shortcut
  // on the already-mounted application after the first navigation.
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Find a task' });
  const search = within(dialog).getByRole('searchbox', { name: 'Search tasks and CLIs' });
  expect(search).toHaveFocus();
  fireEvent.change(search, { target: { value: 'conjur list' } });
  expect(within(dialog).getByText('Sign-in required')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: /List variables/ }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Find a task' })).not.toBeInTheDocument());
  expect(window.location.pathname).toBe('/tasks');
  expect(screen.getByRole('heading', { name: 'List variables', level: 3 })).toBeInTheDocument();
  expect(requests.some((path) => path === '/api/v1/runs' || path === '/api/v1/runs/preview')).toBe(false);
  fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
  expect(await screen.findByRole('dialog', { name: 'Find a task' })).toBeInTheDocument();
});

test('search shortcut does not hijack typing and native dismiss leaves the route unchanged', async () => {
  mockRuntime();
  render(<App />);
  const trigger = await screen.findByRole('button', { name: /Find task/ });
  const input = await screen.findByRole('searchbox', { name: /Find a CLI/ });
  fireEvent.keyDown(input, { key: 'k', metaKey: true });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Find a task' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close task search' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(window.location.pathname).toBe('/tools');
});

test('no approved tasks means no quick switcher or shortcut target', async () => {
  mockRuntime([]);
  render(<App />);
  const trigger = await screen.findByRole('button', { name: /Find task/ });
  expect(trigger).toBeDisabled();
  fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
