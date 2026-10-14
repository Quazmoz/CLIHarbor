import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App';

// Command previews render one span per token, so match the whole <code> text.
const commandText = (text: string) => (_: string, element: Element | null) =>
  element?.tagName === 'CODE' && element.textContent === text;

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
  if (path === '/api/v1/platforms') {
    return response(200, { platforms: [] });
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

describe('Conjur migration inventory presets', () => {
  test('opens only a backend-advertised read task with validated enum inputs, never a run', async () => {
    window.history.replaceState({}, '', '/dedicated/conjur');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/platforms') return Promise.resolve(response(200, { platforms: [{
        id: 'conjur', name: 'CyberArk Conjur', summary: 'Reviewed workflows.',
        packId: 'cyberark-conjur-v9', toolId: 'conjur', ready: true,
        features: [{ id: 'tasks', name: 'Conjur tasks' }],
      }] }));
      if (path === '/api/v1/tasks') return Promise.resolve(response(200, { tasks: [{
        packId: 'cyberark-conjur-v9', packName: 'Conjur', toolId: 'conjur',
        commandId: 'list-resources', name: 'List resources', risk: 'read', requiresAuth: true,
        inputs: [
          { id: 'kind', type: 'enum', label: 'Resource kind', validation: { enum: ['host', 'variable'] } },
          { id: 'limit', type: 'enum', label: 'Page size', required: true, validation: { enum: ['25', '50', '100'] } },
        ],
      }] }));
      return Promise.resolve(baseRuntimeResponse(path) ?? response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'CyberArk Conjur' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    fireEvent.click(screen.getByText('Migration playbooks & policy templates'));
    fireEvent.click(screen.getByRole('button', { name: 'Filtered variable inventory' }));

    expect(window.location.pathname).toBe('/tasks');
    expect(screen.getByRole('combobox', { name: 'Resource kind' })).toHaveValue('variable');
    expect(screen.getByRole('combobox', { name: 'Page size' })).toHaveValue('25');
    expect(fetchMock.mock.calls.every(([input]) => requestPath(input) !== '/api/v1/runs')).toBe(true);
  });
});

