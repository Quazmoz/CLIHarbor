import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const bootstrapURL = process.env.CLIHARBOR_E2E_BOOTSTRAP_URL;
if (!bootstrapURL) {
  throw new Error('missing CLIHARBOR_E2E_BOOTSTRAP_URL');
}
if (typeof WebSocket !== 'function') {
  throw new Error('this E2E harness requires the built-in WebSocket available in Node 24');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = (name) => console.log('E2E stage: ' + name);

function assertRequestForbidden(body, label) {
  const payload = JSON.parse(body);
  assert.equal(payload?.error?.code, 'request_forbidden', label + ' must use the stable security error code');
  assert.equal(payload?.error?.category, 'security', label + ' must use the security category');
  assert.equal(payload?.error?.retryable, false, label + ' must not invite automatic retry');
  assert.equal(typeof payload?.error?.message, 'string', label + ' must include reviewed operator text');
  assert.equal(typeof payload?.error?.remediation, 'string', label + ' must include reviewed remediation');
  assert.doesNotMatch(body, /forbidden host|invalid CSRF token/i, label + ' must not expose internal boundary causes');
}

async function closeHTTPServer(server, timeoutMs = 2000) {
  if (!server.listening) {
    return;
  }
  const closed = new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await Promise.race([
    closed,
    delay(timeoutMs).then(() => {
      throw new Error('attacker HTTP server did not close within test bound');
    }),
  ]);
}

async function poll(label, fn, timeoutMs = 10000, intervalMs = 75) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  if (lastError) {
    throw new Error(label + ' timed out: ' + lastError.message);
  }
  throw new Error(label + ' timed out');
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string' || !Number.isInteger(address.port) || address.port <= 0) {
    await closeHTTPServer(server);
    throw new Error('could not reserve a loopback DevTools port');
  }
  const port = address.port;
  await closeHTTPServer(server);
  return port;
}

function findChrome() {
  const explicit = process.env.CLIHARBOR_E2E_CHROME;
  if (explicit) {
    return explicit;
  }
  for (const candidate of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) {
      return found.stdout.trim();
    }
  }
  throw new Error('Chrome/Chromium was not found; set CLIHARBOR_E2E_CHROME');
}

class CDP {
  constructor(wsURL) {
    this.ws = new WebSocket(wsURL);
    this.nextID = 1;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket failed to open')), { once: true });
    });
    this.ws.addEventListener('message', (event) => this.onMessage(event));
    this.ws.addEventListener('close', () => this.onClose());
  }

  async ready() {
    await this.opened;
  }

  onMessage(event) {
    let raw;
    if (typeof event.data === 'string') {
      raw = event.data;
    } else if (event.data instanceof ArrayBuffer) {
      raw = Buffer.from(event.data).toString('utf8');
    } else {
      raw = Buffer.from(event.data).toString('utf8');
    }
    const message = JSON.parse(raw);
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error('CDP ' + message.error.code + ': ' + message.error.message));
        } else {
          pending.resolve(message.result ?? {});
        }
      }
      return;
    }
    for (let index = 0; index < this.waiters.length; index += 1) {
      const waiter = this.waiters[index];
      if (waiter.method === message.method && waiter.predicate(message.params ?? {})) {
        this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message.params ?? {});
        return;
      }
    }
    this.events.push(message);
    if (this.events.length > 6000) {
      this.events.shift();
    }
  }

  onClose() {
    const error = new Error('CDP websocket closed');
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }

  async call(method, params = {}, timeoutMs = 15000) {
    await this.ready();
    const id = this.nextID++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error('CDP command timed out: ' + method));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return result;
  }

  waitEvent(method, predicate = () => true, timeoutMs = 15000) {
    for (let index = 0; index < this.events.length; index += 1) {
      const event = this.events[index];
      if (event.method === method && predicate(event.params ?? {})) {
        this.events.splice(index, 1);
        return Promise.resolve(event.params ?? {});
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error('CDP event timed out: ' + method));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async evaluate(expression, timeoutMs = 15000) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'JavaScript evaluation failed';
      throw new Error(detail);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Best-effort test cleanup.
    }
  }
}

class ChromeHarness {
  constructor(chrome, userDataDir, processHandle) {
    this.chrome = chrome;
    this.userDataDir = userDataDir;
    this.process = processHandle;
    this.port = undefined;
    this.stderr = '';
    processHandle.stderr?.on('data', (chunk) => {
      this.stderr += chunk.toString();
      if (this.stderr.length > 12000) {
        this.stderr = this.stderr.slice(-12000);
      }
    });
  }

