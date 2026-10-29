import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from './App';
import { bootRoutes, installFakeBackend } from './test/fakeBackend';

const first = 'a'.repeat(32);
const second = 'b'.repeat(32);
const task = { packId: 'example', packName: 'Example', commandId: 'inspect', toolId: 'example',
  name: 'Inspect example', risk: 'read', inputs: [] };
const summary = (runId: string) => ({ runId, packId: task.packId, commandId: task.commandId,
  toolId: task.toolId, status: 'exited', exitCode: 0 });
const snapshot = (runId: string) => ({ ...summary(runId), events: [{ sequence: 1, type: 'stdout.chunk',
  timestamp: '', dataBase64: btoa('Output for ' + runId) }] });

function backend() {
  return installFakeBackend({
    ...bootRoutes({ tasks: [task], runs: [summary(first), summary(second)] }),
    '/api/v1/platforms': { body: { platforms: [] } },
    ['/api/v1/runs/' + first]: { body: snapshot(first) },
    ['/api/v1/runs/' + second]: { body: snapshot(second) },
  });
}

test('activity and retained-run selections write exact URLs, and Back/Forward restore the right evidence', async () => {
  window.history.replaceState({}, '', '/tools');
  const api = backend();
  render(<App />);
  await screen.findByText('Activity');
  const activity = screen.getByLabelText(/^Operation activity,/);
  fireEvent.click(activity);
  fireEvent.click(within(activity.closest('details')!).getAllByRole('link', { name: 'Details' })[0]);
  expect(await screen.findByText('Output for ' + first)).toBeInTheDocument();
  expect(window.location.pathname + window.location.search).toBe('/runs?run=' + first);

  fireEvent.click(screen.getAllByRole('button', { name: /^Inspect example/ })[1]);
  expect(await screen.findByText('Output for ' + second)).toBeInTheDocument();
  expect(window.location.search).toBe('?run=' + second);

  act(() => window.history.back());
  await waitFor(() => expect(window.location.search).toBe('?run=' + first));
  expect(await screen.findByText('Output for ' + first)).toBeInTheDocument();
  expect(screen.queryByText('Output for ' + second)).not.toBeInTheDocument();
  act(() => window.history.forward());
  await waitFor(() => expect(window.location.search).toBe('?run=' + second));
  expect(await screen.findByText('Output for ' + second)).toBeInTheDocument();
  expect(api.calls('POST /api/v1/runs')).toHaveLength(0);
});

test('Back clears abandoned run evidence before its delayed response can arrive', async () => {
  window.history.replaceState({}, '', '/runs');
  const api = backend();
  let finish!: (value: { body: ReturnType<typeof snapshot> }) => void;
  api.on({ ['/api/v1/runs/' + first]: () => new Promise((resolve) => { finish = resolve; }) });
  render(<App />);
  fireEvent.click((await screen.findAllByRole('button', { name: /^Inspect example/ }))[0]);
  await waitFor(() => expect(api.calls('/api/v1/runs/' + first)).toHaveLength(1));
  act(() => window.history.back());
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/runs'));
  await act(async () => finish({ body: snapshot(first) }));
  expect(screen.queryByText('Output for ' + first)).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /^Inspect example/ })[0]).toHaveAttribute('aria-pressed', 'false');
});

test.each(['?run=invalid', '?run=' + first + '&run=' + second])('ambiguous or invalid history links do not fetch a run: %s', async (query) => {
  window.history.replaceState({}, '', '/runs' + query);
  const api = backend();
  render(<App />);
  await screen.findAllByRole('button', { name: /^Inspect example/ });
  expect(api.calls('/api/v1/runs/' + first)).toHaveLength(0);
  expect(api.calls('/api/v1/runs/' + second)).toHaveLength(0);
});

test('a direct run link keeps its evidence visible when the metadata list is unavailable', async () => {
  window.history.replaceState({}, '', '/runs?run=' + first);
  const api = backend();
  api.on({ '/api/v1/runs': { status: 500, body: {} } });
  render(<App />);
  expect(await screen.findByText('Output for ' + first)).toBeInTheDocument();
  expect(screen.getByText(first)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh run' })).toBeEnabled();
});
