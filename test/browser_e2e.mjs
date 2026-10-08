import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseDevToolsActivePort } from './browser_harness_helpers.mjs';

const bootstrapURL = process.env.CLIHARBOR_E2E_BOOTSTRAP_URL;
if (!bootstrapURL) {
  throw new Error('missing CLIHARBOR_E2E_BOOTSTRAP_URL');
}
const conjurURL = process.env.CLIHARBOR_E2E_CONJUR_URL;
const conjurIdentity = process.env.CLIHARBOR_E2E_CONJUR_IDENTITY;
const conjurSecret = process.env.CLIHARBOR_E2E_CONJUR_SECRET;
if (!conjurURL || !conjurIdentity || !conjurSecret) {
  throw new Error('missing hermetic Conjur browser E2E configuration');
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

function findChrome() {
  const explicit = process.env.CLIHARBOR_E2E_CHROME;
  if (explicit) {
    return explicit;
  }
  for (const candidate of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ]) {
    if (process.platform === 'darwin' && existsSync(candidate)) {
      return candidate;
    }
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
        const failures = this.events
          .filter((event) => event.method === 'Network.loadingFailed')
          .map((event) => event.params?.errorText ?? 'unknown');
        reject(new Error('CDP event timed out: ' + method + '; network failures: ' + failures.join(', ')));
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
    const failures = [];
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await ChromeHarness.startAttempt(chrome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push('attempt ' + attempt + ': ' + message);
        if (attempt < maxAttempts) {
          console.warn('Chrome harness startup failed; retrying once with a fresh profile.');
        }
      }
    }

    throw new Error('Chrome failed to start after ' + maxAttempts + ' bounded attempts:\n' + failures.join('\n'));
  }

  static async startAttempt(chrome) {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'cliharbor-browser-e2e-'));
    const args = [
      '--headless=new',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
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
    processHandle.once('exit', (code, signal) => {
      harness.exit = { code, signal };
    });

    try {
      harness.port = await ChromeHarness.waitForDevTools(harness);
      return harness;
    } catch (error) {
      const stderr = harness.stderr.trim();
      await harness.close();
      const detail = stderr ? '\nChrome stderr (bounded):\n' + stderr : '';
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message + detail);
    }
  }

  static async waitForDevTools(harness, timeoutMs = 15000) {
    const activePortPath = path.join(harness.userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    let lastError;

    while (Date.now() < deadline) {
      if (harness.exit) {
        throw new Error(
          'Chrome exited before DevTools became ready (code=' + harness.exit.code + ', signal=' + harness.exit.signal + ')',
        );
      }

      try {
        const activePort = await readFile(activePortPath, 'utf8');
        const port = parseDevToolsActivePort(activePort);
        if (port !== undefined) {
          const response = await fetch('http://127.0.0.1:' + port + '/json/version');
          if (response.ok) {
            const payload = await response.json();
            if (typeof payload?.webSocketDebuggerUrl === 'string' && payload.webSocketDebuggerUrl.length > 0) {
              return port;
            }
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          lastError = error;
        }
      }

      await delay(50);
    }

    if (lastError) {
      throw new Error('Chrome DevTools endpoint timed out: ' + lastError.message);
    }
    throw new Error('Chrome DevTools endpoint timed out');
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

function isConjurSessionCheckRequest(params) {
  if (params.request?.url === undefined || params.request.url !== new URL('/api/v1/runs', bootstrapURL).href) {
    return false;
  }
  if (params.request.method !== 'POST' || typeof params.request.postData !== 'string') {
    return false;
  }
  try {
    const body = JSON.parse(params.request.postData);
    return body?.packId === 'cyberark-conjur-v9' && body?.commandId === 'whoami';
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
  const result = await page.call('Page.navigate', { url });
  if (result.errorText) {
    throw new Error('Browser navigation failed: ' + result.errorText);
  }
}

async function waitJS(page, label, expression, timeoutMs = 10000) {
  return poll(label, async () => Boolean(await page.evaluate(expression)), timeoutMs, 75);
}

async function chooseTask(page, value) {
  const expression = '(() => {' +
    'const catalog = document.querySelector(".task-discovery"); if (catalog && !catalog.open) catalog.querySelector("summary").click();' +
    'const button = Array.from(document.querySelectorAll("button[data-task-action=select]")).find((element) => element.dataset.taskKey === ' + JSON.stringify(value) + ');' +
    'if (!button || button.disabled) return false;' +
    'button.click();' +
    'return true;' +
  '})()';
  assert.equal(await page.evaluate(expression), true, 'task discovery should expose the requested fixture task');
}

async function setTextInput(page, label, value) {
  const expression = '(() => {' +
    'const input = Array.from(document.querySelectorAll("input")).find((element) => element.closest("label")?.textContent?.trim().startsWith(' + JSON.stringify(label) + '));' +
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
  const screenshotDirectory = process.env.CLIHARBOR_E2E_SCREENSHOT_DIR;
  const capture = async (name) => {
    if (!screenshotDirectory) return;
    await mkdir(screenshotDirectory, { recursive: true });
    const screenshot = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(screenshotDirectory, name + '.png'), Buffer.from(screenshot.data, 'base64'));
  };
  let page;

  try {
    page = await chrome.newPage();
    pages.push(page);
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

    stage('bootstrap and authenticated shell');
    await navigate(page, bootstrapURL);

    await waitJS(page, 'clean authenticated application page',
      'location.href === ' + JSON.stringify(baseURL + '/') + ' && document.body.innerText.includes("CLIHarbor")');
    await waitJS(page, 'operator overview dashboard',
      'location.pathname === "/" && ["Get your CLIs ready", "What would you like to do?"].includes(document.querySelector("#overview-heading")?.textContent?.trim())');

    const overviewSurface = await page.evaluate('(() => ({' +
      'hasTaskForm: Boolean(document.querySelector(".task-panel form")),' +
      'hasDiagnosticsDetails: Boolean(document.querySelector(".tool-diagnostics")),' +
      'hasTasksLink: Array.from(document.querySelectorAll("a")).some((link) => link.textContent?.trim() === "Tasks"),' +
      'hasGuidedSignIn: ["Connect your CLIs", "CLI session checks"].includes(document.querySelector("#overview-login-heading")?.textContent?.trim()),' +
      'hasConjurForm: Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Save connection and continue"),' +
      'hasDedicatedSignIn: Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Open CyberArk Conjur sign-in"),' +
      'horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth' +
    '}))()');
    assert.equal(overviewSurface.hasTaskForm, false, 'overview must not duplicate the task execution workspace');
    assert.equal(overviewSurface.hasDiagnosticsDetails, false, 'overview must not duplicate diagnostics details');
    assert.equal(overviewSurface.hasTasksLink, true, 'overview must provide primary navigation to Tasks');
    assert.equal(overviewSurface.hasGuidedSignIn, true, 'overview must expose the reviewed guided CLI sign-in surface');
    assert.equal(overviewSurface.hasConjurForm, false, 'generic overview must not render the dedicated Conjur form (ADR-034)');
    assert.equal(overviewSurface.hasDedicatedSignIn, true, 'overview must link Conjur to its dedicated sign-in');
    assert.equal(overviewSurface.horizontalOverflow, false, 'overview must fit the default browser viewport horizontally');
    const shell = await page.evaluate('(() => ({' +
      'sidebarOnLeft: document.querySelector(".sidebar").getBoundingClientRect().width > 0 && document.querySelector(".sidebar").getBoundingClientRect().right <= document.querySelector("main").getBoundingClientRect().left,' +
      'hasHeaderSections: ["Built-in CLIs", "Other CLIs"].every((label) => Array.from(document.querySelectorAll(".section-switcher a")).some((link) => link.textContent?.includes(label))),' +
      'groups: Array.from(document.querySelectorAll(".primary-nav .nav-group-label")).map((element) => element.textContent)' +
    '}))()');
    assert.equal(shell.sidebarOnLeft, true, 'desktop navigation must be a left sidebar');
    assert.equal(shell.hasHeaderSections, true, 'header must distinguish built-in integrations from other CLIs');
    assert.deepEqual(shell.groups, ['CLI workspace']);
    await capture('overview');

    stage('quick task navigation is a modal, not an execution shortcut');
    assert.equal(await page.evaluate('(() => {' +
      'const trigger = document.querySelector(".quick-switch-trigger");' +
      'if (!trigger || trigger.disabled) return false;' +
      'trigger.click(); return true;' +
    '})()'), true);
    await waitJS(page, 'quick switcher ready',
      'document.querySelector(".task-switcher[open]") !== null && document.activeElement?.id === "task-switcher-input"');
    await page.evaluate('(() => {' +
      'const input = document.querySelector("#task-switcher-input");' +
      'const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;' +
      'setter.call(input, "inspect fixture");' +
      'input.dispatchEvent(new Event("input", { bubbles: true }));' +
      'input.dispatchEvent(new Event("change", { bubbles: true }));' +
    '})()');
    await waitJS(page, 'approved task search results',
      'document.querySelectorAll(".task-switcher-item").length > 0 && document.querySelector(".task-switcher-item")?.textContent.includes("Inspect fixture argv")');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: false });
    await waitJS(page, 'quick switcher narrow layout',
      'innerWidth === 320 && document.documentElement.scrollWidth <= innerWidth && document.querySelector(".task-switcher")?.getBoundingClientRect().right <= innerWidth');
    await capture('task-switcher-mobile');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('document.querySelector(".task-switcher-item").click(); true');
    await waitJS(page, 'quick switcher opens existing task configuration',
      'location.pathname === "/tasks" && document.querySelector(".task-context-header h3")?.textContent?.includes("Inspect fixture argv") && document.querySelector(".task-switcher") === null');
    assert.equal(await page.evaluate('document.querySelector(".run-panel h2")?.textContent === "Succeeded"'), false,
      'quick switcher must not execute a task');
    await navigate(page, baseURL + '/');
    await waitJS(page, 'overview restored after quick switcher',
      'location.pathname === "/" && document.querySelector("#overview-heading") !== null');

    stage('supported CLI catalog navigation and responsive search');
    await page.evaluate('Array.from(document.querySelectorAll("a")).find((link) => link.textContent?.trim() === "Add a CLI").click()');
    await waitJS(page, 'supported CLI catalog', 'location.pathname === "/tools" && document.querySelector("#tool-diagnostics-heading")?.textContent === "Add a CLI"');
    assert.equal(await page.evaluate('document.querySelectorAll(".cli-catalog-list > li").length > 0'), true, 'catalog must include configured tools');
    await capture('cli-catalog');
    await page.evaluate('(() => { const input = document.querySelector("input[type=search]"); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; setter.call(input, "no-matching-cli-zzzz"); input.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await waitJS(page, 'catalog search empty state', 'document.body.innerText.includes("No supported CLIs match your search.")');
    await page.evaluate('(() => { const input = document.querySelector("input[type=search]"); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; setter.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await waitJS(page, 'catalog search reset', 'document.querySelectorAll(".cli-catalog-list > li").length > 0');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: false });
    await waitJS(page, 'catalog narrow layout', 'innerWidth === 320 && document.documentElement.scrollWidth <= innerWidth');
    await capture('cli-catalog-mobile');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await navigate(page, baseURL + '/');
    await waitJS(page, 'overview after catalog', 'location.pathname === "/" && document.querySelector("#overview-heading") !== null');

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

    stage('direct authentication route and enterprise viewport');
    await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent?.trim() === "CLI sessions").click()');
    await waitJS(page, 'per-CLI session navigation', 'location.pathname === "/authentication" && document.activeElement?.id === "main-content"');
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate(page, baseURL + '/authentication');
    await waitJS(page, 'authentication route',
      'location.pathname === "/authentication" && document.querySelector("#authentication-heading")?.textContent?.trim() === "CLI sessions"');
    const authSurface = await page.evaluate('(() => ({' +
      'passwordInputs: document.querySelectorAll("input[type=password]").length,' +
      'horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,' +
      'hasAuthLink: Array.from(document.querySelectorAll(".primary-nav a")).some((link) => link.textContent?.trim() === "CLI sessions")' +
    '}))()');
    assert.equal(authSurface.passwordInputs, 0, 'authentication route must not contain password inputs');
    assert.equal(authSurface.horizontalOverflow, false, 'authentication route must fit the 1366px enterprise viewport horizontally');
    assert.equal(authSurface.hasAuthLink, true, 'CLI sessions route must remain in primary navigation');
    await capture('authentication');

    stage('staged Conjur GUI authentication in the dedicated section');
    await clickButton(page, 'Open CyberArk Conjur sign-in');
    await waitJS(page, 'dedicated Conjur sign-in route',
      'location.pathname === "/dedicated/conjur/sign-in" && document.body.innerText.includes("Sign in to CyberArk Conjur")');
    assert.equal(
      await page.evaluate('document.body.innerText.includes("Save connection and continue")'),
      true,
      'first-run Conjur setup must expose the connection stage',
    );
    const configureRequestPromise = page.waitEvent(
      'Network.requestWillBeSent',
      (params) =>
        params.request?.url === new URL('/api/v1/auth/configure', baseURL).href &&
        params.request.method === 'POST',
    );
    await setTextInput(page, 'Conjur server URL', conjurURL);
    await setTextInput(page, 'Account', 'engineering');
    await clickButton(page, 'Save connection and continue');

    const configureRequest = await configureRequestPromise;
    assert.equal(
      headerValue(configureRequest.request.headers, 'X-CLIHarbor-CSRF')?.length > 0,
      true,
      'connection setup must carry the authenticated local CSRF boundary',
    );
    assert.equal(
      (configureRequest.request.postData ?? '').includes(conjurSecret),
      false,
      'connection setup must not contain the password',
    );
    assert.deepEqual(JSON.parse(configureRequest.request.postData), {
      packId: 'cyberark-conjur-v9',
      toolId: 'conjur',
      applianceUrl: conjurURL,
      account: 'engineering',
      authnType: 'authn',
    });
    assert.equal(await waitHTTPStatus(page, configureRequest.requestId), 204, 'connection setup should succeed');

    await waitJS(
      page,
      'credential stage after connection setup',
      'document.querySelectorAll("input[type=password]").length === 1 && ' +
        'Array.from(document.querySelectorAll("input")).some((input) => input.closest("label")?.textContent?.trim().startsWith("Identity")) && ' +
        '!Array.from(document.querySelectorAll("input")).some((input) => input.closest("label")?.textContent?.trim().startsWith("Conjur server URL"))',
    );

    const loginRequestPromise = page.waitEvent(
      'Network.requestWillBeSent',
      (params) =>
        params.request?.url === new URL('/api/v1/auth/login', baseURL).href &&
        params.request.method === 'POST',
    );
    const sessionCheckPromise = page.waitEvent('Network.requestWillBeSent', isConjurSessionCheckRequest);
    await setTextInput(page, 'Identity', conjurIdentity);
    await setTextInput(page, 'Password', conjurSecret);
    await clickButton(page, 'Sign in and verify');

    const loginRequest = await loginRequestPromise;
    assert.deepEqual(JSON.parse(loginRequest.request.postData), {
      packId: 'cyberark-conjur-v9',
      toolId: 'conjur',
      identity: conjurIdentity,
      secret: conjurSecret,
    });
    assert.equal(await waitHTTPStatus(page, loginRequest.requestId), 204, 'credential login should succeed');

    const sessionCheckRequest = await sessionCheckPromise;
    assert.equal(
      (sessionCheckRequest.request.postData ?? '').includes(conjurSecret),
      false,
      'session verification must not contain the password',
    );
    await waitJS(
      page,
      'authenticated Conjur session',
      'document.body.innerText.includes("Authenticated") && document.body.innerText.includes("engineering") && document.body.innerText.includes("alice")',
      15000,
    );
    const credentialState = await page.evaluate('(() => ({' +
      'passwordValue: document.querySelector("input[type=password]")?.value ?? null,' +
      'connectionInputs: Array.from(document.querySelectorAll("input")).filter((input) => input.closest("label")?.textContent?.trim().startsWith("Conjur server URL")).length' +
    '}))()');
    assert.equal(credentialState.passwordValue, '', 'password input must be cleared after the login attempt');
    assert.equal(credentialState.connectionInputs, 0, 'successful setup must not leave connection inputs active');

    stage('direct run history route');
    await navigate(page, baseURL + '/runs');
    await waitJS(page, 'runs route',
      'location.pathname === "/runs" && document.body.innerText.includes("Recent runs")');
    const runsSurface = await page.evaluate('(() => ({' +
      'horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,' +
      'hasRunsLink: Array.from(document.querySelectorAll("a")).some((link) => link.textContent?.trim() === "Runs")' +
    '}))()');
    assert.equal(runsSurface.horizontalOverflow, false, 'runs route must fit the 1366px enterprise viewport horizontally');
    assert.equal(runsSurface.hasRunsLink, true, 'runs route must remain in primary navigation');

    stage('task discovery empty shortcuts and enterprise viewport');
    await navigate(page, baseURL + '/tasks');
    await waitJS(page, 'tasks discovery route',
      'location.pathname === "/tasks" && Boolean(document.querySelector("input[type=search]"))');
    const taskDiscoverySurface = await page.evaluate('(() => ({' +
      'horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,' +
      'hasFavorites: Array.from(document.querySelectorAll("h3")).some((heading) => heading.textContent?.trim() === "Favorites"),' +
      'hasRecent: Array.from(document.querySelectorAll("h3")).some((heading) => heading.textContent?.trim() === "Recently used"),' +
      'hasAll: Array.from(document.querySelectorAll("h3")).some((heading) => heading.textContent?.trim() === "All tasks"),' +
      'taskCount: document.querySelector(".task-search-count")?.textContent?.trim() ?? ""' +
    '}))()');
    assert.equal(taskDiscoverySurface.horizontalOverflow, false, 'tasks route must fit the 1366px enterprise viewport horizontally');
    assert.equal(taskDiscoverySurface.hasFavorites, false, 'empty Favorites must stay hidden until useful');
    assert.equal(taskDiscoverySurface.hasRecent, false, 'empty Recently used must stay hidden until useful');
    assert.equal(taskDiscoverySurface.hasAll, true);
    assert.match(taskDiscoverySurface.taskCount, /task/, 'task discovery should keep catalog size visible');

    stage('tool category filtering');
    await page.evaluate('(() => { const select = document.querySelector(".task-category-filter select"); select.value = "integration/fixture"; select.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await waitJS(page, 'fixture category', 'document.querySelector(".task-category-filter select").value === "integration/fixture" && document.querySelector(".task-discovery").open');
    assert.equal(await page.evaluate('Array.from(document.querySelectorAll("[data-task-action=select]")).every((button) => button.dataset.taskKey.startsWith("integration/"))'), true, 'category rows must belong to the selected tool');
    await page.evaluate('(() => { const select = document.querySelector(".task-category-filter select"); select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await waitJS(page, 'all tool categories restored', 'document.querySelector(".task-category-filter select").value === "" && document.querySelector(".task-catalog-selection").textContent.includes("4 available")');

    stage('responsive operator workflow widths');
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.call('Emulation.setDeviceMetricsOverride', {
        width,
        height: width <= 390 ? 844 : 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await waitJS(
        page,
        'tasks route ' + width + 'px layout',
        'window.innerWidth === ' + width + ' && document.documentElement.scrollWidth <= window.innerWidth',
        5000,
      );
      if (width <= 390) {
        assert.equal(await page.evaluate('document.querySelector(".sidebar").getBoundingClientRect().width === 0'), true, 'mobile sidebar starts collapsed');
        await clickButton(page, 'Menu');
        await waitJS(page, 'mobile menu open', 'document.querySelector(".navigation-toggle").getAttribute("aria-expanded") === "true" && document.querySelector(".sidebar").getBoundingClientRect().width > 0');
        assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'open mobile menu must fit the viewport');
        await clickButton(page, 'Menu');
      }
      await capture('tasks-' + width);
    }
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const favoriteInspect = await page.evaluate('(() => {' +
      'const button = document.querySelector("[data-task-section=all][data-task-action=favorite][data-task-key=\\\"integration/inspect\\\"]");' +
      'if (!button) return false; button.click(); return true;' +
    '})()');
    assert.equal(favoriteInspect, true, 'fixture inspect task should be favoritable');
    await waitJS(page, 'favorite task row',
      'Boolean(document.querySelector("[data-task-section=favorites][data-task-action=select][data-task-key=\\\"integration/inspect\\\"]"))');
    const preferenceStorage = await page.evaluate('(() => {' +
      'const value = localStorage.getItem("cliharbor.task-preferences.v1") ?? "";' +
      'return { value, keys: Object.keys(localStorage) };' +
    '})()');
    assert.ok(preferenceStorage.keys.includes('cliharbor.task-preferences.v1'));
    assert.match(preferenceStorage.value, /integration/);
    assert.match(preferenceStorage.value, /inspect/);
    for (const forbidden of ['argv', 'executable', 'stdout', 'stderr', 'values']) {
      assert.equal(preferenceStorage.value.includes(forbidden), false, 'task preferences must stay identifier-only');
    }

    const selectFavorite = await page.evaluate('(() => {' +
      'const button = document.querySelector("[data-task-section=favorites][data-task-action=select][data-task-key=\\\"integration/inspect\\\"]");' +
      'if (!button || button.disabled) return false; button.click(); return true;' +
    '})()');
    assert.equal(selectFavorite, true, 'favorite task should feed the existing task form');
    await waitJS(page, 'favorite-selected inspect query field',
      'Array.from(document.querySelectorAll("input")).some((element) => element.closest("label")?.textContent?.trim().startsWith("Query"))');
    assert.equal(await page.evaluate('document.querySelector(".task-discovery").open'), false, 'selection should bring configuration into reach');
    assert.equal(await page.evaluate('document.querySelector(".task-catalog-selection").textContent'), 'Inspect fixture argv', 'collapsed catalog must identify the selected task');
    assert.equal(await page.evaluate('document.activeElement?.closest(".task-context") !== null'), true, 'selection should focus configuration');
    await capture('selected-task');

    stage('native validation and input reset');
    await clickButton(page, 'Preview command');
    assert.equal(await page.evaluate('document.querySelector("#task-input-query").validity.valueMissing'), true);
    assert.equal(await page.evaluate('document.activeElement?.id'), 'task-input-query');
    await setTextInput(page, 'Query', 'preview-only');
    await clickButton(page, 'Preview command');
    await waitJS(page, 'validated preview', 'document.querySelector(".preview-confirmation") !== null');
    await clickButton(page, 'Reset inputs');
    assert.equal(await page.evaluate('document.querySelector("#task-input-query").value'), '');
    assert.equal(await page.evaluate('document.querySelector(".preview-confirmation") === null'), true);

    stage('navigation focus and page titles');
    await page.evaluate('Array.from(document.querySelectorAll("nav a")).find((link) => link.textContent.trim() === "Diagnostics").click(); true');
    await waitJS(page, 'diagnostics navigation', 'location.pathname === "/diagnostics" && document.title === "Diagnostics · CLIHarbor" && document.activeElement?.id === "main-content"');
    await page.evaluate('Array.from(document.querySelectorAll("nav a")).find((link) => link.textContent.trim() === "Tasks").click(); true');
    await waitJS(page, 'tasks navigation', 'location.pathname === "/tasks" && document.title === "Tasks · CLIHarbor" && document.activeElement?.id === "main-content"');

    stage('bootstrap replay');
    // An already-authenticated browser is redirected to the app, regardless
    // of bootstrap-token state. Test token replay with a fresh cookie profile.
    const replayBrowser = await ChromeHarness.start();
    try {
      const replay = await replayBrowser.newPage();
      const replayResponse = replay.waitEvent('Network.responseReceived',
        (params) => params.response?.url?.startsWith(baseURL + '/bootstrap?'));
      await navigate(replay, bootstrapURL);
      assert.equal((await replayResponse).response.status, 410, 'bootstrap token replay must fail closed');
      replay.close();
    } finally {
      await replayBrowser.close();
    }

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

    stage('typed fixture execution from favorites and inert rendering');
    await waitJS(page, 'inspect query field',
      'Array.from(document.querySelectorAll("input")).some((element) => element.closest("label")?.textContent?.trim().startsWith("Query"))');
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

    await waitJS(page, 'fixture run completion', 'document.querySelector(".run-panel h2")?.textContent?.trim() === "Succeeded"');
    assert.equal(await page.evaluate('document.activeElement?.id'), 'run-heading', 'accepted execution should focus its result');
    await capture('completed-run');
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

    const shortcutDeduplication = await page.evaluate('(() => ({' +
      'favoritePresent: Boolean(document.querySelector("[data-task-section=favorites][data-task-action=select][data-task-key=\\\"integration/inspect\\\"]")),' +
      'recentDuplicate: Boolean(document.querySelector("[data-task-section=recent][data-task-action=select][data-task-key=\\\"integration/inspect\\\"]"))' +
    '}))()');
    assert.equal(shortcutDeduplication.favoritePresent, true, 'used favorite task should remain in Favorites');
    assert.equal(shortcutDeduplication.recentDuplicate, false, 'Favorites must not be duplicated in Recently used');

    const unfavoriteInspect = await page.evaluate('(() => {' +
      'const catalog = document.querySelector(".task-discovery"); if (!catalog.open) catalog.querySelector("summary").click();' +
      'const button = document.querySelector("[data-task-section=favorites][data-task-action=favorite][data-task-key=\\\"integration/inspect\\\"]");' +
      'if (!button || button.disabled) return false; button.click(); return true;' +
    '})()');
    assert.equal(unfavoriteInspect, true, 'completed favorite task should be removable from Favorites');
    await waitJS(page, 'recent task after removing favorite',
      'Boolean(document.querySelector("[data-task-section=recent][data-task-action=select][data-task-key=\\\"integration/inspect\\\"]"))');
    const selectRecent = await page.evaluate('(() => {' +
      'const button = document.querySelector("[data-task-section=recent][data-task-action=select][data-task-key=\\\"integration/inspect\\\"]");' +
      'if (!button || button.disabled) return false; button.click(); return true;' +
    '})()');
    assert.equal(selectRecent, true, 'recent task should feed the existing task form after favorite removal');
    await setTextInput(page, 'Query', 'recent-relaunch');
    const recentCreateRequest = page.waitEvent('Network.requestWillBeSent',
      (params) => isRunCreateRequest(params, 'inspect'));
    await clickButton(page, 'Run task');
    await recentCreateRequest;
    await waitJS(page, 'recent fixture run completion',
      'document.querySelector(".run-panel h2")?.textContent?.trim() === "Succeeded"');

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

    await navigate(page, baseURL + '/tasks');
    await waitJS(page, 'task discovery after task discovery runs',
      "location.pathname === '/tasks' && Array.from(document.querySelectorAll('button[data-task-action=select]')).some((element) => element.dataset.taskKey === 'integration/wait')");

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
    await waitJS(page, 'wait fixture running', 'document.querySelector(".run-panel h2")?.textContent?.trim() === "Running"');
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
    await waitJS(page, 'explicit run cancellation', 'document.querySelector(".run-panel h2")?.textContent?.trim() === "Cancelled"', 8000);
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

    stage('Conjur security audit configuration');
    await navigate(page, baseURL + '/conjur/security-audit');
    await waitJS(page, 'Conjur audit setup', 'document.querySelector("input[name=audit-backend-url]") !== null');
    const auditSetup = await page.evaluate('(() => ({' +
      'backend: document.querySelector("input[name=audit-backend-url]").value,' +
      'scanTypes: Array.from(document.querySelector("select[name=audit-scan-type]").options).map((option) => option.value),' +
      'inDedicated: Array.from(document.querySelectorAll("nav[aria-label=\\"Dedicated CLIs\\"] a")).some((link) => link.textContent.trim() === "Security audit" && link.getAttribute("aria-current") === "page"),' +
      'inPrimary: Array.from(document.querySelectorAll(".primary-nav a")).some((link) => link.textContent.includes("audit"))' +
    '}))()');
    assert.equal(auditSetup.backend, conjurURL, 'audit target should default to vendor configuration');
    assert.deepEqual(auditSetup.scanTypes, ['id-regex', 'regex']);
    assert.equal(auditSetup.inDedicated, true, 'audit must live in the dedicated Conjur section');
    assert.equal(auditSetup.inPrimary, false);
    assert.equal(await page.evaluate('document.querySelector("select[name=audit-scan-type]").value'), 'id-regex');
    assert.equal(await page.evaluate('document.querySelector("select[name=audit-preset]").value'), 'credential-names');
    await page.evaluate('(() => {' +
      'const select = document.querySelector("select[name=audit-preset]");' +
      'select.value = "custom"; select.dispatchEvent(new Event("change", { bubbles: true }));' +
    '})()');
    await waitJS(page, 'custom inventory regex', 'document.querySelector("select[name=audit-preset]").value === "custom"');
    await setTextInput(page, 'Regex pattern (Go / RE2)', '^team[./].*/password$');
    await setTextInput(page, 'CyberArk backend URL', 'https://other.invalid');
    await page.evaluate('document.querySelector(".secret-audit-ack input").click()');
    const auditRequestPromise = page.waitEvent('Network.requestWillBeSent',
      (params) => params.request?.url === baseURL + '/api/v1/conjur/secret-audit' && params.request?.method === 'POST');
    await clickButton(page, 'Start pattern search');
    const auditRequest = await auditRequestPromise;
    assert.deepEqual(JSON.parse(auditRequest.request.postData), {
      packId: 'cyberark-conjur-v9', toolId: 'conjur', minimumConfidence: 'high',
      applianceUrl: 'https://other.invalid', scanType: 'id-regex', pattern: '^team[./].*/password$',
    });
    assert.equal(await waitHTTPStatus(page, auditRequest.requestId), 202);
    await waitJS(page, 'audit refuses mismatched backend', 'document.querySelector("#secret-audit-result-heading")?.textContent.includes("Sign in to the selected backend")');
    assert.equal(await page.evaluate('document.querySelector("input[name=audit-pattern]").value'), '', 'scan text must be cleared after starting');

    stage('responsive operator pages');
    for (const width of [1024, 390, 320]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      for (const route of ['/', '/authentication', '/runs', '/diagnostics', '/conjur/security-audit', '/dedicated/conjur/access-explorer']) {
        await navigate(page, baseURL + route);
        await waitJS(page, route + ' ready', 'document.querySelector("main").getAttribute("aria-busy") === "false" && document.querySelector("main h2") !== null');
        if (route === '/dedicated/conjur/access-explorer') {
          assert.equal(await page.evaluate(
            'document.querySelector("#access-heading")?.textContent === "Access & Permissions Explorer"'),
            true, 'Conjur Access Explorer must resolve as a dedicated route');
          assert.equal(await page.evaluate(
            'document.querySelector("button[type=submit]")?.textContent?.trim() === "Search inventory"'),
            true, 'Conjur Access Explorer must expose its safe inventory form');
        }
        assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, route + ' must fit at ' + width + 'px');
        await capture((route === '/' ? 'overview' : route.slice(1).replaceAll('/', '-')) + '-' + width);
      }
    }

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