  static async start() {
    const chrome = findChrome();
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'cliharbor-browser-e2e-'));
    const port = await reserveLoopbackPort();
    const args = [
      '--headless=new',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + userDataDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-sync',
      'about:blank',
    ];
    const processHandle = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const harness = new ChromeHarness(chrome, userDataDir, processHandle);
    harness.port = port;
    processHandle.once('exit', (code, signal) => {
      harness.exit = { code, signal };
    });

    try {
      await poll('Chrome DevTools endpoint', async () => {
        if (harness.exit) {
          throw new Error('Chrome exited before DevTools became ready');
        }
        try {
          const response = await fetch('http://127.0.0.1:' + port + '/json/version');
          if (!response.ok) {
            return false;
          }
          const payload = await response.json();
          return typeof payload?.webSocketDebuggerUrl === 'string' && payload.webSocketDebuggerUrl.length > 0;
        } catch {
          return false;
        }
      }, 15000, 50);
      return harness;
    } catch (error) {
      const stderr = harness.stderr.trim();
      await harness.close();
      const detail = stderr ? '\nChrome stderr (bounded):\n' + stderr : '';
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message + detail);
    }
  }

  async newPage(url = 'about:blank') {
    const response = await fetch('http://127.0.0.1:' + this.port + '/json/new?' + encodeURIComponent(url), {
      method: 'PUT',
    });
    if (!response.ok) {
      throw new Error('Chrome target creation failed with HTTP ' + response.status);
    }
    const target = await response.json();
    const cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready();
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    await cdp.call('Network.enable', { maxTotalBufferSize: 8 << 20, maxResourceBufferSize: 2 << 20 });
    return cdp;
  }

  async close() {
    if (!this.exit) {
      this.process.kill('SIGTERM');
      await Promise.race([once(this.process, 'exit'), delay(1500)]);
    }
    if (!this.exit) {
      this.process.kill('SIGKILL');
      await Promise.race([once(this.process, 'exit'), delay(1500)]);
    }
    await delay(250);
    await rm(this.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
}

function isRunCreateRequest(params, commandID) {
  if (params.request?.url === undefined || params.request.url !== new URL('/api/v1/runs', bootstrapURL).href) {
    return false;
  }
  if (params.request.method !== 'POST' || typeof params.request.postData !== 'string') {
    return false;
  }
  try {
    const body = JSON.parse(params.request.postData);
    return body?.packId === 'integration' && body?.commandId === commandID;
  } catch {
    return false;
  }
}

function headerValue(headers, name) {
  if (!headers) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return String(value);
    }
  }
  return undefined;
}

async function waitHTTPStatus(page, requestId, timeoutMs = 15000) {
  const extra = await page.waitEvent('Network.responseReceivedExtraInfo',
    (params) => params.requestId === requestId, timeoutMs);
  return extra.statusCode;
}

async function navigate(page, url) {
  await page.call('Page.navigate', { url });
}

async function waitJS(page, label, expression, timeoutMs = 10000) {
  return poll(label, async () => Boolean(await page.evaluate(expression)), timeoutMs, 75);
}

async function chooseTask(page, value) {
  const expression = '(() => {' +
    'const select = Array.from(document.querySelectorAll("select")).find((element) => element.closest("label")?.querySelector("span")?.textContent === "Available task");' +
    'if (!select) return false;' +
    'const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;' +
    'setter.call(select, ' + JSON.stringify(value) + ');' +
    'select.dispatchEvent(new Event("change", { bubbles: true }));' +
    'return select.value === ' + JSON.stringify(value) + ';' +
  '})()';
  assert.equal(await page.evaluate(expression), true, 'task selector should accept the requested fixture task');
}

async function setTextInput(page, label, value) {
  const expression = '(() => {' +
    'const input = Array.from(document.querySelectorAll("input")).find((element) => element.closest("label")?.querySelector("span")?.textContent === ' + JSON.stringify(label) + ');' +
    'if (!input) return false;' +
    'const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;' +
    'setter.call(input, ' + JSON.stringify(value) + ');' +
    'input.dispatchEvent(new Event("input", { bubbles: true }));' +
    'input.dispatchEvent(new Event("change", { bubbles: true }));' +
    'return input.value === ' + JSON.stringify(value) + ';' +
  '})()';
  assert.equal(await page.evaluate(expression), true, 'fixture text input should accept the test value');
}

