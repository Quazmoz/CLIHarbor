import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OverviewPage } from './OverviewPage';
import type { RuntimeStatus } from './api/status';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import type { TaskPreferences } from './taskPreferences';

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

const status: RuntimeStatus = {
  name: 'CLIHarbor',
  version: 'dev',
  session: 'active',
  csrfToken: 'csrf-overview-test',
};

const tasks: Task[] = [
  {
    packId: 'conjur',
    packName: 'Conjur',
    commandId: 'whoami',
    name: 'Current identity',
    toolId: 'conjur',
    risk: 'read',
    toolVersion: '9.3.1',
    requiresAuth: true,
    inputs: [],
  },
  {
    packId: 'docker',
    packName: 'Docker',
    commandId: 'containers',
    name: 'List containers',
    toolId: 'docker',
    risk: 'read',
    inputs: [],
  },
];

const readyTools: ToolDiagnostic[] = [
  {
    packId: 'conjur',
    packName: 'Conjur',
    packVersion: '0.2.0',
    toolId: 'conjur',
    risk: 'read',
    status: 'ready',
    version: '9.3.1',
    requiresVendorSession: true,
    sessionCheck: {
      commandId: 'whoami',
      unauthenticatedStderrContains: 'please login again',
    },
    credentialLogin: {
      method: 'conjur-password',
    },
  },
  {
    packId: 'docker',
    packName: 'Docker',
    packVersion: '0.2.0',
    toolId: 'docker',
    risk: 'read',
    status: 'ready',
  },
];

const preferences: TaskPreferences = {
  favorites: [{ packId: 'docker', commandId: 'containers' }],
  recent: [{ packId: 'conjur', commandId: 'whoami' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OverviewPage', () => {
  test('summarizes readiness and opens favorite or recent tasks directly', () => {
    const navigate = vi.fn();
    const openTask = vi.fn();

    render(
      <OverviewPage
        status={status}
        tasks={tasks}
        tools={readyTools}
        preferences={preferences}
        onNavigate={navigate}
        onOpenTask={openTask}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Ready for local operator work' })).toBeInTheDocument();
    expect(screen.getByText('2/2 ready')).toBeInTheDocument();
    expect(screen.getByText('2 tasks')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /List containers/i }));
    expect(openTask).toHaveBeenCalledWith('docker/containers');

    fireEvent.click(screen.getByRole('button', { name: 'Review authentication' }));
    expect(navigate).toHaveBeenCalledWith('authentication');
  });

  test('renders and completes CLI sign-in directly from the overview', async () => {
    let loginRequest: unknown;
    let loginHeaders: HeadersInit | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === '/api/v1/auth/login') {
          loginRequest = JSON.parse(String(init?.body));
          loginHeaders = init?.headers;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (path === '/api/v1/runs') {
          return Promise.resolve(
            response(202, {
              runId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              packId: 'conjur',
              commandId: 'whoami',
              toolId: 'conjur',
              risk: 'read',
              status: 'exited',
              exitCode: 0,
            }),
          );
        }
        return Promise.resolve(response(404, {}));
      }),
    );

    render(
      <OverviewPage
        status={status}
        tasks={tasks}
        tools={readyTools}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Sign in from CLIHarbor' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Identity' }), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'super-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in and verify' }));

    expect(await screen.findByRole('heading', { name: 'Authenticated' })).toBeInTheDocument();
    expect(loginRequest).toEqual({
      packId: 'conjur',
      toolId: 'conjur',
      risk: 'read',
      identity: 'alice',
      secret: 'super-secret',
    });
    expect(loginHeaders).toMatchObject({ 'X-CLIHarbor-CSRF': status.csrfToken });
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  test('offers vendor-owned Conjur login directly from Overview when advertised', async () => {
    const vendorLoginTools: ToolDiagnostic[] = [
      {
        ...readyTools[0],
        credentialLogin: { method: 'conjur-vendor-login' },
      },
      readyTools[1],
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (requestPath(input) === '/api/v1/auth/interactive') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <OverviewPage
        status={status}
        tasks={tasks}
        tools={vendorLoginTools}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Sign in from CLIHarbor' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start official Conjur sign-in' }));
    expect(await screen.findByText('Official Conjur sign-in started.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('keeps a detected Conjur CLI visible when browser credential capability is unavailable', () => {
    const detectedWithoutBrowserLogin: ToolDiagnostic[] = [
      {
        ...readyTools[0],
        credentialLogin: undefined,
      },
      readyTools[1],
    ];

    render(
      <OverviewPage
        status={status}
        tasks={tasks}
        tools={detectedWithoutBrowserLogin}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'CLI authentication' })).toBeInTheDocument();
    expect(screen.getByText('2/2 ready')).toBeInTheDocument();
    expect(
      screen.getByText(/CLI detected; browser sign-in is unavailable for the current vendor configuration/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check session' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Identity' })).not.toBeInTheDocument();
  });

  test('routes the primary recommendation to diagnostics when a tool needs attention', () => {
    const navigate = vi.fn();
    const attentionTools: ToolDiagnostic[] = [
      readyTools[0],
      { ...readyTools[1], status: 'missing', message: 'Tool was not found.' },
    ];

    render(
      <OverviewPage
        status={status}
        tasks={tasks}
        tools={attentionTools}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={navigate}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Resolve tool readiness' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Review tool readiness' })[0]);
    expect(navigate).toHaveBeenCalledWith('diagnostics');
  });

  test('keeps authentication status conservative rather than inventing a signed-in verdict', () => {
    render(
      <OverviewPage
        status={status}
        tasks={tasks}
        tools={readyTools}
        preferences={{ favorites: [], recent: [] }}
        onNavigate={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.getByText('1 task needs sign-in before use')).toBeInTheDocument();
    expect(screen.queryByText(/^Authenticated$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Signed in$/i)).not.toBeInTheDocument();
  });
});
