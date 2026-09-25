import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    toolVersion: '1.2.3',
    inputs: [],
  },
  {
    packId: 'fixture',
    packName: 'Fixture Pack',
    commandId: 'older',
    name: 'Older task',
    toolId: 'fixture',
    inputs: [],
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RunsPage', () => {
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
