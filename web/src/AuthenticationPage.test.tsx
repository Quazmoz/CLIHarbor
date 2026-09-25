import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthenticationPage } from './AuthenticationPage';
import type { RuntimeStatus } from './api/status';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';

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

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, EventListener>();
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(
      type,
      typeof listener === 'function' ? listener : (event) => listener.handleEvent(event),
    );
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, body: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(body) }));
  }
}

const status: RuntimeStatus = {
  name: 'CLIHarbor',
  version: 'dev',
  session: 'active',
  csrfToken: 'csrf-auth-test',
};

const whoamiTask: Task = {
  packId: 'cyberark-conjur-v9',
  packName: 'CyberArk / Idira Secrets Manager CLI 9.x',
  commandId: 'whoami',
  name: 'Who am I',
  toolId: 'conjur',
  toolVersion: '9.3.1',
  requiresAuth: true,
  inputs: [],
};

const readyTool: ToolDiagnostic = {
  packId: 'cyberark-conjur-v9',
  packName: 'CyberArk / Idira Secrets Manager CLI 9.x',
  packVersion: '0.1.1',
  toolId: 'conjur',
  status: 'ready',
  version: '9.3.1',
  versionConstraint: '>=9.3.1-0 <10.0.0-0',
};

function renderAuth(tasks: Task[] = [whoamiTask], tools: ToolDiagnostic[] = [readyTool]) {
  return render(
    <AuthenticationPage
      status={status}
      tasks={tasks}
      tools={tools}
      onOpenTasks={vi.fn()}
      onOpenDiagnostics={vi.fn()}
    />,
  );
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe('AuthenticationPage', () => {
  test('verifies an authenticated session and renders only allowlisted identity context as inert text', async () => {
    const hostileIdentity = '<img id="auth-pwn" src=x onerror="document.body.dataset.pwned=1">';
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (requestPath(input) === '/api/v1/runs') {
          return Promise.resolve(
            response(202, {
              runId: '11111111111111111111111111111111',
              packId: 'cyberark-conjur-v9',
              commandId: 'whoami',
              toolId: 'conjur',
              status: 'exited',
              exitCode: 0,
              events: [
                {
                  sequence: 1,
                  type: 'stdout.chunk',
                  timestamp: '2026-09-25T14:00:00Z',
                  dataBase64: btoa(JSON.stringify({ account: 'engineering', username: hostileIdentity, token: 'must-not-render' })),
                },
              ],
            }),
          );
        }
        return Promise.resolve(response(404, {}));
      }),
    );

    renderAuth();
    fireEvent.click(screen.getByRole('button', { name: 'Check session' }));

    expect(await screen.findByRole('heading', { name: 'Authenticated' })).toBeInTheDocument();
    expect(screen.getByText('engineering')).toBeInTheDocument();
    expect(screen.getByText(hostileIdentity)).toBeInTheDocument();
    expect(screen.queryByText('must-not-render')).not.toBeInTheDocument();
    expect(document.querySelector('#auth-pwn')).toBeNull();
    expect(document.body.dataset.pwned).toBeUndefined();
  });

  test('uses reviewed signed-out evidence without flattening arbitrary failures into signed out', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (requestPath(input) !== '/api/v1/runs') {
          return Promise.resolve(response(404, {}));
        }
        attempts += 1;
        if (attempts === 1) {
          return Promise.resolve(
            response(202, {
              runId: '22222222222222222222222222222222',
              packId: 'cyberark-conjur-v9',
              commandId: 'whoami',
              toolId: 'conjur',
              status: 'exited',
              exitCode: 1,
              events: [
                {
                  sequence: 1,
                  type: 'stderr.chunk',
                  timestamp: '2026-09-25T14:00:00Z',
                  dataBase64: btoa('Error: Please login again\n'),
                },
              ],
            }),
          );
        }
        return Promise.resolve(
          response(202, {
            runId: '33333333333333333333333333333333',
            packId: 'cyberark-conjur-v9',
            commandId: 'whoami',
            toolId: 'conjur',
            status: 'exited',
            exitCode: 1,
            events: [
              {
                sequence: 1,
                type: 'stderr.chunk',
                timestamp: '2026-09-25T14:00:01Z',
                dataBase64: btoa('Error: upstream service refused request'),
              },
            ],
          }),
        );
      }),
    );

    renderAuth();
    fireEvent.click(screen.getByRole('button', { name: 'Check session' }));
    expect(await screen.findByRole('heading', { name: 'Authentication required' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Re-check session' }));
    expect(await screen.findByRole('heading', { name: 'Authentication check failed' })).toBeInTheDocument();
    expect(screen.queryByText(/signed out/i)).not.toBeInTheDocument();
  });

  test.each([
    ['missing', 'CLI unavailable'],
    ['incompatible', 'Version incompatible'],
    ['probe-failed', 'Probe failed'],
  ] as const)('blocks session checks when the tool state is %s', async (toolStatus, expectedStatus) => {
    const tool: ToolDiagnostic = { ...readyTool, status: toolStatus, version: undefined };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderAuth([], [tool]);

    expect(await screen.findByText(expectedStatus)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check session' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open diagnostics' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('reports a sanitized session-check failure and supports a successful retry', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (requestPath(input) !== '/api/v1/runs') {
          return Promise.resolve(response(404, {}));
        }
        attempts += 1;
        return Promise.resolve(
          response(202, {
            runId: attempts === 1 ? '44444444444444444444444444444444' : '55555555555555555555555555555555',
            packId: 'cyberark-conjur-v9',
            commandId: 'whoami',
            toolId: 'conjur',
            status: attempts === 1 ? 'failed' : 'exited',
            exitCode: attempts === 1 ? undefined : 0,
            failure:
              attempts === 1
                ? {
                    code: 'execution_failed',
                    category: 'execution',
                    message: 'CLIHarbor could not complete the local process lifecycle.',
                    remediation: 'Review the run state and use cliharbor doctor for local diagnostics before retrying.',
                    retryable: false,
                  }
                : undefined,
          }),
        );
      }),
    );

    renderAuth();
    fireEvent.click(screen.getByRole('button', { name: 'Check session' }));
    expect(await screen.findByRole('heading', { name: 'Authentication check failed' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Re-check session' }));
    expect(await screen.findByRole('heading', { name: 'Authenticated' })).toBeInTheDocument();
  });

  test('prevents duplicate checks while the run creation request is pending', async () => {
    let resolveRequest: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (requestPath(input) === '/api/v1/runs') {
        return pending;
      }
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAuth();
    const button = screen.getByRole('button', { name: 'Check session' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(screen.getByRole('button', { name: 'Checking session…' })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveRequest?.(
      response(202, {
        runId: '66666666666666666666666666666666',
        packId: 'cyberark-conjur-v9',
        commandId: 'whoami',
        toolId: 'conjur',
        status: 'exited',
        exitCode: 0,
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Authenticated' })).toBeInTheDocument();
  });

  test('ignores stale completion from an earlier check after retry', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    let runCreates = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/runs') {
        runCreates += 1;
        return Promise.resolve(
          response(202, {
            runId: runCreates === 1 ? '77777777777777777777777777777777' : '88888888888888888888888888888888',
            packId: 'cyberark-conjur-v9',
            commandId: 'whoami',
            toolId: 'conjur',
            status: 'running',
          }),
        );
      }
      if (path === '/api/v1/runs/77777777777777777777777777777777') {
        return Promise.resolve(
          response(200, {
            runId: '77777777777777777777777777777777',
            packId: 'cyberark-conjur-v9',
            commandId: 'whoami',
            toolId: 'conjur',
            status: 'exited',
            exitCode: 2,
            events: [],
          }),
        );
      }
      return Promise.resolve(
        response(202, {
          runId: '77777777777777777777777777777777',
          packId: 'cyberark-conjur-v9',
          commandId: 'whoami',
          toolId: 'conjur',
          status: 'cancelled',
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAuth();
    fireEvent.click(screen.getByRole('button', { name: 'Check session' }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const first = FakeEventSource.instances[0];
    for (let index = 0; index < 5; index += 1) {
      first.onerror?.(new Event('error'));
    }
    expect(await screen.findByRole('heading', { name: 'Authentication check failed' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Re-check session' }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const second = FakeEventSource.instances[1];
    second.emit('run-complete', {
      runId: '88888888888888888888888888888888',
      sequence: 1,
      status: 'exited',
      exitCode: 0,
    });
    expect(await screen.findByRole('heading', { name: 'Authenticated' })).toBeInTheDocument();

    first.emit('run-complete', {
      runId: '77777777777777777777777777777777',
      sequence: 2,
      status: 'exited',
      exitCode: 1,
    });
    expect(screen.getByRole('heading', { name: 'Authenticated' })).toBeInTheDocument();
  });

  test('contains no browser credential inputs and exposes keyboard-native actions', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAuth();

    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.querySelector('input')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check session' })).toBeEnabled();
    expect(screen.getByText(/does not collect or store your vendor password/i)).toBeInTheDocument();
  });
});
