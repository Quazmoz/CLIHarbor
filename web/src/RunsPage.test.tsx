import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RunsPage } from './RunsPage';
import type { Task } from './api/tasks';

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
  test('keeps completed evidence readable through refresh failure and does not poll it for another active run', async () => {
    const completedID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    let intervalCallback: (() => void) | undefined;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 2000) intervalCallback = callback as () => void;
      return 1;
    }) as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
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
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (delay === 2000) intervalCallback = callback as () => void;
      return 1;
    }) as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    let resolvePoll: (response: Response) => void = () => undefined;
    const slowPoll = new Promise<Response>((resolve) => { resolvePoll = resolve; });
    const summary = { runId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', packId: 'fixture', commandId: 'inspect', toolId: 'fixture' };
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200, { runs: [{ ...summary, status: 'running' }] })).mockReturnValue(slowPoll);
    vi.stubGlobal('fetch', fetchMock);
    render(<RunsPage tasks={tasks} />);
    await screen.findByText('Running');
    await act(async () => intervalCallback?.());
    await act(async () => intervalCallback?.());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => resolvePoll(response(200, { runs: [{ ...summary, status: 'exited', exitCode: 0 }] })));
    expect(await screen.findByText('Succeeded')).toBeInTheDocument();
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
                risk: 'read',
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
                risk: 'read',
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
            risk: 'read',
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
              risk: 'read',
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
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
      // Testing Library also creates polling intervals; capture only the
      // application's two-second history refresh callback.
      if (delay === 2000) intervalCallback = callback as () => void;
      return 1;
    }) as typeof window.setInterval);
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);

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
              risk: 'read',
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

    expect(await screen.findByText('Running')).toBeInTheDocument();
    await waitFor(() => expect(intervalCallback).toBeDefined());

    await act(async () => {
      intervalCallback?.();
    });
    expect(fetchMock.mock.calls.filter(([input]) => requestPath(input as RequestInfo | URL) === '/api/v1/runs')).toHaveLength(1);

    visibilityState = 'visible';
    await act(async () => {
      intervalCallback?.();
    });

    expect(await screen.findByText('Succeeded')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => requestPath(input as RequestInfo | URL) === '/api/v1/runs')).toHaveLength(2);
    await waitFor(() => expect(clearIntervalSpy).toHaveBeenCalledWith(1));
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
                risk: 'read',
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
