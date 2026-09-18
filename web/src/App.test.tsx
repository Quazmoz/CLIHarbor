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
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Local only')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '0' })).toBeInTheDocument();
    expect(screen.queryByText('runtime-only-csrf')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('shows a recoverable session-expired state for unauthenticated requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401, { error: 'unauthorized' })));

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
          return Promise.resolve(response(503, { error: 'unavailable' }));
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

    await waitFor(() => expect(screen.getByText('Running')).toBeInTheDocument());
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

    expect(
      await screen.findByText(/must be an integer within the browser's exact numeric range/i),
    ).toBeInTheDocument();
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
    });

    expect(await screen.findByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Structured result' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'exited' })).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(source?.closed).toBe(true);
  });
});
