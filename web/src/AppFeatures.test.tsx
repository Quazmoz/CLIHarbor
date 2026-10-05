import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

function baseRuntimeResponse(path: string): Response | undefined {
  if (path === '/api/v1/status') {
    return response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-preview' });
  }
  if (path === '/api/v1/tools') {
    return response(200, { tools: [] });
  }
  if (path === '/api/v1/tasks') {
    return response(200, {
      tasks: [
        {
          packId: 'fixture',
          packName: 'Fixture',
          commandId: 'inspect',
          name: 'Inspect',
          toolId: 'fixture',
          toolVersion: '1.2.3',
          inputs: [{ id: 'query', type: 'string', label: 'Query', required: true, validation: { maxLength: 64 } }],
        },
      ],
    });
  }
  return undefined;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/tasks');
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('command preview and retry workflows', () => {
  test('sidebar categories select a matching task and Sign in opens authentication', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/tasks') return Promise.resolve(response(200, { tasks: [
        { packId: 'alpha', packName: 'Alpha', commandId: 'inspect', name: 'Inspect alpha', toolId: 'alpha',
          inputs: [{ id: 'query', type: 'string', label: 'Query', required: true, validation: {} }] },
        { packId: 'beta', packName: 'Beta', commandId: 'inspect', name: 'Inspect beta', toolId: 'beta', inputs: [] },
      ] }));
      return Promise.resolve(baseRuntimeResponse(path) ?? response(404, {}));
    }));
    render(<App />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Query' }), { target: { value: 'old input' } });
    const categories = screen.getByRole('navigation', { name: 'Task categories' });
    fireEvent.click(within(categories).getByRole('button', { name: /Beta/ }));
    expect(screen.getByRole('heading', { name: 'Inspect beta' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Query' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Tool category' })).toHaveValue('beta/beta');
    expect(within(categories).getByRole('button', { name: /Beta/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('link', { name: 'Tasks' }));
    expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /^Inspect beta/ }));
    fireEvent.click(screen.getByRole('link', { name: 'Diagnostics' }));
    fireEvent.click(screen.getByRole('link', { name: 'Tasks' }));
    expect(screen.getByRole('heading', { name: 'Inspect beta' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(window.location.pathname).toBe('/authentication');
    expect(screen.getByRole('heading', { name: 'Authentication' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
  });

  test('a late cancellation failure cannot evict a subsequently accepted run', async () => {
    const firstID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const secondID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    class Stream extends EventTarget {
      static latest: Stream;
      constructor() { super(); Stream.latest = this; }
      close() {}
    }
    vi.stubGlobal('EventSource', Stream);
    let resolveCancel: (response: Response) => void = () => undefined;
    const pendingCancel = new Promise<Response>((resolve) => { resolveCancel = resolve; });
    let starts = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      const base = baseRuntimeResponse(path);
      if (base) return Promise.resolve(base);
      if (path.endsWith('/cancel')) return pendingCancel;
      starts += 1;
      return Promise.resolve(response(202, {
        runId: starts === 1 ? firstID : secondID, packId: 'fixture', commandId: 'inspect', toolId: 'fixture', status: 'running',
      }));
    }));
    render(<App />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Query' }), { target: { value: 'example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    await act(async () => Stream.latest.dispatchEvent(new MessageEvent('run-complete', {
      data: JSON.stringify({ runId: firstID, sequence: 0, status: 'exited', exitCode: 0 }),
    })));
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    await screen.findByText(secondID);
    await act(async () => resolveCancel(response(404, { error: {
      code: 'run_not_found', category: 'lifecycle', message: 'This run is no longer available in local retention.', retryable: false,
    } })));
    expect(screen.getByRole('heading', { name: 'Running' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Run no longer retained' })).not.toBeInTheDocument();
  });

  test('renders output captured by a run that already completed before subscription', async () => {
    const source = vi.fn();
    vi.stubGlobal('EventSource', source);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(
      baseRuntimeResponse(requestPath(input)) ?? response(202, {
        runId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', packId: 'fixture', commandId: 'inspect', toolId: 'fixture',
        status: 'exited', exitCode: 0,
        events: [
          { sequence: 1, type: 'stdout.chunk', timestamp: '2026-10-05T10:00:00Z', dataBase64: btoa('fast result') },
          { sequence: 2, type: 'stderr.chunk', timestamp: '2026-10-05T10:00:00Z', dataBase64: btoa('separate warning') },
        ],
      }),
    )));
    render(<App />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Query' }), { target: { value: 'example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));
    expect(await screen.findByText('fast result')).toBeInTheDocument();
    expect(screen.getByText('separate warning')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Succeeded' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Succeeded' })).toHaveFocus();
    expect(source).not.toHaveBeenCalled();
  });

  test('validates required inputs before preview and resets values and preview together', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(
      baseRuntimeResponse(requestPath(input)) ?? response(200, {
        packId: 'fixture', commandId: 'inspect', toolId: 'fixture', executableName: 'fixture', args: ['inspect'],
      }),
    ));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    const query = await screen.findByRole('textbox', { name: 'Query' });
    fireEvent.click(screen.getByRole('button', { name: 'Preview command' }));
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/v1/runs/preview')).toBe(false);
    expect(screen.getByRole('button', { name: 'Reset inputs' })).toBeDisabled();
    fireEvent.change(query, { target: { value: 'example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview command' }));
    expect(await screen.findByText('fixture inspect')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset inputs' }));
    expect(query).toHaveValue('');
    expect(screen.queryByText('fixture inspect')).not.toBeInTheDocument();
  });

  test('allows only one start and locks task inputs while the request is pending', async () => {
    let resolveRun: (response: Response) => void = () => undefined;
    const pendingRun = new Promise<Response>((resolve) => { resolveRun = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const base = baseRuntimeResponse(requestPath(input));
      return base === undefined ? pendingRun : Promise.resolve(base);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    const query = await screen.findByRole('textbox', { name: 'Query' });
    fireEvent.change(query, { target: { value: 'example' } });
    const form = query.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(query).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/v1/runs')).toHaveLength(1);
    await act(async () => resolveRun(response(202, {
      runId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', packId: 'fixture', commandId: 'inspect', toolId: 'fixture', status: 'exited', exitCode: 0,
    })));
    expect(query).not.toBeDisabled();
  });

  test('updates page title and moves focus to main on navigation and browser back', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(baseRuntimeResponse(requestPath(input)) ?? response(404, {}))));
    render(<App />);
    await screen.findByRole('textbox', { name: 'Query' });
    expect(document.title).toBe('Tasks · CLIHarbor');
    fireEvent.click(screen.getByRole('link', { name: 'Diagnostics' }));
    expect(document.title).toBe('Diagnostics · CLIHarbor');
    expect(screen.getByRole('main')).toHaveFocus();
    window.history.replaceState({}, '', '/tasks');
    fireEvent.popState(window);
    expect(document.title).toBe('Tasks · CLIHarbor');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  test('renders planner-backed argv preview without executable path authority', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      const base = baseRuntimeResponse(path);
      if (base !== undefined) {
        return Promise.resolve(base);
      }
      if (path === '/api/v1/runs/preview' && init?.method === 'POST') {
        const headers = new Headers(init.headers);
        expect(headers.get('X-CLIHarbor-CSRF')).toBe('csrf-preview');
        expect(JSON.parse(String(init.body))).toEqual({
          packId: 'fixture',
          commandId: 'inspect',
          values: { query: 'hello world' },
        });
        return Promise.resolve(response(200, {
          packId: 'fixture',
          commandId: 'inspect',
          toolId: 'fixture',
          toolVersion: '1.2.3',
          executableName: 'fixture.exe',
          args: ['inspect', '--query', 'hello world'],
        }));
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    const query = await screen.findByRole('textbox', { name: 'Query' });
    expect(screen.getByText('1 · Select')).toBeInTheDocument();
    expect(screen.getByText('2 · Configure')).toBeInTheDocument();
    expect(screen.getByText('3 · Verify')).toBeInTheDocument();
    expect(screen.getByText('4 · Result')).toBeInTheDocument();
    fireEvent.change(query, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview command' }));

    expect(await screen.findByText('fixture.exe inspect --query "hello world"')).toBeInTheDocument();
    expect(screen.getByText(/Display only\. CLIHarbor executes/i)).toBeInTheDocument();

    fireEvent.change(query, { target: { value: 'changed' } });
    expect(screen.queryByText('fixture.exe inspect --query "hello world"')).not.toBeInTheDocument();
  });

  test('ignores a late preview after task inputs change', async () => {
    let resolvePreview: ((value: Response) => void) | undefined;
    const delayedPreview = new Promise<Response>((resolve) => {
      resolvePreview = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      const base = baseRuntimeResponse(path);
      if (base !== undefined) {
        return Promise.resolve(base);
      }
      if (path === '/api/v1/runs/preview' && init?.method === 'POST') {
        return delayedPreview;
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    const query = await screen.findByRole('textbox', { name: 'Query' });
    fireEvent.change(query, { target: { value: 'old value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview command' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/v1/runs/preview')).toBe(true),
    );
    fireEvent.change(query, { target: { value: 'new value' } });
    expect(screen.getByRole('button', { name: 'Preview command' })).toBeEnabled();

    resolvePreview?.(
      response(200, {
        packId: 'fixture',
        commandId: 'inspect',
        toolId: 'fixture',
        toolVersion: '1.2.3',
        executableName: 'fixture.exe',
        args: ['inspect', '--query', 'old value'],
      }),
    );

    await delayedPreview;
    await waitFor(() =>
      expect(screen.queryByText('fixture.exe inspect --query "old value"')).not.toBeInTheDocument(),
    );
  });

  test('retries a completed run with its original in-memory typed inputs', async () => {
    let createCount = 0;
    const createBodies: unknown[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      const base = baseRuntimeResponse(path);
      if (base !== undefined) {
        return Promise.resolve(base);
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        createCount += 1;
        createBodies.push(JSON.parse(String(init.body)));
        return Promise.resolve(response(202, {
          runId: String(createCount).repeat(32),
          packId: 'fixture',
          commandId: 'inspect',
          toolId: 'fixture',
          toolVersion: '1.2.3',
          status: 'exited',
          exitCode: 0,
        }));
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    const query = await screen.findByRole('textbox', { name: 'Query' });
    fireEvent.change(query, { target: { value: 'original' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run task' }));

    const retry = await screen.findByRole('button', { name: 'Retry with inputs' });
    fireEvent.change(query, { target: { value: 'edited after run' } });
    fireEvent.click(retry);

    await waitFor(() => expect(createCount).toBe(2));
    expect(createBodies).toEqual([
      { packId: 'fixture', commandId: 'inspect', values: { query: 'original' } },
      { packId: 'fixture', commandId: 'inspect', values: { query: 'original' } },
    ]);
    expect(query).toHaveValue('original');
  });
});


describe('managed CLI installation workflow', () => {
  test('submits a user-selected install base directory for a missing managed CLI', async () => {
    window.history.replaceState({}, '', '/diagnostics');
    let submitted: unknown;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') {
        return Promise.resolve(response(200, {
          name: 'CLIHarbor',
          version: 'dev',
          session: 'active',
          csrfToken: 'csrf-install',
        }));
      }
      if (path === '/api/v1/tasks') {
        return Promise.resolve(response(200, { tasks: [] }));
      }
      if (path === '/api/v1/tools' && init?.method !== 'POST') {
        return Promise.resolve(response(200, {
          tools: [
            {
              packId: 'fixture-pack',
              packName: 'Fixture CLI',
              packVersion: '1.0.0',
              toolId: 'fixture',
              status: 'missing',
              message: 'Tool was not found.',
              install: {
                version: '1.2.3',
                customLocation: true,
              },
            },
          ],
        }));
      }
      if (path === '/api/v1/tools/install' && init?.method === 'POST') {
        submitted = JSON.parse(String(init.body));
        return Promise.resolve(response(200, {
          installed: true,
          version: '1.2.3',
          restartRequired: true,
          message: 'Verified CLI installed for the current user. Restart CLIHarbor to activate it.',
        }));
      }
      return Promise.resolve(response(404, { error: 'not_found' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    const location = await screen.findByRole('textbox', { name: /Install base directory/i });
    fireEvent.change(location, { target: { value: '/home/alice/cli-tools' } });
    fireEvent.click(screen.getByRole('button', { name: 'Install Fixture CLI' }));

    await waitFor(() =>
      expect(submitted).toEqual({
        packId: 'fixture-pack',
        toolId: 'fixture',
        installRoot: '/home/alice/cli-tools',
      }),
    );
    expect(await screen.findByText(/Restart CLIHarbor to activate it/i)).toBeInTheDocument();
  });
});
