import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from './App';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  test('loads authenticated runtime status and renders local-only state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(200, {
          name: 'CLIHarbor',
          version: '1.2.3-test',
          session: 'active',
          csrfToken: 'session-csrf-token',
        }),
      ),
    );

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'CLIHarbor' })).toBeInTheDocument();
    expect(screen.getByText('1.2.3-test')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Local only')).toBeInTheDocument();
    expect(screen.queryByText('session-csrf-token')).not.toBeInTheDocument();
  });

  test('shows a recoverable session-expired state for unauthenticated requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401, { error: 'unauthorized' })));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Browser session unavailable' })).toBeInTheDocument();
    expect(screen.getByText(/Relaunch CLIHarbor/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  test('retries transient status failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(
        response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'retry-csrf-token' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry status check' }));

    await waitFor(() => expect(screen.getByText('Running')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
