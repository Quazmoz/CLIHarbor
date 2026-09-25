import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from './App';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.pathname;
  }
  return new URL(input.url).pathname;
}

class FakeEventSource {
  static latest: FakeEventSource | undefined;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, EventListener>();
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.latest = this;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === 'function') {
      this.listeners.set(type, listener);
    } else {
      this.listeners.set(type, (event) => listener.handleEvent(event));
    }
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, body: unknown): void {
    const listener = this.listeners.get(type);
    listener?.(new MessageEvent(type, { data: JSON.stringify(body) }));
  }
}

afterEach(() => {
  FakeEventSource.latest = undefined;
  FakeEventSource.instances = [];
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('App', () => {
  test('loads authenticated runtime status and safe task metadata without rendering the CSRF token', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, {
            name: 'CLIHarbor',
            version: '1.2.3-test',
            session: 'active',
            csrfToken: 'runtime-only-csrf',
          }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(response(200, { tasks: [] }));
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByText('1.2.3-test')).toBeInTheDocument();
    expect(screen.getByText('Authenticated local runtime')).toBeInTheDocument();
    expect(screen.getByText('Local only')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Local runtime active' })).toBeInTheDocument();
    expect(screen.getByText('No safe tasks are available.')).toBeInTheDocument();
    expect(screen.queryByText('runtime-only-csrf')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('shows a recoverable session-expired state for unauthenticated requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(401, {
          error: {
            code: 'session_unavailable',
            category: 'security',
            message: 'The local browser session is not active.',
            remediation: 'Relaunch CLIHarbor to establish a new secure session.',
            retryable: false,
          },
        }),
      ),
    );

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Browser session unavailable' })).toBeInTheDocument();
    expect(screen.getByText(/Relaunch CLIHarbor/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  test('retries transient status failures and then loads task metadata', async () => {
    let statusCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        statusCalls += 1;
        if (statusCalls === 1) {
          return Promise.resolve(
          response(503, {
            error: {
              code: 'stream_unavailable',
              category: 'stream',
              message: 'Live run updates are temporarily unavailable.',
              remediation: 'Refresh the run status and retry live updates if the run is still active.',
              retryable: true,
            },
          }),
        );
        }
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(response(200, { tasks: [] }));
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry status check' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Local runtime active' })).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test('renders sanitized unavailable-tool diagnostics without executable authority', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-runtime-only' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(
          response(200, {
            tools: [
              {
                packId: 'fixture',
                packName: 'Fixture Pack',
                packVersion: '1.0.0',
                toolId: 'fixture',
                status: 'missing',
                versionConstraint: '>=1.0.0 <2.0.0',
                message: 'tool was not found on absolute PATH entries; install it or configure an explicit tool path',
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(response(200, { tasks: [] }));
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByText('Fixture Pack — fixture')).toBeInTheDocument();
    expect(screen.getByText('missing')).toBeInTheDocument();
    expect(screen.getByText(/tool was not found on absolute PATH entries/i)).toBeInTheDocument();
    expect(screen.getByText(/Pack 1\.0\.0 · Required >=1\.0\.0 <2\.0\.0/)).toBeInTheDocument();
    expect(screen.queryByText(/C:\\/i)).not.toBeInTheDocument();
  });

  test('rejects browser integers outside the exact JavaScript range before mutation', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-runtime-only' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(
          response(200, {
            tasks: [
              {
                packId: 'fixture',
                packName: 'Fixture',
                commandId: 'inspect',
                name: 'Inspect',
                toolId: 'fixture',
                inputs: [{ id: 'count', type: 'integer', label: 'Count', required: true }],
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        return Promise.resolve(response(500, { error: 'should_not_run' }));
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const count = await screen.findByRole('spinbutton', { name: 'Count' });
    fireEvent.change(count, { target: { value: '9007199254740992' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));

    expect(await screen.findByText(/one or more task inputs are invalid/i)).toBeInTheDocument();
    await waitFor(() => expect(count).toHaveFocus());
    expect(count).toHaveAttribute('aria-invalid', 'true');
    expect(
      fetchMock.mock.calls.some(([input, init]) => requestPath(input as RequestInfo | URL) === '/api/v1/runs' && init?.method === 'POST'),
    ).toBe(false);
  });

  test('bounds repeated stream failures and reconciles terminal run state', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const runID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-runtime-only' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(
          response(200, {
            tasks: [
              {
                packId: 'fixture',
                packName: 'Fixture',
                commandId: 'inspect',
                name: 'Inspect',
                toolId: 'fixture',
                inputs: [],
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        return Promise.resolve(
          response(202, {
            runId: runID,
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            status: 'running',
          }),
        );
      }
      if (path === `/api/v1/runs/${runID}` && (init?.method === undefined || init.method === 'GET')) {
        return Promise.resolve(
          response(200, {
            runId: runID,
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            status: 'exited',
            exitCode: 0,
            events: [
              {
                sequence: 1,
                type: 'stdout.chunk',
                timestamp: '2026-09-18T10:00:00Z',
                dataBase64: btoa('recovered output'),
              },
              {
                sequence: 2,
                type: 'run.exited',
                timestamp: '2026-09-18T10:00:01Z',
                exitCode: 0,
              },
            ],
          }),
        );
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByRole('button', { name: 'Run task' });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    await waitFor(() => expect(FakeEventSource.latest).toBeDefined());

    const source = FakeEventSource.latest;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      source?.onerror?.(new Event('error'));
    }

    await waitFor(() => expect(source?.closed).toBe(true));
    expect(await screen.findByRole('heading', { name: 'exited' })).toBeInTheDocument();
    expect(screen.getByText('recovered output')).toBeInTheDocument();
    expect(screen.queryByText(/stopped after repeated disconnects/i)).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => requestPath(input as RequestInfo | URL) === `/api/v1/runs/${runID}`),
    ).toBe(true);
  });

  test('offers an explicit fresh stream attempt when reconciled run remains active', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const runID = 'cccccccccccccccccccccccccccccccc';
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-runtime-only' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(
          response(200, {
            tasks: [
              {
                packId: 'fixture',
                packName: 'Fixture',
                commandId: 'inspect',
                name: 'Inspect',
                toolId: 'fixture',
                inputs: [],
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        return Promise.resolve(
          response(202, {
            runId: runID,
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            status: 'running',
          }),
        );
      }
      if (path === `/api/v1/runs/${runID}`) {
        return Promise.resolve(
          response(200, {
            runId: runID,
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            status: 'running',
          }),
        );
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByRole('button', { name: 'Run task' });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const first = FakeEventSource.instances[0];
    first.onerror?.(new Event('error'));
    first.onerror?.(new Event('error'));
    first.onopen?.(new Event('open'));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      first.onerror?.(new Event('error'));
    }
    expect(first.closed).toBe(false);
    first.onerror?.(new Event('error'));

    expect(await screen.findByRole('button', { name: 'Retry live stream' })).toBeInTheDocument();
    expect(first.closed).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Retry live stream' }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

    const second = FakeEventSource.instances[1];
    expect(second.closed).toBe(false);
    expect(second.url).toContain(`/api/v1/runs/${runID}/events`);
    expect(screen.queryByRole('button', { name: 'Retry live stream' })).not.toBeInTheDocument();
  });

  test('submits only typed task values and renders streamed output as inert text', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-runtime-only' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(
          response(200, {
            tasks: [
              {
                packId: 'fixture',
                packName: 'Fixture',
                commandId: 'inspect',
                name: 'Inspect',
                toolId: 'fixture',
                toolVersion: '1.2.3',
                inputs: [
                  {
                    id: 'query',
                    type: 'string',
                    label: 'Query',
                    required: true,
                    validation: { maxLength: 64, disallowLeadingDash: true },
                  },
                ],
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        const headers = new Headers(init.headers);
        expect(headers.get('X-CLIHarbor-CSRF')).toBe('csrf-runtime-only');
        expect(JSON.parse(String(init.body))).toEqual({
          packId: 'fixture',
          commandId: 'inspect',
          values: { query: '<script>alert(1)</script>' },
        });
        return Promise.resolve(
          response(202, {
            runId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            toolVersion: '1.2.3',
            status: 'running',
          }),
        );
      }
      if (path === '/api/v1/runs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
        return Promise.resolve(
          response(200, {
            runId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            toolVersion: '1.2.3',
            status: 'exited',
            exitCode: 0,
            structured: {
              status: 'available',
              renderer: 'cards',
              fields: [
                { key: 'name', label: 'Name', type: 'string', present: true, value: '<script>alert(1)</script>' },
              ],
            },
            events: [],
          }),
        );
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const query = await screen.findByRole('textbox', { name: 'Query' });
    fireEvent.change(query, { target: { value: '<script>alert(1)</script>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));

    await waitFor(() => expect(FakeEventSource.latest).toBeDefined());
    const source = FakeEventSource.latest;
    expect(source?.url).toContain('/api/v1/runs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/events');

    source?.emit('run-event', {
      runId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sequence: 1,
      type: 'stdout.chunk',
      timestamp: '2026-09-18T10:00:00Z',
      dataBase64: btoa('<script>alert(1)</script>'),
    });
    source?.emit('run-complete', {
      runId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sequence: 1,
      status: 'exited',
      exitCode: 0,
      structured: {
        status: 'available',
        renderer: 'cards',
        fields: [
          { key: 'name', label: 'Name', type: 'string', present: true, value: '<script>alert(1)</script>' },
        ],
      },
    });

    expect(await screen.findByRole('heading', { name: 'Structured result' })).toBeInTheDocument();
    expect(screen.getAllByText('<script>alert(1)</script>')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'exited' })).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(source?.closed).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestPath(input as RequestInfo | URL) === '/api/v1/runs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toBe(false);
  });

  test('shows parser failure status while preserving raw output evidence', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const runID = 'dddddddddddddddddddddddddddddddd';
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-runtime-only' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(
          response(200, {
            tasks: [
              {
                packId: 'fixture',
                packName: 'Fixture',
                commandId: 'inspect',
                name: 'Inspect',
                toolId: 'fixture',
                inputs: [],
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        return Promise.resolve(
          response(202, {
            runId: runID,
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            status: 'running',
          }),
        );
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByRole('button', { name: 'Run task' });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    await waitFor(() => expect(FakeEventSource.latest).toBeDefined());

    const source = FakeEventSource.latest;
    source?.emit('run-event', {
      runId: runID,
      sequence: 1,
      type: 'stdout.chunk',
      timestamp: '2026-09-18T10:00:00Z',
      dataBase64: btoa('{"name":42}'),
    });
    source?.emit('run-complete', {
      runId: runID,
      sequence: 1,
      status: 'exited',
      exitCode: 0,
      structured: {
        status: 'invalid',
        renderer: 'cards',
        error: 'wrong_type',
      },
    });

    expect(await screen.findByRole('heading', { name: 'Structured result' })).toBeInTheDocument();
    expect(screen.getByText(/structured rendering could not validate this output/i)).toBeInTheDocument();
    expect(screen.getByText('wrong_type')).toBeInTheDocument();
    expect(screen.getByText('{"name":42}')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'exited' })).toBeInTheDocument();
  });

  test('associates backend input failures with the affected field and moves focus', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-runtime-only' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(
          response(200, {
            tasks: [
              {
                packId: 'fixture',
                packName: 'Fixture',
                commandId: 'inspect',
                name: 'Inspect',
                toolId: 'fixture',
                inputs: [{ id: 'query', type: 'string', label: 'Query', required: true }],
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        return Promise.resolve(
          response(400, {
            error: {
              code: 'invalid_input',
              category: 'validation',
              message: 'One or more task inputs are invalid.',
              remediation: 'Correct the highlighted field and retry.',
              retryable: false,
              field: 'values.query',
            },
          }),
        );
      }
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const query = await screen.findByRole('textbox', { name: 'Query' });
    fireEvent.change(query, { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));

    expect(await screen.findByText(/correct the highlighted field and retry/i)).toBeInTheDocument();
    await waitFor(() => expect(query).toHaveFocus());
    expect(query).toHaveAttribute('aria-invalid', 'true');
    expect(query).toHaveAttribute('aria-describedby', 'task-input-query-error');
  });

  test('renders hostile-looking typed error text inertly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(500, {
          error: {
            code: 'internal_error',
            category: 'internal',
            message: '<img src=x onerror=alert(1)>',
            remediation: 'Use local diagnostics.',
            retryable: false,
          },
        }),
      ),
    );

    render(<App />);

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  test('falls back safely for unknown backend error codes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(500, {
          error: {
            code: 'future_private_failure',
            category: 'internal',
            message: 'PRIVATE_INTERNAL_MARKER',
            remediation: 'PRIVATE_REMEDIATION_MARKER',
            retryable: false,
          },
        }),
      ),
    );

    render(<App />);

    expect(await screen.findByText(/invalid or unsupported local response/i)).toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE_INTERNAL_MARKER/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/future_private_failure/i)).not.toBeInTheDocument();
  });

  test('handles retained-run eviction after stream exhaustion without stale active controls', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const runID = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-runtime-only' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(
          response(200, {
            tasks: [
              {
                packId: 'fixture',
                packName: 'Fixture',
                commandId: 'inspect',
                name: 'Inspect',
                toolId: 'fixture',
                inputs: [],
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        return Promise.resolve(
          response(202, {
            runId: runID,
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            status: 'running',
          }),
        );
      }
      if (path === `/api/v1/runs/${runID}`) {
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

    render(<App />);

    await screen.findByRole('button', { name: 'Run task' });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    await waitFor(() => expect(FakeEventSource.latest).toBeDefined());

    const source = FakeEventSource.latest;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      source?.onerror?.(new Event('error'));
    }

    expect(await screen.findByRole('heading', { name: 'run no longer retained' })).toBeInTheDocument();
    expect(screen.getByText(/no longer available in local retention/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry live stream' })).not.toBeInTheDocument();
  });

  test('announces live connection and timeout states without color-only semantics', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const runID = 'ffffffffffffffffffffffffffffffff';
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-runtime-only' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(
          response(200, {
            tasks: [
              {
                packId: 'fixture',
                packName: 'Fixture',
                commandId: 'inspect',
                name: 'Inspect',
                toolId: 'fixture',
                inputs: [],
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        return Promise.resolve(
          response(202, {
            runId: runID,
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            status: 'running',
          }),
        );
      }
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByRole('button', { name: 'Run task' });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    await waitFor(() => expect(FakeEventSource.latest).toBeDefined());

    FakeEventSource.latest?.onopen?.(new Event('open'));
    expect(await screen.findByText('Live updates: connected.')).toBeInTheDocument();

    FakeEventSource.latest?.emit('run-complete', {
      runId: runID,
      sequence: 1,
      status: 'timed-out',
    });

    expect(await screen.findByRole('heading', { name: 'timed-out' })).toBeInTheDocument();
    expect(screen.getByText(/execution time limit and was stopped/i)).toBeInTheDocument();
    for (const output of screen.getAllByText(/No stdout yet\.|No stderr yet\./i)) {
      expect(output.closest('pre')).toHaveAttribute('tabindex', '0');
    }
  });

  test('does not let a stale cancel response regress a completed run', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const runID = 'abababababababababababababababab';
    let resolveCancel: ((value: Response) => void) | undefined;
    const cancelResponse = new Promise<Response>((resolve) => {
      resolveCancel = resolve;
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-runtime-only' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(
          response(200, {
            tasks: [
              {
                packId: 'fixture',
                packName: 'Fixture',
                commandId: 'inspect',
                name: 'Inspect',
                toolId: 'fixture',
                inputs: [],
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        return Promise.resolve(
          response(202, {
            runId: runID,
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            status: 'running',
          }),
        );
      }
      if (path === `/api/v1/runs/${runID}/cancel` && init?.method === 'POST') {
        return cancelResponse;
      }
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByRole('button', { name: 'Run task' });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    await waitFor(() => expect(FakeEventSource.latest).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(screen.getByRole('button', { name: 'Cancellation requested' })).toBeDisabled();

    FakeEventSource.latest?.emit('run-complete', {
      runId: runID,
      sequence: 2,
      status: 'cancelled',
    });
    expect(await screen.findByRole('heading', { name: 'cancelled' })).toBeInTheDocument();

    resolveCancel?.(
      response(200, {
        runId: runID,
        packId: 'fixture',
        commandId: 'inspect',
        toolId: 'fixture',
        status: 'running',
      }),
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: 'cancelled' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancellation requested' })).not.toBeInTheDocument();
  });

  test('prioritizes the operator workflow and keeps diagnostics secondary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = requestPath(input);
        if (path === '/api/v1/status') {
          return Promise.resolve(
            response(200, { name: 'CLIHarbor', version: '1.2.3', session: 'active', csrfToken: 'csrf-runtime-only' }),
          );
        }
        if (path === '/api/v1/tools') {
          return Promise.resolve(
            response(200, {
              tools: [
                {
                  packId: 'fixture',
                  packName: 'Fixture',
                  packVersion: '1.0.0',
                  toolId: 'fixture',
                  status: 'ready',
                  version: '1.2.3',
                },
              ],
            }),
          );
        }
        if (path === '/api/v1/tasks') {
          return Promise.resolve(
            response(200, {
              tasks: [
                {
                  packId: 'fixture',
                  packName: 'Fixture',
                  commandId: 'inspect',
                  name: 'Inspect',
                  description: 'Inspect local fixture state.',
                  toolId: 'fixture',
                  toolVersion: '1.2.3',
                  inputs: [],
                },
              ],
            }),
          );
        }
        return Promise.resolve(response(404, {}));
      }),
    );

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Ready for curated local work' })).toBeInTheDocument();
    expect(screen.queryByText(/Run curated CLI tasks without handing execution authority/i)).not.toBeInTheDocument();
    expect(screen.getByText('Read-only safe task')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No active run' })).toBeInTheDocument();

    const diagnostics = screen.getByText('Tool readiness').closest('details');
    expect(diagnostics).not.toBeNull();
    expect(diagnostics).not.toHaveAttribute('open');
    expect(screen.getAllByText('1/1 ready').length).toBeGreaterThanOrEqual(1);
  });

});


describe('App routing', () => {
  test('supports direct Authentication navigation and native route links without credential fields', async () => {
    window.history.replaceState({}, '', '/authentication');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-route-test' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(
          response(200, {
            tools: [
              {
                packId: 'cyberark-conjur-v9',
                packName: 'CyberArk / Idira Secrets Manager CLI 9.x',
                packVersion: '0.1.1',
                toolId: 'conjur',
                status: 'ready',
                version: '9.3.1',
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(
          response(200, {
            tasks: [
              {
                packId: 'cyberark-conjur-v9',
                packName: 'CyberArk / Idira Secrets Manager CLI 9.x',
                commandId: 'whoami',
                name: 'Who am I',
                toolId: 'conjur',
                requiresAuth: true,
                inputs: [],
              },
            ],
          }),
        );
      }
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Authentication' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/authentication');
    expect(document.querySelector('input[type="password"]')).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: 'Tasks' }));
    expect(window.location.pathname).toBe('/tasks');
    expect(await screen.findByRole('heading', { name: 'Run a safe task' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Authentication' }));
    expect(window.location.pathname).toBe('/authentication');
    expect(await screen.findByRole('heading', { name: 'Authentication' })).toBeInTheDocument();
  });

  test('guides nonzero auth-required task runs back to Authentication without declaring the cause', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(
          response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-auth-guide' }),
        );
      }
      if (path === '/api/v1/tools') {
        return Promise.resolve(response(200, { tools: [] }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(
          response(200, {
            tasks: [
              {
                packId: 'fixture',
                packName: 'Fixture',
                commandId: 'inspect',
                name: 'Inspect',
                toolId: 'fixture',
                requiresAuth: true,
                inputs: [],
              },
            ],
          }),
        );
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        return Promise.resolve(
          response(202, {
            runId: '99999999999999999999999999999999',
            packId: 'fixture',
            commandId: 'inspect',
            toolId: 'fixture',
            status: 'running',
          }),
        );
      }
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByRole('button', { name: 'Run task' });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    await waitFor(() => expect(FakeEventSource.latest).toBeDefined());

    FakeEventSource.latest?.emit('run-complete', {
      runId: '99999999999999999999999999999999',
      sequence: 1,
      status: 'exited',
      exitCode: 1,
    });

    expect(await screen.findByText(/Re-check Authentication before assuming the cause/i)).toBeInTheDocument();
    const reviewButtons = screen.getAllByRole('button', { name: 'Review authentication' });
    fireEvent.click(reviewButtons[reviewButtons.length - 1]);
    expect(window.location.pathname).toBe('/authentication');
  });
});