describe('command preview and retry workflows', () => {
  test.each(['ready', 'missing', 'incompatible'] as const)('only calls attention to a %s CLI when needed', async (status) => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/tools') return Promise.resolve(response(200, { tools: [{
        packId: 'fixture', packName: 'Fixture', packVersion: '1.0.0', toolId: 'fixture', status,
      }] }));
      return Promise.resolve(baseRuntimeResponse(path) ?? response(404, {}));
    }));
    render(<App />);
    await screen.findByRole('heading', { name: 'Inspect' });
    const header = document.querySelector<HTMLElement>('.topbar')!;
    expect(within(header).queryByText(/executables ready/)).not.toBeInTheDocument();
    if (status === 'ready') expect(within(header).queryByRole('link', { name: '1 CLI needs attention' })).not.toBeInTheDocument();
    else {
      fireEvent.click(within(header).getByRole('link', { name: '1 CLI needs attention' }));
      expect(window.location.pathname).toBe('/diagnostics');
      expect(screen.getByRole('main')).toHaveFocus();
    }
  });

  test('built-in Conjur is only in the top bar while workspace navigation stays in the sidebar', async () => {
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/tasks') return Promise.resolve(response(200, { tasks: [
        { packId: 'cyberark-conjur-v9', packName: 'Conjur', commandId: 'list', name: 'List variables', toolId: 'conjur', requiresAuth: true, inputs: [] },
        { packId: 'fixture', packName: 'Fixture', commandId: 'inspect', name: 'Inspect fixture', toolId: 'fixture', inputs: [] },
      ] }));
      if (path === '/api/v1/platforms') return Promise.resolve(response(200, { platforms: [{
        id: 'conjur', name: 'CyberArk Conjur', summary: 'Built for Conjur.', packId: 'cyberark-conjur-v9', toolId: 'conjur', ready: true,
        features: [{ id: 'tasks', name: 'Conjur tasks' }, { id: 'sign-in', name: 'Sign in' }, { id: 'security-audit', name: 'Security audit' }],
      }] }));
      if (path === '/api/v1/conjur/secret-audit') return Promise.resolve(response(200, {
        available: true, packId: 'cyberark-conjur-v9', toolId: 'conjur', state: 'idle',
        target: { applianceUrl: 'https://conjur.invalid', account: 'acct' },
        total: 0, processed: 0, inspected: 0, findings: [], failures: [],
      }));
      return Promise.resolve(baseRuntimeResponse(path) ?? response(404, {}));
    }));
    render(<App />);
    const sections = screen.getByRole('navigation', { name: 'CLI sections' });
    await waitFor(() => expect(within(sections).getByRole('link', { name: /Built-in CLIs/ })).toHaveAttribute('href', '/dedicated/conjur'));
    const builtIn = within(sections).getByRole('link', { name: /Built-in CLIs/ });
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(primary).getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(within(primary).getByRole('link', { name: 'Command Builder' })).toBeInTheDocument();
    expect(within(primary).queryByText(/Built-in CLIs|Other CLIs/)).not.toBeInTheDocument();
    const otherCLI = within(sections).getByRole('link', { name: 'Other CLIs' });
    const addCLI = within(primary).getByRole('link', { name: 'Add a CLI' });
    expect(addCLI).toHaveAttribute('href', '/tools');
    expect(builtIn).toHaveAttribute('href', '/dedicated/conjur');
    expect(builtIn).not.toHaveAttribute('aria-current');
    fireEvent.click(builtIn);
    expect(window.location.pathname).toBe('/dedicated/conjur');
    expect(builtIn).toHaveAttribute('aria-current', 'page');
    fireEvent.click(otherCLI);
    expect(window.location.pathname).toBe('/tools');
    expect(otherCLI).toHaveAttribute('aria-current', 'page');
    expect(builtIn).not.toHaveAttribute('aria-current');
    fireEvent.click(addCLI);
    expect(window.location.pathname).toBe('/tools');
    expect(screen.getByRole('heading', { name: 'Add a command-line tool' })).toBeInTheDocument();
    expect(addCLI).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('main')).toHaveFocus();
    expect(screen.queryByRole('combobox', { name: 'Switch built-in CLI' })).not.toBeInTheDocument();
    expect(within(primary).getByRole('group', { name: 'Work' })).toBeInTheDocument();
    expect(within(primary).getByRole('group', { name: 'Set up & manage' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Task categories' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Sign in$/i })).not.toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).queryByRole('link', { name: /audit/i })).not.toBeInTheDocument();

    fireEvent.click(builtIn);
    expect(window.location.pathname).toBe('/dedicated/conjur');
    expect(screen.getByRole('heading', { name: 'CyberArk Conjur' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Audit' }));
    const link = screen.getByRole('button', { name: 'Regex pattern explorer' });
    fireEvent.click(link);
    expect(window.location.pathname).toBe('/dedicated/conjur/security-audit');
    expect(await screen.findByRole('heading', { name: 'Conjur pattern explorer' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveFocus();
    fireEvent.click(builtIn);
    fireEvent.click(screen.getByRole('link', { name: 'Command Builder' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Tool' }), { target: { value: 'cyberark-conjur-v9/conjur' } });
    expect(window.location.pathname).toBe('/tasks');
    expect(screen.getByRole('button', { name: 'Show all CLIs' })).toBeInTheDocument();
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: 'CyberArk Conjur' })).toHaveAttribute('href', '/dedicated/conjur');
    expect(within(breadcrumb).getByText('Command Builder · Conjur')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'List variables' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review conjur sign-in' }));
    expect(window.location.pathname).toBe('/dedicated/conjur/sign-in');
    expect(screen.getByRole('heading', { name: 'Sign in to CyberArk Conjur' })).toBeInTheDocument();
  });

  test('switching dedicated CLIs from another page opens the newly selected home', async () => {
    window.history.replaceState({}, '', '/authentication');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/platforms') return Promise.resolve(response(200, { platforms: [
        { id: 'conjur', name: 'CyberArk Conjur', summary: 'Conjur tasks.', packId: 'cyberark-conjur-v9', toolId: 'conjur',
          ready: true, features: [{ id: 'tasks', name: 'Conjur tasks' }, { id: 'sign-in', name: 'Sign in' }] },
        { id: 'acme', name: 'Acme CLI', summary: 'Acme integration.', packId: 'acme-pack', toolId: 'acme',
          ready: false, features: [] },
      ] }));
      return Promise.resolve(baseRuntimeResponse(path) ?? response(404, {}));
    }));
    render(<App />);
    const picker = await screen.findByRole('combobox', { name: 'Switch built-in CLI' });
    picker.focus();
    fireEvent.change(picker, { target: { value: 'acme' } });
    expect(window.location.pathname).toBe('/dedicated/acme');
    expect(screen.getByRole('heading', { name: 'Acme CLI' })).toBeInTheDocument();
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: 'Built-in CLIs' })).toBeInTheDocument();
    expect(within(breadcrumb).getByText('Acme CLI')).toHaveAttribute('aria-current', 'page');
    expect(picker).toHaveValue('acme');
    expect(screen.getByRole('main')).toHaveFocus();
    fireEvent.change(picker, { target: { value: 'conjur' } });
    expect(window.location.pathname).toBe('/dedicated/conjur');
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(window.location.pathname).toBe('/dedicated/acme'));
    expect(picker).toHaveValue('acme');
    fireEvent.click(screen.getByRole('link', { name: 'Overview' }));
    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('heading', { name: /get your clis ready|what would you like to do/i })).toBeInTheDocument();
  });

  test('unknown dedicated CLI links cannot silently select a different installed integration', async () => {
    window.history.replaceState({}, '', '/dedicated/missing/sign-in');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/platforms') return Promise.resolve(response(200, { platforms: [{
        id: 'conjur', name: 'CyberArk Conjur', summary: 'Conjur workflows.',
        packId: 'cyberark-conjur-v9', toolId: 'conjur', ready: true,
        features: [{ id: 'sign-in', name: 'Sign in' }],
      }] }));
      return Promise.resolve(baseRuntimeResponse(path) ?? response(404, {}));
    }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'No dedicated CLI is loaded' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in to CyberArk Conjur' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Dedicated CLIs' })).not.toBeInTheDocument();
    expect(document.title).toBe('Dedicated CLI unavailable · CLIHarbor');
    fireEvent.click(screen.getByRole('link', { name: 'Add a CLI' }));
    expect(window.location.pathname).toBe('/tools');
    fireEvent.click(within(screen.getByRole('navigation', { name: 'CLI sections' })).getByRole('link', { name: /Built-in CLIs/ }));
    expect(window.location.pathname).toBe('/dedicated/conjur');
    expect(screen.getByRole('heading', { name: 'CyberArk Conjur' })).toBeInTheDocument();
    expect(document.title).toBe('CyberArk Conjur · CLIHarbor');
  });

  test('Conjur sign-in lives in the dedicated section; generic Authentication links to it', async () => {
    window.history.replaceState({}, '', '/authentication');
    const conjurTool = {
      packId: 'cyberark-conjur-v9', packName: 'Conjur', packVersion: '0.5.0', toolId: 'conjur', status: 'ready', version: '9.3.1',
      requiresVendorSession: true, sessionCheck: { commandId: 'whoami' }, credentialLogin: { method: 'conjur-password' },
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/tools') return Promise.resolve(response(200, { tools: [conjurTool] }));
      if (path === '/api/v1/tasks') return Promise.resolve(response(200, { tasks: [
        { packId: 'cyberark-conjur-v9', packName: 'Conjur', commandId: 'whoami', name: 'Who am I', toolId: 'conjur', requiresAuth: true, inputs: [] },
      ] }));
      if (path === '/api/v1/platforms') return Promise.resolve(response(200, { platforms: [{
        id: 'conjur', name: 'CyberArk Conjur', summary: 'Built for Conjur.', packId: 'cyberark-conjur-v9', toolId: 'conjur', ready: true,
        features: [{ id: 'sign-in', name: 'Sign in' }],
      }] }));
      return Promise.resolve(baseRuntimeResponse(path) ?? response(404, {}));
    }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'CLI sessions' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open CyberArk Conjur sign-in' }));
    expect(window.location.pathname).toBe('/dedicated/conjur/sign-in');
    expect(screen.getByRole('heading', { name: 'Sign in to CyberArk Conjur' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Dedicated CLIs' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'CLI sections' })).getByRole('link', { name: /Built-in CLIs/ }))
      .toHaveAttribute('aria-current', 'page');
  });

  test('legacy Conjur audit URL still opens the dedicated audit, and the generic workspace works with no dedicated CLI', async () => {
    window.history.replaceState({}, '', '/conjur/security-audit');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(baseRuntimeResponse(requestPath(input)) ?? response(404, {}))));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Conjur pattern explorer' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Dedicated CLIs' })).not.toBeInTheDocument();
    const sections = screen.getByRole('navigation', { name: 'CLI sections' });
    expect(within(sections).getByRole('link', { name: 'Built-in CLIs' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(sections).getByRole('link', { name: 'Other CLIs' })).toHaveAttribute('href', '/tools');
    fireEvent.click(screen.getByRole('link', { name: 'Command Builder' }));
    expect(screen.getByRole('textbox', { name: 'Query' })).toBeInTheDocument();
  });

  test('task catalog filters CLIs without duplicating sidebar navigation', async () => {
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
    expect(screen.queryByRole('navigation', { name: 'Task categories' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Tool' }), { target: { value: 'beta/beta' } });
    expect(screen.getByRole('heading', { name: 'Inspect beta' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Query' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveValue('beta/beta');
    expect(screen.getByText('Showing Beta tasks')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show all CLIs' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Command Builder' }));
    expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /^Inspect beta/ }));
    fireEvent.click(screen.getByRole('link', { name: 'Diagnostics' }));
    fireEvent.click(screen.getByRole('link', { name: 'Command Builder' }));
    expect(screen.getByRole('heading', { name: 'Inspect beta' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: /^Sign in$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'CLI sessions' }));
    expect(window.location.pathname).toBe('/authentication');
    expect(screen.getByRole('heading', { name: 'CLI sessions' })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Run command' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    await act(async () => Stream.latest.dispatchEvent(new MessageEvent('run-complete', {
      data: JSON.stringify({ runId: firstID, sequence: 0, status: 'exited', exitCode: 0 }),
    })));
    fireEvent.click(screen.getByRole('button', { name: 'Run command' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Run command' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/v1/runs/preview')).toBe(false);
    expect(screen.getByRole('button', { name: 'Reset inputs' })).toBeDisabled();
    fireEvent.change(query, { target: { value: 'example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText(commandText('fixture inspect'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset inputs' }));
    expect(query).toHaveValue('');
    expect(screen.queryByText(commandText('fixture inspect'))).not.toBeInTheDocument();
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
    expect(document.title).toBe('Command Builder · CLIHarbor');
    fireEvent.click(screen.getByRole('link', { name: 'Diagnostics' }));
    expect(document.title).toBe('Diagnostics · CLIHarbor');
    expect(screen.getByRole('main')).toHaveFocus();
    window.history.replaceState({}, '', '/tasks');
    fireEvent.popState(window);
    expect(document.title).toBe('Command Builder · CLIHarbor');
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
    expect(screen.getByRole('heading', { name: 'Select tool and command' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Configure parameters' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Command preview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(query, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    expect(await screen.findByText(commandText('fixture.exe inspect --query "hello world"'))).toBeInTheDocument();
    expect(screen.getByText(/Display only\. CLIHarbor executes/i)).toBeInTheDocument();

    fireEvent.change(query, { target: { value: 'changed' } });
    expect(screen.queryByText(commandText('fixture.exe inspect --query "hello world"'))).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/v1/runs/preview')).toBe(true),
    );
    fireEvent.change(query, { target: { value: 'new value' } });
    expect(screen.getByRole('button', { name: 'Validate' })).toBeEnabled();

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
      expect(screen.queryByText(commandText('fixture.exe inspect --query "old value"'))).not.toBeInTheDocument(),
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
    fireEvent.click(screen.getByRole('button', { name: 'Run command' }));

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
  test('catalog install populates navigation and opens the new tasks without a restart', async () => {
    window.history.replaceState({}, '', '/tools');
    let installed = false;
    let submitted: unknown;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/v1/status') return Promise.resolve(response(200, { name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-install' }));
      if (path === '/api/v1/tools') return Promise.resolve(response(200, { tools: [
        { packId: 'fixture-pack', packName: 'Fixture CLI', packVersion: '1.0.0', toolId: 'fixture', status: installed ? 'ready' : 'missing',
          version: installed ? '1.2.3' : undefined, install: { version: '1.2.3', customLocation: true } },
        { packId: 'manual', packName: 'Manual tool', packVersion: '1.0.0', toolId: 'manual', status: 'missing' },
      ] }));
      if (path === '/api/v1/tasks') return Promise.resolve(response(200, { tasks: installed ? [
        { packId: 'fixture-pack', packName: 'Fixture CLI', commandId: 'inspect', name: 'Inspect newly installed CLI', toolId: 'fixture', toolVersion: '1.2.3', inputs: [] },
      ] : [] }));
      if (path === '/api/v1/tools/install' && init?.method === 'POST') {
        submitted = JSON.parse(String(init.body));
        installed = true;
        return Promise.resolve(response(200, { installed: true, version: '1.2.3', restartRequired: false, message: 'Verified CLI installed and ready. Its approved tasks are now available.' }));
      }
      return Promise.resolve(response(404, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    const search = await screen.findByRole('searchbox', { name: 'Find a CLI' });
    expect(screen.getByRole('link', { name: /Create a custom CLI pack/i })).toHaveAttribute('href', '#pack-authoring-heading');
    expect(screen.getByRole('link', { name: /Install a supported CLI/i })).toHaveAttribute('href', '#supported-cli-list');
    expect(screen.queryByRole('button', { name: 'Install Manual tool' })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'fixture' } });
    expect(screen.queryByText('Manual tool')).not.toBeInTheDocument();
    const install = screen.getByRole('button', { name: 'Install Fixture CLI' });
    fireEvent.click(install);
    fireEvent.click(install);
    const openTasks = await screen.findByRole('button', { name: 'Open 1 task' });
    expect(submitted).toEqual({ packId: 'fixture-pack', toolId: 'fixture' });
    expect(fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/v1/tools/install')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Install Fixture CLI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Task categories' })).not.toBeInTheDocument();
    fireEvent.click(openTasks);
    expect(window.location.pathname).toBe('/tasks');
    expect(screen.getByRole('heading', { name: 'Inspect newly installed CLI' })).toBeInTheDocument();
  });

  test('failed installations keep the CLI unavailable and show a retryable error', async () => {
    window.history.replaceState({}, '', '/tools');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/v1/tools') return Promise.resolve(response(200, { tools: [
        { packId: 'fixture', packName: 'Fixture CLI', packVersion: '1.0.0', toolId: 'fixture', status: 'missing', install: { version: '1.2.3', customLocation: true } },
      ] }));
      if (path === '/api/v1/tools/install') return Promise.resolve(response(503, { error: {
        code: 'tool_unavailable', category: 'discovery', message: 'Tool installation could not be verified.', retryable: true,
      } }));
      if (path === '/api/v1/tasks') return Promise.resolve(response(200, { tasks: [] }));
      return Promise.resolve(baseRuntimeResponse(path) ?? response(404, {}));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install Fixture CLI' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tool installation could not be verified.');
    expect(screen.getByRole('button', { name: 'Install Fixture CLI' })).toBeEnabled();
    expect(screen.queryByRole('navigation', { name: 'Task categories' })).not.toBeInTheDocument();
  });

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
