import { useEffect, useState } from 'react';
import { fetchRuntimeStatus, SessionUnavailableError, type RuntimeStatus } from './api/status';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: RuntimeStatus }
  | { kind: 'error'; message: string; sessionUnavailable: boolean };

function errorMessage(error: unknown): { message: string; sessionUnavailable: boolean } {
  if (error instanceof SessionUnavailableError) {
    return { message: error.message, sessionUnavailable: true };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { message: error.message, sessionUnavailable: false };
  }
  return { message: 'CLIHarbor could not load local runtime status.', sessionUnavailable: false };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function App() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });

  const retryStatus = () => {
    setState({ kind: 'loading' });
    void fetchRuntimeStatus().then(
      (status) => setState({ kind: 'ready', status }),
      (error: unknown) => setState({ kind: 'error', ...errorMessage(error) }),
    );
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetchRuntimeStatus(controller.signal).then(
      (status) => setState({ kind: 'ready', status }),
      (error: unknown) => {
        if (!isAbort(error)) {
          setState({ kind: 'error', ...errorMessage(error) });
        }
      },
    );
    return () => controller.abort();
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">LOCAL OPERATOR CONSOLE</span>
          <h1>CLIHarbor</h1>
        </div>
        <span className="local-badge">Local only</span>
      </header>

      <main>
        <section className="hero" aria-labelledby="runtime-heading">
          <div>
            <p className="hero-kicker">Secure local runtime</p>
            <h2 id="runtime-heading">Your CLI workflows stay on this computer.</h2>
            <p>
              CLIHarbor is listening only on the loopback interface. This browser UI cannot expose the runtime to other devices.
            </p>
          </div>
        </section>

        {state.kind === 'loading' && (
          <section className="panel" role="status" aria-live="polite">
            <h2>Checking runtime</h2>
            <p>Verifying the authenticated local browser session…</p>
          </section>
        )}

        {state.kind === 'error' && (
          <section className="panel error-panel" role="alert">
            <p className="status-label">Connection state</p>
            <h2>{state.sessionUnavailable ? 'Browser session unavailable' : 'Runtime status unavailable'}</h2>
            <p>{state.message}</p>
            {!state.sessionUnavailable && (
              <button type="button" onClick={retryStatus}>
                Retry status check
              </button>
            )}
          </section>
        )}

        {state.kind === 'ready' && (
          <section className="status-grid" aria-label="CLIHarbor status">
            <article className="panel">
              <p className="status-label">Application</p>
              <h2>{state.status.name}</h2>
              <dl>
                <div>
                  <dt>Version</dt>
                  <dd>{state.status.version}</dd>
                </div>
              </dl>
            </article>

            <article className="panel">
              <p className="status-label">Local runtime</p>
              <h2>Running</h2>
              <p>Bound to this computer only.</p>
            </article>

            <article className="panel">
              <p className="status-label">Browser session</p>
              <h2>Active</h2>
              <p>The one-time launch handoff has been exchanged for a local browser session.</p>
            </article>
          </section>
        )}
      </main>

      <footer>
        <p>No cloud backend. No telemetry by default. No remote runtime assets.</p>
      </footer>
    </div>
  );
}
