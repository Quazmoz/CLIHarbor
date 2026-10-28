import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RunsPage } from './RunsPage';
import type { Task } from './api/tasks';
import { installFakeBackend, type RouteReply } from './test/fakeBackend';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

const tasks: Task[] = [
  {
    packId: 'fixture',
    packName: 'Fixture Pack',
    commandId: 'inspect',
    name: 'Inspect resources',
    toolId: 'fixture',
    risk: 'read',
    toolVersion: '1.2.3',
    inputs: [],
  },
  {
    packId: 'fixture',
    packName: 'Fixture Pack',
    commandId: 'older',
    name: 'Older task',
    toolId: 'fixture',
    risk: 'read',
    inputs: [],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RunsPage', () => {
  test('combines metadata search, CLI scope and outcome filters without fetching or losing selected evidence', async () => {
    const summaries = [
      { runId: 'a'.repeat(32), packId: 'fixture', commandId: 'inspect', toolId: 'fixture', status: 'exited', exitCode: 0, toolVersion: '1.2.3' },
      { runId: 'b'.repeat(32), packId: 'fixture', commandId: 'older', toolId: 'fixture', status: 'exited', exitCode: 7 },
      { runId: 'c'.repeat(32), packId: 'other', commandId: 'inspect', toolId: 'fixture', status: 'failed' },
    ];
    const backend = installFakeBackend({
      '/api/v1/runs': { body: { runs: summaries } },
      ['/api/v1/runs/' + summaries[0].runId]: { body: { ...summaries[0], events: [
        { sequence: 1, type: 'stdout.chunk', timestamp: '2026-10-28T10:00:00Z', dataBase64: btoa('retained-output-sentinel') },
      ] } },
    });
    render(<RunsPage tasks={tasks} requestedRun={{ runId: summaries[0].runId }} />);
    await screen.findByText('retained-output-sentinel');
    const listNames = () => Array.from(document.querySelectorAll('.run-history-entry strong')).map((element) => element.textContent);
    expect(listNames()).toEqual(['Inspect resources', 'Older task', 'inspect']);
    const search = screen.getByRole('searchbox', { name: 'Search runs' });
    fireEvent.change(search, { target: { value: 'INSPECT 1.2.3 SUCCEEDED' } });
    expect(listNames()).toEqual(['Inspect resources']);
    fireEvent.change(search, { target: { value: summaries[1].runId.slice(0, 10) } });
    expect(listNames()).toEqual(['Older task']);
    fireEvent.change(search, { target: { value: 'retained-output-sentinel' } });
    expect(listNames()).toEqual([]);
    expect(screen.getByText(/No retained runs match these filters/)).toBeInTheDocument();
    expect(screen.getByText('retained-output-sentinel')).toBeInTheDocument();
    expect(screen.getByText('The selected run is outside the current list filters.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(search).toHaveFocus();
    fireEvent.change(screen.getByRole('combobox', { name: 'Outcome' }), { target: { value: 'failed' } });
    expect(listNames()).toEqual(['Older task', 'inspect']);
    fireEvent.change(screen.getByRole('combobox', { name: 'CLI' }), { target: { value: 'other/fixture' } });
    expect(listNames()).toEqual(['inspect']);
    fireEvent.change(search, { target: { value: 'fixture' } });
    expect(screen.getByText('1 of 3 runs')).toHaveAttribute('role', 'status');
    expect(backend.calls('/api/v1/runs')).toHaveLength(1);
    expect(backend.calls('/api/v1/runs/' + summaries[0].runId)).toHaveLength(1);
    expect(backend.requests).toHaveLength(2);
  });

  test('classifies terminal outcomes separately and preserves filters across refresh and eviction', async () => {
    const summaries = [
      { status: 'exited', exitCode: 0 }, { status: 'exited', exitCode: 1 },
      { status: 'failed' }, { status: 'cancelled' }, { status: 'timed-out' }, { status: 'running' },
    ].map((outcome, index) => ({
      ...outcome, runId: (index + 1).toString().repeat(32), packId: 'fixture', commandId: 'inspect', toolId: 'fixture',
    }));
    const backend = installFakeBackend({ '/api/v1/runs': { body: { runs: summaries } } });
    render(<RunsPage tasks={tasks} />);
    await screen.findByText('6 of 6 runs');
    for (const [outcome, count] of [['succeeded', 1], ['failed', 2], ['cancelled', 1], ['timed-out', 1], ['running', 1]] as const) {
      fireEvent.change(screen.getByRole('combobox', { name: 'Outcome' }), { target: { value: outcome } });
      expect(document.querySelectorAll('.run-history-entry')).toHaveLength(count);
    }
    fireEvent.change(screen.getByRole('combobox', { name: 'CLI' }), { target: { value: 'fixture/fixture' } });
    backend.on({ '/api/v1/runs': { body: { runs: [{ ...summaries[0], packId: 'other' }] } } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
    await screen.findByText('0 of 1 runs');
    expect(screen.getByRole('combobox', { name: 'CLI' })).toHaveValue('fixture/fixture');
    expect(screen.getByRole('combobox', { name: 'Outcome' })).toHaveValue('running');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('1 of 1 runs')).toBeInTheDocument();
    expect(document.querySelectorAll('.run-history-entry')).toHaveLength(1);
    expect(backend.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  test.each([
    { status: 'exited', exitCode: 7 },
    { status: 'cancelled' },
    { status: 'timed-out' },
    { status: 'failed' },
    { status: 'exited', exitCode: 0, structured: { status: 'invalid', renderer: 'cards', error: 'duplicate_key' } },
  ])('shows raw diagnostics immediately for unsuccessful or rejected results: %j', async (outcome) => {
    const runId = 'c'.repeat(32);
    const summary = { runId, packId: 'fixture', commandId: 'inspect', toolId: 'fixture', status: outcome.status, exitCode: outcome.exitCode };
    const stdout = '{"id":"first","id":"second"}';
    const stderr = '<img src=x onerror=alert(1)> inspect the target before retrying';
    const backend = installFakeBackend({
      '/api/v1/runs': { body: { runs: [summary] } },
      ['/api/v1/runs/' + runId]: { body: { ...summary, ...outcome, events: [
        { sequence: 1, type: 'stdout.chunk', timestamp: '2026-10-27T10:00:00Z', dataBase64: btoa(stdout) },
        { sequence: 2, type: 'stderr.chunk', timestamp: '2026-10-27T10:00:00Z', dataBase64: btoa(stderr) },
      ] } },
    });
    render(<RunsPage tasks={tasks} requestedRun={{ runId }} />);
    expect(await screen.findByText(stderr)).toBeInTheDocument();
    expect(screen.getByText(stdout)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('img')).toBeNull();
    expect(backend.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  test('clears previous evidence immediately when an activity link selects another run', async () => {
    const first = 'a'.repeat(32);
    const second = 'b'.repeat(32);
    const summaries = [first, second].map((runId, index) => ({
      runId, commandId: index === 0 ? 'inspect' : 'older', packId: 'fixture', toolId: 'fixture', status: 'exited', exitCode: 0,
    }));
    const snapshot = (index: number, text: string) => ({ ...summaries[index], events: [
      { sequence: 1, type: 'stdout.chunk', timestamp: '2026-10-05T10:00:00Z', dataBase64: btoa(text) },
    ] });
    let finishSecond!: (reply: RouteReply) => void;
    const secondResponse = new Promise<RouteReply>((resolve) => { finishSecond = resolve; });
    const backend = installFakeBackend({
      '/api/v1/runs': { body: { runs: summaries } },
      ['/api/v1/runs/' + first]: { body: snapshot(0, 'first run evidence') },
      ['/api/v1/runs/' + second]: () => secondResponse,
    });
    const view = render(<RunsPage tasks={tasks} requestedRun={{ runId: first }} />);
    await screen.findByText('first run evidence');
    view.rerender(<RunsPage tasks={tasks} requestedRun={{ runId: second }} />);
    expect(screen.getByText('Loading run evidence…')).toBeInTheDocument();
    expect(screen.queryByText('first run evidence')).not.toBeInTheDocument();
    await act(async () => finishSecond({ body: snapshot(1, 'second run evidence') }));
    expect(await screen.findByText('second run evidence')).toBeInTheDocument();
    view.rerender(<RunsPage tasks={tasks} requestedRun={{ runId: second }} />);
    expect(screen.getByText('second run evidence')).toBeInTheDocument();
    expect(backend.calls('/api/v1/runs/' + second)).toHaveLength(1);
  });

  test('opens the same activity link again after selecting a different run', async () => {
    const first = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const second = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const summaries = [first, second].map((runId, index) => ({
      runId, commandId: index === 0 ? 'inspect' : 'older', packId: 'fixture', toolId: 'fixture', status: 'exited', exitCode: 0,
    }));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      return Promise.resolve(response(200, path === '/api/v1/runs' ? { runs: summaries } : {
        ...summaries.find((run) => path.endsWith(run.runId)), events: [],
      }));
    }));
    const view = render(<RunsPage tasks={tasks} requestedRun={{ runId: first }} />);
    await waitFor(() => expect(document.querySelector('.run-history-id')).toHaveTextContent(first));
    fireEvent.click(screen.getByRole('button', { name: /Older task/i }));
    await waitFor(() => expect(document.querySelector('.run-history-id')).toHaveTextContent(second));
    view.rerender(<RunsPage tasks={tasks} requestedRun={{ runId: first }} />);
    await waitFor(() => expect(document.querySelector('.run-history-id')).toHaveTextContent(first));
  });

  test('keeps completed evidence readable through refresh failure and does not poll it for another active run', async () => {
    const completedID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    let intervalCallback: (() => void) | undefined;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 2000) {
        intervalCallback = callback as () => void;
        return -1;
      }
      // Keep Testing Library's own interval-based waitFor polling functional.
      return nativeSetInterval(callback, delay);
    }) as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation((id) => {
      if (id !== -1) nativeClearInterval(id);
    });
    let detailCalls = 0;
    const completed = { runId: completedID, commandId: 'inspect', packId: 'fixture', toolId: 'fixture', status: 'exited', exitCode: 0 };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (requestPath(input) === '/api/v1/runs') return Promise.resolve(response(200, { runs: [
        completed, { ...completed, runId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', commandId: 'older', status: 'running' },
      ] }));
      detailCalls += 1;
      if (detailCalls > 1) return Promise.reject(new TypeError('network unavailable'));
      return Promise.resolve(response(200, { ...completed, events: [
        { sequence: 1, type: 'stdout.chunk', timestamp: '2026-10-05T10:00:00Z', dataBase64: btoa('retained evidence') },
      ] }));
    }));
    render(<RunsPage tasks={tasks} />);
    fireEvent.click(await screen.findByRole('button', { name: /Inspect resources/i }));
    await screen.findByText('retained evidence');
    await act(async () => intervalCallback?.());
    expect(detailCalls).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh run' }));
    await screen.findByRole('alert');
    expect(screen.getByText('retained evidence')).toBeInTheDocument();
  });

  test('ignores a late detail response after selecting another run and keeps repeated selection usable', async () => {
    const first = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const second = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const summary = (runId: string, commandId: string) => ({ runId, commandId, packId: 'fixture', toolId: 'fixture', status: 'exited', exitCode: 0 });
    let resolveOld: (response: Response) => void = () => undefined;
    const oldRequest = new Promise<Response>((resolve) => { resolveOld = resolve; });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/runs') return Promise.resolve(response(200, { runs: [summary(first, 'inspect'), summary(second, 'older')] }));
      if (path.endsWith(first)) return oldRequest;
      return Promise.resolve(response(200, {
        ...summary(second, 'older'),
        events: [{ sequence: 1, type: 'stdout.chunk', timestamp: '2026-10-05T10:00:00Z', dataBase64: btoa('new result') }],
      }));
    }));
    render(<RunsPage tasks={tasks} />);
    fireEvent.click(await screen.findByRole('button', { name: /Inspect resources/i }));
    expect(screen.getByText('Loading run evidence…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Older task/i }));
    expect(await screen.findByText('new result')).toBeInTheDocument();
    await act(async () => resolveOld(response(200, {
      ...summary(first, 'inspect'),
      events: [{ sequence: 1, type: 'stdout.chunk', timestamp: '2026-10-05T10:00:00Z', dataBase64: btoa('old result') }],
    })));
    expect(screen.queryByText('old result')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Older task/i }));
    expect(screen.getByText('new result')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh run' })).toBeEnabled();
  });

  test('does not abort a slow background poll on each timer tick', async () => {
    let intervalCallback: (() => void) | undefined;
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 2000) {
        intervalCallback = callback as () => void;
        return -1;
      }
      // Keep Testing Library's own interval-based waitFor polling functional.
      return nativeSetInterval(callback, delay);
    }) as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation((id) => {
      if (id !== -1) nativeClearInterval(id);
    });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    let resolvePoll: (response: Response) => void = () => undefined;
    const slowPoll = new Promise<Response>((resolve) => { resolvePoll = resolve; });
    const summary = { runId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', packId: 'fixture', commandId: 'inspect', toolId: 'fixture' };
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200, { runs: [{ ...summary, status: 'running' }] })).mockReturnValue(slowPoll);
    vi.stubGlobal('fetch', fetchMock);
    render(<RunsPage tasks={tasks} />);
    await screen.findByText('Running', { selector: '.run-history-status' });
    await act(async () => intervalCallback?.());
    await act(async () => intervalCallback?.());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => resolvePoll(response(200, { runs: [{ ...summary, status: 'exited', exitCode: 0 }] })));
    expect(await screen.findByText('Succeeded', { selector: '.run-history-status' })).toBeInTheDocument();
  });

  test('renders metadata-only history and loads retained evidence only after explicit selection', async () => {
    const secretMarker = 'LIST_MUST_NOT_INCLUDE_THIS_OUTPUT';
    const hostile = '<img id="history-pwn" src=x onerror="document.body.dataset.pwned=1">';
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/runs') {
        return Promise.resolve(
          response(200, {
            runs: [
              {
                runId: '22222222222222222222222222222222',
                packId: 'fixture',
                commandId: 'inspect',
                toolId: 'fixture',
                toolVersion: '1.2.3',
                status: 'exited',
                startedAt: '2026-09-25T15:00:00Z',
                endedAt: '2026-09-25T15:00:01Z',
                exitCode: 0,
              },
              {
                runId: '11111111111111111111111111111111',
                packId: 'fixture',
                commandId: 'older',
                toolId: 'fixture',
                status: 'cancelled',
                startedAt: '2026-09-25T14:59:00Z',
                endedAt: '2026-09-25T14:59:01Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs/22222222222222222222222222222222') {
        return Promise.resolve(
          response(200, {
            runId: '22222222222222222222222222222222',
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            toolVersion: '1.2.3',
            status: 'exited',
            startedAt: '2026-09-25T15:00:00Z',
            endedAt: '2026-09-25T15:00:01Z',
            exitCode: 0,
            structured: {
              status: 'available',
              renderer: 'cards',
              fields: [{ key: 'name', label: 'Name', type: 'string', present: true, value: hostile }],
            },
            events: [
              {
                sequence: 1,
                type: 'stdout.chunk',
                timestamp: '2026-09-25T15:00:00Z',
                dataBase64: btoa(secretMarker),
              },
            ],
          }),
        );
      }
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RunsPage tasks={tasks} />);

    expect(await screen.findByRole('heading', { name: 'Recent runs' })).toBeInTheDocument();
    expect(screen.getByText('Inspect resources')).toBeInTheDocument();
    expect(screen.getByText('Older task')).toBeInTheDocument();
    expect(screen.queryByText(secretMarker)).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => requestPath(input as RequestInfo | URL).includes('22222222222222222222222222222222')),
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Inspect resources/i }));

    expect(await screen.findByRole('heading', { name: 'Structured result' })).toBeInTheDocument();
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(screen.queryByText(secretMarker)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByText(secretMarker)).toBeInTheDocument();
    expect(document.querySelector('#history-pwn')).toBeNull();
    expect(document.body.dataset.pwned).toBeUndefined();
  });

  test('fails closed on unexpected history fields instead of rendering untrusted list payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(200, {
          runs: [
            {
              runId: '33333333333333333333333333333333',
              packId: 'fixture',
              commandId: 'inspect',
              toolId: 'fixture',
              status: 'exited',
              argv: ['--must-not-be-accepted'],
            },
          ],
        }),
      ),
    );

    render(<RunsPage tasks={tasks} />);

    expect(await screen.findByText(/invalid or unsupported local response/i)).toBeInTheDocument();
    expect(screen.queryByText(/must-not-be-accepted/i)).not.toBeInTheDocument();
  });

  test('refreshes active history only while visible and stops once the run is terminal', async () => {
    let listCalls = 0;
    let intervalCallback: (() => void) | undefined;
    let visibilityState: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 2000) {
        intervalCallback = callback as () => void;
        return -1;
      }
      return nativeSetInterval(callback, delay);
    }) as typeof window.setInterval);
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation((id) => {
      if (id !== -1) nativeClearInterval(id);
    });

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path !== '/api/v1/runs') {
        return Promise.resolve(response(404, {}));
      }
      listCalls += 1;
      return Promise.resolve(
        response(200, {
          runs: [
            {
              runId: '55555555555555555555555555555555',
              packId: 'fixture',
              commandId: 'inspect',
              toolId: 'fixture',
              toolVersion: '1.2.3',
              status: listCalls === 1 ? 'running' : 'exited',
              startedAt: '2026-09-25T15:00:00Z',
              ...(listCalls === 1
                ? {}
                : {
                    endedAt: '2026-09-25T15:00:02Z',
                    exitCode: 0,
                  }),
            },
          ],
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RunsPage tasks={tasks} />);

    expect(await screen.findByText('Running', { selector: '.run-history-status' })).toBeInTheDocument();
    await waitFor(() => expect(intervalCallback).toBeDefined());

    await act(async () => {
      intervalCallback?.();
    });
    expect(fetchMock.mock.calls.filter(([input]) => requestPath(input as RequestInfo | URL) === '/api/v1/runs')).toHaveLength(1);

    visibilityState = 'visible';
    await act(async () => {
      intervalCallback?.();
    });

    expect(await screen.findByText('Succeeded', { selector: '.run-history-status' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => requestPath(input as RequestInfo | URL) === '/api/v1/runs')).toHaveLength(2);
    await waitFor(() => expect(clearIntervalSpy).toHaveBeenCalledWith(-1));
  });

  test('keeps list state usable when a selected retained run has already been evicted', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/runs') {
        return Promise.resolve(
          response(200, {
            runs: [
              {
                runId: '44444444444444444444444444444444',
                packId: 'fixture',
                commandId: 'inspect',
                toolId: 'fixture',
                status: 'exited',
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs/44444444444444444444444444444444') {
        return Promise.resolve(
          response(404, {
            error: {
              code: 'run_not_found',
              category: 'lifecycle',
              message: 'This run is no longer available in local retention.',
              remediation: 'Start the task again if you still need the result.',
              retryable: false,
            },
          }),
        );
      }
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RunsPage tasks={tasks} />);
    const entry = await screen.findByRole('button', { name: /Inspect resources/i });
    fireEvent.click(entry);

    expect(await screen.findByText(/no longer available in local retention/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Inspect resources/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => requestPath(input as RequestInfo | URL) === '/api/v1/runs')).toHaveLength(2));
  });
});
