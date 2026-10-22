// Shared, fail-loud fake of the CLIHarbor loopback API for component tests.
//
// Why this exists: tests previously hand-rolled a `fetch` stub per file and
// answered any unexpected route with a silent 404. A component that started
// calling a new or misspelled endpoint then rendered an error state the test
// never asserted on, and still passed. This kit records every request, and any
// request no route answers fails the test in afterEach (see setup.ts).
import { vi } from 'vitest';
import type { RuntimeStatus } from '../api/status';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RecordedRequest {
  method: HttpMethod;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  /** Parsed JSON body, or the raw string when it is not JSON, or undefined. */
  body: unknown;
}

export interface RouteReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type RouteHandler = (request: RecordedRequest) => RouteReply | Response | Promise<RouteReply | Response>;

/** A route key is "METHOD /path" ("GET /api/v1/tasks"); a bare "/path" means GET. */
export type RouteTable = Record<string, RouteHandler | RouteReply>;

export const TEST_CSRF_TOKEN = 'test-csrf';

export const defaultStatus: RuntimeStatus = {
  name: 'CLIHarbor',
  version: 'test',
  session: 'active',
  csrfToken: TEST_CSRF_TOKEN,
};

/** The routes App needs to boot into an empty, healthy runtime. */
export function bootRoutes(overrides: { status?: Partial<RuntimeStatus>; tasks?: unknown[]; tools?: unknown[]; runs?: unknown[] } = {}): RouteTable {
  return {
    'GET /api/v1/status': { body: { ...defaultStatus, ...overrides.status } },
    'GET /api/v1/tasks': { body: { tasks: overrides.tasks ?? [] } },
    'GET /api/v1/tools': { body: { tools: overrides.tools ?? [] } },
    'GET /api/v1/runs': { body: { runs: overrides.runs ?? [] } },
  };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function normalizeKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.startsWith('/') ? routeKey('GET', trimmed) : trimmed.replace(/^(\w+)\s+/, (_m, verb: string) => `${verb.toUpperCase()} `);
}

function toURL(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input, 'http://127.0.0.1');
  return new URL(input.url, 'http://127.0.0.1');
}

function parseBody(raw: BodyInit | null | undefined): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class FakeBackend {
  readonly requests: RecordedRequest[] = [];
  readonly unhandled: string[] = [];
  private readonly routes = new Map<string, RouteHandler | RouteReply>();

  constructor(routes: RouteTable = {}) {
    this.on(routes);
  }

  /** Add or replace routes. Later calls win, so a test can override bootRoutes(). */
  on(routes: RouteTable): this {
    for (const [key, handler] of Object.entries(routes)) {
      this.routes.set(normalizeKey(key), handler);
    }
    return this;
  }

  /** Requests to one route, in order. */
  calls(key: string): RecordedRequest[] {
    const [method, path] = normalizeKey(key).split(' ');
    return this.requests.filter((request) => request.method === method && request.path === path);
  }

  /** JSON bodies sent to one route, in order. */
  bodies(key: string): unknown[] {
    return this.calls(key).map((request) => request.body);
  }

  readonly fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = toURL(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() as HttpMethod;
    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    const request: RecordedRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: parseBody(init?.body),
    };
    this.requests.push(request);
    const handler = this.routes.get(routeKey(method, url.pathname));
    if (!handler) {
      this.unhandled.push(routeKey(method, url.pathname + url.search));
      // Still answer, so the component settles; afterEach turns this into a failure.
      return jsonResponse(599, { error: { code: 'unhandled_test_route' } });
    }
    const reply = typeof handler === 'function' ? await handler(request) : handler;
    if (reply instanceof Response) return reply;
    return jsonResponse(reply.status ?? 200, reply.body, reply.headers);
  });
}

export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  static get latest(): FakeEventSource | undefined {
    return FakeEventSource.instances.at(-1);
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }

  readonly url: string;
  readonly withCredentials = false;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const fn: EventListener = typeof listener === 'function' ? listener : (event) => listener.handleEvent(event);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === 'function') this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver a named SSE event with a JSON payload. Ignored after close(), as in a browser. */
  emit(type: string, body: unknown): void {
    if (this.closed) return;
    const event = new MessageEvent(type, { data: JSON.stringify(body) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    if (type === 'message') this.onmessage?.(event);
  }

  open(): void {
    if (!this.closed) this.onopen?.(new Event('open'));
  }

  fail(): void {
    if (!this.closed) this.onerror?.(new Event('error'));
  }
}

let active: FakeBackend | undefined;

/**
 * Install a fail-loud backend as the global fetch (and EventSource) for the
 * current test. setup.ts verifies and uninstalls it after each test.
 */
export function installFakeBackend(routes: RouteTable = {}): FakeBackend {
  const backend = new FakeBackend(routes);
  active = backend;
  vi.stubGlobal('fetch', backend.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  return backend;
}

/** Called from setup.ts. Throws when the test made requests no route answered. */
export function verifyAndResetFakeBackend(): void {
  const backend = active;
  active = undefined;
  FakeEventSource.reset();
  if (backend && backend.unhandled.length > 0) {
    throw new Error(
      `Unhandled API request(s) in test:\n  ${backend.unhandled.join('\n  ')}\n` +
        'Add a route to installFakeBackend(...) or backend.on(...) for each endpoint the component is expected to call.',
    );
  }
}
