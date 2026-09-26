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

afterEach(() => {
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('command preview and retry workflows', () => {
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
    fireEvent.change(query, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview invocation' }));

    expect(await screen.findByText('fixture.exe inspect --query "hello world"')).toBeInTheDocument();
    expect(screen.getByText(/Display only\. CLIHarbor still executes/i)).toBeInTheDocument();

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
    fireEvent.click(screen.getByRole('button', { name: 'Preview invocation' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/v1/runs/preview')).toBe(true),
    );
    fireEvent.change(query, { target: { value: 'new value' } });
    expect(screen.getByRole('button', { name: 'Preview invocation' })).toBeEnabled();

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
