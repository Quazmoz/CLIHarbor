import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
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
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      '--user-data-dir=' + userDataDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      'about:blank',
    ];
    const processHandle = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const harness = new ChromeHarness(chrome, userDataDir, processHandle);
    processHandle.once('exit', (code, signal) => {
      harness.exit = { code, signal };
    });

    const activePortPath = path.join(userDataDir, 'DevToolsActivePort');
    const active = await poll('Chrome DevTools port', async () => {
      if (harness.exit) {
        throw new Error('Chrome exited before DevTools became ready');
      }
      try {
        const text = await readFile(activePortPath, 'utf8');
        const lines = text.trim().split(/\r?\n/);
        const port = Number(lines[0]);
        return Number.isInteger(port) && port > 0 ? port : false;
      } catch {
        return false;
      }
    }, 10000, 50);
    harness.port = active;
    return harness;
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
    await waitJS(hostProbe, 'forbidden-host body', 'document.body.innerText.includes("forbidden host")');

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
    assert.match(csrfProbe.body, /invalid CSRF token/);

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
    const hostileStreamResponse = attacker.waitEvent('Network.responseReceived',
      (params) => params.response?.url === hostileStreamURL);
    await attacker.evaluate('window.__cliharborAttackStream = new EventSource(' +
      JSON.stringify(hostileStreamURL) + ', { withCredentials: true }); true');
    assert.equal((await hostileStreamResponse).response.status, 403, 'hostile-origin EventSource must be rejected');

    const hostileMutationResponse = attacker.waitEvent('Network.responseReceived',
      (params) => params.response?.url === baseURL + '/api/v1/runs' && params.response?.status === 403);
    await attacker.evaluate('(() => {' +
      'const frame = document.createElement("iframe"); frame.name = "cliharbor_attack_frame"; document.body.appendChild(frame);' +
      'const form = document.createElement("form"); form.method = "POST"; form.action = ' + JSON.stringify(baseURL + '/api/v1/runs') + '; form.target = frame.name;' +
      'document.body.appendChild(form); form.submit(); return true;' +
    '})()');
    assert.equal((await hostileMutationResponse).response.status, 403, 'hostile-origin mutation must be rejected');

    stage('sse reconnect reconciliation and cancellation');
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

    await page.call('Network.setBlockedURLs', { urls: ['*://*/api/v1/runs/*/events'] });
    await page.call('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await page.waitEvent('Network.loadingFailed',
      (params) => params.requestId === initialStreamRequest.requestId, 8000);
    await page.call('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    const reconnectRequest = await page.waitEvent('Network.requestWillBeSent',
      (params) => params.request?.url === waitEventsURL && params.requestId !== initialStreamRequest.requestId, 10000);
    let lastEventID = headerValue(reconnectRequest.request.headers, 'Last-Event-ID');
    if (!lastEventID) {
      try {
        const extra = await page.waitEvent('Network.requestWillBeSentExtraInfo',
          (params) => params.requestId === reconnectRequest.requestId, 2000);
        lastEventID = headerValue(extra.headers, 'Last-Event-ID');
      } catch {
        // requestWillBeSent is authoritative when blocked requests do not emit ExtraInfo.
      }
    }
    assert.ok(lastEventID && Number(lastEventID) >= 1, 'browser reconnect must replay from its last observed SSE event ID');

    await waitJS(page, 'bounded EventSource retry exhaustion',
      'Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Retry live stream")',
      20000);
    const reconciliationRequest = await page.waitEvent('Network.requestWillBeSent',
      (params) => params.request?.url === baseURL + '/api/v1/runs/' + waitRunID && params.request?.method === 'GET',
      5000);
    assert.equal(reconciliationRequest.request.url, baseURL + '/api/v1/runs/' + waitRunID);

    const reconciled = await fetchJSON(page, '/api/v1/runs/' + waitRunID);
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.status, 'running');
    assert.equal(reconciled.body.events.filter((event) => event.type === 'run.started').length, 1, 'stream retries must not duplicate execution');

    await page.call('Network.setBlockedURLs', { urls: [] });
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
    if (attackerServer) {
      attackerServer.close();
      await once(attackerServer, 'close').catch(() => undefined);
    }
    await chrome.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