async function clickButton(page, text) {
  const expression = '(() => {' +
    'const button = Array.from(document.querySelectorAll("button")).find((element) => element.textContent?.trim() === ' + JSON.stringify(text) + ');' +
    'if (!button || button.disabled) return false;' +
    'button.click();' +
    'return true;' +
  '})()';
  assert.equal(await page.evaluate(expression), true, 'expected enabled button: ' + text);
}

async function fetchJSON(page, relativeURL) {
  return page.evaluate('(async () => {' +
    'const response = await fetch(' + JSON.stringify(relativeURL) + ', { credentials: "same-origin" });' +
    'return { status: response.status, body: await response.json() };' +
  '})()');
}

async function main() {
  const parsedBootstrap = new URL(bootstrapURL);
  const baseURL = parsedBootstrap.origin;
  const eventPath = (runID) => '/api/v1/runs/' + encodeURIComponent(runID) + '/events';
  const chrome = await ChromeHarness.start();
  let attackerServer;
  const pages = [];

  try {
    const page = await chrome.newPage();
    pages.push(page);

    stage('bootstrap and authenticated shell');
    await navigate(page, bootstrapURL);

    await waitJS(page, 'clean authenticated application page',
      'location.href === ' + JSON.stringify(baseURL + '/') + ' && document.body.innerText.includes("CLIHarbor")');
    await waitJS(page, 'fixture task metadata',
      "Boolean(document.querySelector('select option[value=\\\"integration/inspect\\\"]'))");

    const bootstrapState = await page.evaluate('(async () => {' +
      'const status = await fetch("/api/v1/status", { credentials: "same-origin" }).then((response) => response.json());' +
      'const stored = Object.keys(localStorage).concat(Object.keys(sessionStorage)).map((key) => String(localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? ""));' +
      'return {' +
        'href: location.href,' +
        'cookieVisible: document.cookie.includes("cliharbor_session"),' +
        'csrfInDOM: document.body.innerText.includes(status.csrfToken),' +
        'csrfInStorage: stored.some((value) => value.includes(status.csrfToken))' +
      '};' +
    '})()');
    assert.equal(bootstrapState.href, baseURL + '/');
    assert.equal(bootstrapState.cookieVisible, false, 'session cookie must remain HttpOnly');
    assert.equal(bootstrapState.csrfInDOM, false, 'CSRF token must not render into the document');
    assert.equal(bootstrapState.csrfInStorage, false, 'CSRF token must not enter browser storage');

    stage('bootstrap replay');
    const replay = await chrome.newPage();
    pages.push(replay);
    const replayResponse = replay.waitEvent('Network.responseReceived',
      (params) => params.response?.url?.startsWith(baseURL + '/bootstrap?'));
    await navigate(replay, bootstrapURL);
    assert.equal((await replayResponse).response.status, 410, 'bootstrap token replay must fail closed');

    stage('host and csrf rejection');
    const hostProbe = await chrome.newPage();
    pages.push(hostProbe);
    const hostileHostURL = 'http://localhost:' + parsedBootstrap.port + '/api/v1/status';
    const hostResponse = hostProbe.waitEvent('Network.responseReceived',
      (params) => params.response?.url === hostileHostURL);
    await navigate(hostProbe, hostileHostURL);
    assert.equal((await hostResponse).response.status, 403, 'alternate Host must be rejected');
    const hostBody = await poll('typed forbidden-host body', async () => {
      const body = await hostProbe.evaluate('document.body.innerText');
      return body.includes('"request_forbidden"') ? body : '';
    });
    assertRequestForbidden(hostBody, 'alternate Host rejection');

    const csrfProbe = await page.evaluate('(async () => {' +
      'const response = await fetch("/api/v1/runs", {' +
        'method: "POST",' +
        'credentials: "same-origin",' +
        'headers: { "Content-Type": "application/json" },' +
        'body: "{}"' +
      '});' +
      'return { status: response.status, body: await response.text() };' +
    '})()');
    assert.equal(csrfProbe.status, 403);
    assertRequestForbidden(csrfProbe.body, 'missing CSRF rejection');

    stage('typed fixture execution and inert rendering');
    await chooseTask(page, 'integration/inspect');
    await waitJS(page, 'inspect query field',
      'Array.from(document.querySelectorAll("input")).some((element) => element.closest("label")?.querySelector("span")?.textContent === "Query")');
    const hostileOutput = '<img id="cliharbor-e2e-pwn" src=x onerror="document.body.dataset.cliharborE2EPwned=1">\u001b[31m';
    await setTextInput(page, 'Query', hostileOutput);

    const createRequestPromise = page.waitEvent('Network.requestWillBeSent',
      (params) => isRunCreateRequest(params, 'inspect'));
    await clickButton(page, 'Run task');
    const createRequest = await createRequestPromise;
    const submitted = JSON.parse(createRequest.request.postData);
    assert.deepEqual(Object.keys(submitted).sort(), ['commandId', 'packId', 'values']);
    assert.equal(submitted.packId, 'integration');
    assert.equal(submitted.commandId, 'inspect');
    assert.deepEqual(Object.keys(submitted.values).sort(), ['mode', 'query', 'verbose']);
    assert.equal(submitted.values.query, hostileOutput);
    assert.equal(submitted.values.mode, 'safe');
    assert.equal(submitted.values.verbose, false);
    for (const forbidden of ['executable', 'argv', 'arguments', 'path', 'commandLine']) {
      assert.equal(Object.prototype.hasOwnProperty.call(submitted, forbidden), false, 'browser request must not select execution authority');
    }

    await waitJS(page, 'fixture run completion', 'document.querySelector(".run-panel h2")?.textContent?.trim() === "exited"');
    const firstRunID = await page.evaluate('document.querySelector(".run-meta dd")?.textContent?.trim()');
    assert.match(firstRunID, /^[0-9a-f]{32}$/);

    const rendered = await page.evaluate('(() => {' +
      'const stdout = Array.from(document.querySelectorAll(".output-grid section")).find((section) => section.querySelector("h3")?.textContent === "stdout")?.querySelector("pre")?.textContent ?? "";' +
      'return {' +
        'stdout,' +
        'injectedElement: Boolean(document.getElementById("cliharbor-e2e-pwn")),' +
        'handlerRan: document.body.dataset.cliharborE2EPwned === "1"' +
      '};' +
    '})()');
    assert.ok(rendered.stdout.includes(hostileOutput), 'hostile markup/control-like output should remain visible as text');
    assert.equal(rendered.injectedElement, false, 'hostile output must not become DOM');
    assert.equal(rendered.handlerRan, false, 'hostile output event handlers must never execute');

    const firstSnapshot = await fetchJSON(page, '/api/v1/runs/' + firstRunID);
    assert.equal(firstSnapshot.status, 200);
    assert.equal(firstSnapshot.body.status, 'exited');
    assert.equal(firstSnapshot.body.events.filter((event) => event.type === 'run.started').length, 1, 'fixture process must execute once');
    const serializedSnapshot = JSON.stringify(firstSnapshot.body).toLowerCase();
    assert.equal(serializedSnapshot.includes('"executable"'), false);
    assert.equal(serializedSnapshot.includes('"argv"'), false);

    const replayResult = await page.evaluate('(async () => {' +
      'const response = await fetch(' + JSON.stringify(eventPath(firstRunID)) + ', {' +
        'credentials: "same-origin",' +
        'headers: { "Last-Event-ID": "1" }' +
      '});' +
      'return { status: response.status, text: await response.text() };' +
    '})()');
    assert.equal(replayResult.status, 200);
    assert.equal(replayResult.text.includes('id: 1\n'), false, 'SSE replay must start after the supplied cursor');
    assert.match(replayResult.text, /event: run-complete/);

    const impossibleCursor = await page.evaluate('(async () => {' +
      'const response = await fetch(' + JSON.stringify(eventPath(firstRunID)) + ', {' +
        'credentials: "same-origin",' +
        'headers: { "Last-Event-ID": "999999" }' +
      '});' +
      'return { status: response.status, text: await response.text() };' +
    '})()');
    assert.equal(impossibleCursor.status, 400);
    assert.match(impossibleCursor.text, /invalid_cursor/);

    stage('browser native sse reconnect cursor');
    const reconnectProbeURL = baseURL + eventPath(firstRunID);
    const reconnectProbeInitialPromise = page.waitEvent('Network.requestWillBeSent',
      (params) => params.request?.url === reconnectProbeURL && params.request?.method === 'GET');
    await page.evaluate('window.__cliharborReconnectProbe = new EventSource(' +
      JSON.stringify(eventPath(firstRunID)) + '); true');
    const reconnectProbeInitial = await reconnectProbeInitialPromise;
    const reconnectProbeRequest = await page.waitEvent('Network.requestWillBeSent',
      (params) => params.request?.url === reconnectProbeURL &&
        params.request?.method === 'GET' && params.requestId !== reconnectProbeInitial.requestId,
      10000);
    let reconnectProbeLastEventID = headerValue(reconnectProbeRequest.request.headers, 'Last-Event-ID');
    if (!reconnectProbeLastEventID) {
      const extra = await page.waitEvent('Network.requestWillBeSentExtraInfo',
        (params) => params.requestId === reconnectProbeRequest.requestId, 3000);
      reconnectProbeLastEventID = headerValue(extra.headers, 'Last-Event-ID');
    }
    assert.ok(reconnectProbeLastEventID && Number(reconnectProbeLastEventID) >= 1,
      'browser-native EventSource reconnect must carry the last observed SSE event ID');
    await page.evaluate('window.__cliharborReconnectProbe.close(); true');

    stage('hostile origin rejection');
    attackerServer = http.createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end('<!doctype html><title>attacker origin</title><body>attacker origin</body>');
    });
    attackerServer.listen(0, '127.0.0.1');
    await once(attackerServer, 'listening');
    const attackerAddress = attackerServer.address();
    const attackerOrigin = 'http://127.0.0.1:' + attackerAddress.port;

    const attacker = await chrome.newPage();
    pages.push(attacker);
    await navigate(attacker, attackerOrigin + '/');
    await waitJS(attacker, 'attacker page', 'document.body.innerText.includes("attacker origin")');

    const hostileStreamURL = baseURL + eventPath(firstRunID);
    const hostileStreamRequest = attacker.waitEvent('Network.requestWillBeSent',
      (params) => params.request?.url === hostileStreamURL && params.request?.method === 'GET');
    await attacker.evaluate('window.__cliharborAttackStream = new EventSource(' +
      JSON.stringify(hostileStreamURL) + ', { withCredentials: true }); true');
    const hostileStream = await hostileStreamRequest;
    assert.equal(await waitHTTPStatus(attacker, hostileStream.requestId), 403,
      'hostile-origin EventSource must be rejected');

    const hostileMutationURL = baseURL + '/api/v1/runs';
    const hostileMutationRequest = attacker.waitEvent('Network.requestWillBeSent',
      (params) => params.request?.url === hostileMutationURL && params.request?.method === 'POST');
    await attacker.evaluate('(() => {' +
      'const frame = document.createElement("iframe"); frame.name = "cliharbor_attack_frame"; document.body.appendChild(frame);' +
      'const form = document.createElement("form"); form.method = "POST"; form.action = ' + JSON.stringify(hostileMutationURL) + '; form.target = frame.name;' +
      'document.body.appendChild(form); form.submit(); return true;' +
    '})()');
    const hostileMutation = await hostileMutationRequest;
    assert.equal(await waitHTTPStatus(attacker, hostileMutation.requestId), 403,
      'hostile-origin mutation must be rejected');

    stage('sse failure reconciliation and cancellation');
    const eventSourceTrackerInstalled = await page.evaluate('(() => {' +
      'if (window.__cliharborNativeEventSource) return true;' +
      'const NativeEventSource = window.EventSource;' +
      'window.__cliharborNativeEventSource = NativeEventSource;' +
      'window.__cliharborE2ESources = [];' +
      'function TrackedEventSource(...args) {' +
        'const source = new NativeEventSource(...args);' +
        'window.__cliharborE2ESources.push(source);' +
        'return source;' +
      '}' +
      'TrackedEventSource.prototype = NativeEventSource.prototype;' +
      'Object.setPrototypeOf(TrackedEventSource, NativeEventSource);' +
      'window.EventSource = TrackedEventSource;' +
      'return true;' +
    '})()');
    assert.equal(eventSourceTrackerInstalled, true);

    await chooseTask(page, 'integration/wait');
    const waitCreateRequest = page.waitEvent('Network.requestWillBeSent',
      (params) => isRunCreateRequest(params, 'wait'));
    await clickButton(page, 'Run task');
    await waitCreateRequest;
    await waitJS(page, 'wait fixture running', 'document.querySelector(".run-panel h2")?.textContent?.trim() === "running"');
    const waitRunID = await page.evaluate('document.querySelector(".run-meta dd")?.textContent?.trim()');
    assert.match(waitRunID, /^[0-9a-f]{32}$/);
    await waitJS(page, 'wait fixture observable output',
      'Array.from(document.querySelectorAll(".output-grid pre")).some((element) => element.textContent?.includes("ready"))');

    const waitEventsURL = baseURL + eventPath(waitRunID);
    const initialStreamRequest = await page.waitEvent('Network.requestWillBeSent',
      (params) => params.request?.url === waitEventsURL && params.request?.method === 'GET');
    await page.waitEvent('Network.responseReceived',
      (params) => params.requestId === initialStreamRequest.requestId && params.response?.status === 200);

    const reconciliationRequest = page.waitEvent('Network.requestWillBeSent',
      (params) => params.request?.url === baseURL + '/api/v1/runs/' + waitRunID && params.request?.method === 'GET',
      5000);
    const forcedStreamFailure = await page.evaluate('(() => {' +
      'const sources = window.__cliharborE2ESources ?? [];' +
      'const source = sources[sources.length - 1];' +
      'if (!source) return false;' +
      'source.close();' +
      'for (let index = 0; index < 5; index += 1) source.dispatchEvent(new Event("error"));' +
      'return true;' +
    '})()');
    assert.equal(forcedStreamFailure, true, 'tracked live EventSource should be interruptible by the harness');

    await waitJS(page, 'bounded EventSource retry exhaustion',
      'Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Retry live stream")',
      5000);
    assert.equal((await reconciliationRequest).request.url, baseURL + '/api/v1/runs/' + waitRunID);

    const reconciled = await fetchJSON(page, '/api/v1/runs/' + waitRunID);
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.status, 'running');
    assert.equal(reconciled.body.events.filter((event) => event.type === 'run.started').length, 1, 'stream recovery must not duplicate execution');

    const retriedStream = page.waitEvent('Network.responseReceived',
      (params) => params.response?.url === waitEventsURL && params.response?.status === 200, 8000);
    await clickButton(page, 'Retry live stream');
    await retriedStream;

    await clickButton(page, 'Cancel run');
    await waitJS(page, 'explicit run cancellation', 'document.querySelector(".run-panel h2")?.textContent?.trim() === "cancelled"', 8000);
    const cancelled = await fetchJSON(page, '/api/v1/runs/' + waitRunID);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(cancelled.body.events.filter((event) => event.type === 'run.started').length, 1, 'cancellation/reconnect must preserve single execution');

    stage('retained run eviction');
    const eviction = await page.evaluate('(async () => {' +
      'const status = await fetch("/api/v1/status", { credentials: "same-origin" }).then((response) => response.json());' +
      'const ids = [];' +
      'for (let index = 0; index < 33; index += 1) {' +
        'const createdResponse = await fetch("/api/v1/runs", {' +
          'method: "POST",' +
          'credentials: "same-origin",' +
          'headers: { "Content-Type": "application/json", "X-CLIHarbor-CSRF": status.csrfToken },' +
          'body: JSON.stringify({ packId: "integration", commandId: "inspect", values: { query: "evict-" + index, verbose: false, mode: "safe" } })' +
        '});' +
        'if (createdResponse.status !== 202) return { error: "create-" + createdResponse.status };' +
        'const created = await createdResponse.json(); ids.push(created.runId);' +
        'let finished = false;' +
        'for (let attempt = 0; attempt < 200; attempt += 1) {' +
          'const response = await fetch("/api/v1/runs/" + created.runId, { credentials: "same-origin" });' +
          'if (response.status !== 200) return { error: "poll-" + response.status };' +
          'const snapshot = await response.json();' +
          'if (snapshot.status !== "running") { finished = true; break; }' +
          'await new Promise((resolve) => setTimeout(resolve, 10));' +
        '}' +
        'if (!finished) return { error: "poll-timeout" };' +
      '}' +
      'const first = await fetch("/api/v1/runs/' + firstRunID + '", { credentials: "same-origin" });' +
      'return { error: "", firstStatus: first.status, created: ids.length };' +
    '})()', 45000);
    assert.equal(eviction.error, '');
    assert.equal(eviction.created, 33);
    assert.equal(eviction.firstStatus, 404, 'oldest completed run must be evicted at the bounded retention limit');

    stage('complete');
    console.log('CLIHarbor production browser E2E passed');
  } finally {
    for (const page of pages) {
      page.close();
    }
    // The attacker page may keep an HTTP connection open after its CDP socket is closed.
    // Terminate Chrome before awaiting the local attacker server so cleanup cannot deadlock
    // and hide the assertion that actually failed.
    await chrome.close();
    if (attackerServer) {
      await closeHTTPServer(attackerServer);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
