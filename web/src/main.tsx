import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// A render exception must not blank the page while runs keep executing server-side.
class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main>
        <section className="panel error-panel" role="alert">
          <h1>CLIHarbor hit an unexpected display error</h1>
          <p>Active runs continue in the local runtime. Reload to restore the workspace.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload CLIHarbor
          </button>
        </section>
      </main>
    );
  }
}

const root = document.getElementById('root');
if (root === null) {
  throw new Error('CLIHarbor root element is missing.');
}

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
