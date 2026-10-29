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
const conjurCheckDelay = process.env.CLIHARBOR_E2E_CONJUR_CHECK_DELAY;
if (!conjurURL || !conjurIdentity || !conjurSecret || !conjurCheckDelay) {
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

function isRunCreateRequest(params, commandID, packID = 'integration') {
  if (params.request?.url === undefined || params.request.url !== new URL('/api/v1/runs', bootstrapURL).href) {
    return false;
  }
  if (params.request.method !== 'POST' || typeof params.request.postData !== 'string') {
    return false;
  }
  try {
    const body = JSON.parse(params.request.postData);
    return body?.packId === packID && body?.commandId === commandID;
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
  await page.evaluate('(() => {' +
    'const catalog = document.querySelector(".task-discovery"); if (catalog && !catalog.open) catalog.querySelector("summary").click();' +
    '})()');
  // The disclosure's toggle handler mounts its catalog on a React update.
  // Wait for the selectable task rather than reading the old DOM immediately.
  await waitJS(page, 'task catalog ready for selection',
    'Array.from(document.querySelectorAll("button[data-task-action=select]")).some((element) => element.dataset.taskKey === ' + JSON.stringify(value) + ' && !element.disabled)');
  const expression = '(() => {' +
    'const button = Array.from(document.querySelectorAll("button[data-task-action=select]")).find((element) => element.dataset.taskKey === ' + JSON.stringify(value) + ');' +
    'if (!button || button.disabled) return false;' +
    'button.click();' +
    'return true;' +
  '})()';
  assert.equal(await page.evaluate(expression), true, 'task discovery should expose the requested fixture task');
}

async function setTextInput(page, label, value) {
  const expression = '(() => {' +
    'const input = Array.from(document.querySelectorAll("input")).find((element) => Array.from(element.labels ?? []).some((label) => label.textContent?.trim().startsWith(' + JSON.stringify(label) + ')));' +
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
    'const button = Array.from(document.querySelectorAll("button")).find((element) => element.getClientRects().length > 0 && (element.getAttribute("aria-label") === ' + JSON.stringify(text) + ' || element.textContent?.trim() === ' + JSON.stringify(text) + '));' +
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
      'hasTaskForm: Boolean(document.querySelector(".builder-card form")),' +
      'hasDiagnosticsDetails: Boolean(document.querySelector(".tool-diagnostics")),' +
      'hasTasksLink: Array.from(document.querySelectorAll("a")).some((link) => link.textContent?.trim() === "Command Builder"),' +
      'hasTopbarSignIn: document.querySelector(".topbar .topbar-sign-in")?.textContent?.trim() === "Sign in",' +
      'hasConjurForm: Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Save connection"),' +
      'horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth' +
    '}))()');
    assert.equal(overviewSurface.hasTaskForm, false, 'overview must not duplicate the task execution workspace');
    assert.equal(overviewSurface.hasDiagnosticsDetails, false, 'overview must not duplicate diagnostics details');
    assert.equal(overviewSurface.hasTasksLink, true, 'overview must provide primary navigation to the Command Builder');
    assert.equal(overviewSurface.hasTopbarSignIn, true, 'the top bar must expose the universal Sign in page (ADR-038)');
    assert.equal(overviewSurface.hasConjurForm, false, 'overview must not duplicate CLI sign-in forms (ADR-038)');
    assert.equal(overviewSurface.horizontalOverflow, false, 'overview must fit the default browser viewport horizontally');
    const shell = await page.evaluate('(() => ({' +
      'sidebarOnLeft: document.querySelector(".sidebar").getBoundingClientRect().width > 0 && document.querySelector(".sidebar").getBoundingClientRect().right <= document.querySelector("main").getBoundingClientRect().left,' +
      'hasHeaderSections: ["Built-in CLIs", "Other CLIs"].every((label) => Array.from(document.querySelectorAll(".section-switcher a")).some((link) => link.textContent?.includes(label))),' +
      'groups: Array.from(document.querySelectorAll(".primary-nav .nav-group-label")).map((element) => element.textContent)' +
    '}))()');
    assert.equal(shell.sidebarOnLeft, true, 'desktop navigation must be a left sidebar');
    assert.equal(shell.hasHeaderSections, true, 'header must distinguish built-in integrations from other CLIs');
    assert.deepEqual(shell.groups, ['CLI workspace']);
    assert.equal(await page.evaluate('document.querySelector(".primary-nav").innerText.includes("Built-in CLIs")'), false);
    assert.equal(await page.evaluate('document.querySelector(".overview-metrics, #overview-workspace-heading") === null'), true);
    await page.evaluate('document.querySelector(".section-switcher a").focus()');
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitJS(page, 'keyboard built-in navigation', 'location.pathname === "/dedicated" && document.activeElement?.id === "main-content"');
    await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent.trim() === "Overview").click()');
    await waitJS(page, 'return to overview', 'location.pathname === "/" && document.querySelector("#overview-heading") !== null');
    await capture('overview');

    stage('unavailable startup recovers with keyboard focus');
    await page.call('Network.setBlockedURLs', { urls: [baseURL + '/api/v1/status'] });
    await navigate(page, baseURL + '/');
    await waitJS(page, 'focused startup error', 'document.activeElement?.classList.contains("error-panel") && document.body.innerText.includes("Runtime status unavailable")');
    for (const width of [1366, 320]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth && Array.from(document.querySelectorAll("button")).some((button) => button.textContent.trim() === "Retry status check" && !button.disabled)'), true);
      await capture('startup-recovery-' + width);
    }
    await page.call('Network.setBlockedURLs', { urls: [] });
    await page.evaluate('Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Retry status check").focus()');
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitJS(page, 'startup retry restores main focus', `(() => {
      if (document.querySelector('#overview-heading') && document.activeElement?.id === 'main-content') return true;
      throw new Error(JSON.stringify({ focus: document.activeElement?.tagName + '#' + document.activeElement?.id,
        error: document.querySelector('.error-code')?.textContent, heading: document.querySelector('main h2')?.textContent }));
    })()`);
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

    stage('quick task navigation is a modal, not an execution shortcut');
    assert.equal(await page.evaluate('(() => {' +
      'const trigger = document.querySelector(".quick-switch-trigger");' +
      'if (!trigger || trigger.disabled) return false;' +
      'trigger.click(); return true;' +
    '})()'), true);
    await waitJS(page, 'quick switcher ready',
      'document.querySelector(".task-switcher[open]") !== null && document.activeElement?.id === "task-switcher-input"');
    assert.equal(await page.evaluate('(async () => {' +
      'const dialog = document.querySelector(".task-switcher");' +
      'const closed = new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));' +
      'dialog.close(); dialog.showModal(); document.querySelector("#task-switcher-input").focus();' +
      'await closed; await new Promise(requestAnimationFrame);' +
      'return dialog.isConnected && dialog.open && document.activeElement?.id === "task-switcher-input";' +
    '})()'), true, 'a queued native close event must not dismiss a reopened task search');
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
      'location.pathname === "/tasks" && document.querySelector(".task-context-header h4")?.textContent?.includes("Inspect fixture argv") && document.querySelector(".task-switcher") === null');
    assert.equal(await page.evaluate('document.querySelector(".run-panel h2")?.textContent === "Succeeded"'), false,
      'quick switcher must not execute a task');
    stage('native dropdown appearance and selection remain safe at narrow width');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: false });
    const selectAppearance = await page.evaluate('(() => {' +
      'const select = document.querySelector(".task-category-filter select");' +
      'if (!select) return null;' +
      'const style = getComputedStyle(select); const box = select.getBoundingClientRect();' +
      'const probe = document.createElement("select"); probe.size = 4; document.body.append(probe);' +
      'const listboxAppearance = getComputedStyle(probe).appearance; probe.remove();' +
      'return { tag: select.tagName, appearance: style.appearance, image: style.backgroundImage,' +
        'fits: box.left >= 0 && box.right <= innerWidth, listboxAppearance };' +
    '})()');
    assert.ok(selectAppearance, 'tool filter must expose a native select');
    assert.equal(selectAppearance.tag, 'SELECT', 'tool filter must preserve the native select element');
    assert.equal(selectAppearance.appearance, 'none', 'the native select trigger must receive the shared chevron styling');
    assert.equal(selectAppearance.image.startsWith('url('), true, 'native select must display its local chevron');
    assert.equal(selectAppearance.fits, true, 'dropdown must fit a 320px viewport');
    assert.notEqual(selectAppearance.listboxAppearance, 'none', 'sized native listboxes must not inherit dropdown styling');
    const nextFilter = await page.evaluate('(() => {' +
      'const select = document.querySelector(".task-category-filter select");' +
      'const next = Array.from(select.options).find((option) => option.value && option.value !== select.value);' +
      'if (!next) return null;' +
      'window.__cliharborTaskBefore = document.querySelector(".task-context-header h4")?.textContent ?? "";' +
      'Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, next.value);' +
      'select.dispatchEvent(new Event("change", { bubbles: true })); return next.value;' +
    '})()');
    assert.ok(nextFilter, 'fixture must expose a second tool to exercise selection');
    await waitJS(page, 'native select remains wired to task filtering',
      // React owns the filter: the controlled value sticks and App's change
      // handler moves the active task to the newly filtered tool. (Element
      // identity is not a contract; React may legitimately reuse the node.)
      'document.querySelector(".task-category-filter select")?.value === ' + JSON.stringify(nextFilter) + ' && ' +
        '(document.querySelector(".task-context-header h4")?.textContent ?? "") !== window.__cliharborTaskBefore');
    assert.equal(await page.evaluate('document.querySelector(".run-panel h2")?.textContent === "Succeeded"'), false,
      'changing a task filter must never execute a task');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
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
    await page.evaluate('document.querySelector(".topbar .topbar-sign-in").click()');
    await waitJS(page, 'universal sign-in navigation', 'location.pathname === "/authentication" && document.activeElement?.id === "main-content"');
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate(page, baseURL + '/authentication');
    await waitJS(page, 'authentication route',
      'location.pathname === "/authentication" && document.querySelector("#authentication-heading")?.textContent?.trim() === "Sign in"');
    const authSurface = await page.evaluate('(() => ({' +
      'passwordInputs: document.querySelectorAll("input[type=password]").length,' +
      'horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,' +
      'hasAuthLink: document.querySelector(".topbar .topbar-sign-in")?.getAttribute("aria-current") === "page"' +
    '}))()');
    assert.equal(authSurface.passwordInputs, 0, 'first-run Conjur setup must not ask for a password before a backend is configured');
    assert.equal(authSurface.horizontalOverflow, false, 'authentication route must fit the 1366px enterprise viewport horizontally');
    assert.equal(authSurface.hasAuthLink, true, 'the top-bar Sign in button must mark the current page');
    await capture('authentication');

    stage('staged Conjur GUI authentication on the universal sign-in page');
    await waitJS(page, 'first-run Conjur backend settings open',
      'document.querySelector("[aria-label$=\\" settings\\"][aria-expanded=true]") !== null && ' +
        'Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Save connection")');
    const configureRequestPromise = page.waitEvent(
      'Network.requestWillBeSent',
      (params) =>
        params.request?.url === new URL('/api/v1/auth/configure', baseURL).href &&
        params.request.method === 'POST',
    );
    await setTextInput(page, 'Conjur server URL', conjurURL);
    await setTextInput(page, 'Account', 'engineering');
    await clickButton(page, 'Save connection');

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

    stage('stalled vendor configuration read exposes an accessible retry');
    await page.evaluate(`(() => {
      window.__cliharborReadFetch = window.fetch;
      window.fetch = (...args) => {
        if (args[0] === '/api/v1/auth/configure' && args[1]?.method === 'GET') {
          return new Promise((_resolve, reject) => args[1].signal.addEventListener('abort', () => reject(args[1].signal.reason), { once: true }));
        }
        return window.__cliharborReadFetch(...args);
      };
      document.querySelector('.auth-settings-toggle').click();
    })()`);
    await waitJS(page, 'visible configuration read progress', 'document.body.innerText.includes("Reading CLI configuration…")');
    await waitJS(page, 'focused configuration read failure', 'document.activeElement?.getAttribute("aria-label") === "Conjur API backend configuration" && document.body.innerText.includes("Retry reading CLI configuration")', 20000);
    for (const width of [1366, 320]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      await page.evaluate('document.querySelector(".credential-login-error").scrollIntoView({ block: "center" }); true');
      await capture('configuration-recovery-' + width);
      assert.deepEqual(await page.evaluate(`(() => ({
        fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        alert: document.querySelector('.credential-login-error[role=alert]') !== null,
        overflow: Array.from(document.querySelectorAll('main *')).filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((element) => element.tagName + '.' + element.className).slice(0, 8)
      }))()`), { fits: true, alert: true, overflow: [] }, 'configuration recovery must fit at ' + width + 'px');
    }
    await page.evaluate('window.fetch = window.__cliharborReadFetch; true');
    await clickButton(page, 'Retry reading CLI configuration');
    await waitJS(page, 'configuration read retry restores focus', 'document.body.innerText.includes("Current API endpoint:") && document.activeElement?.getAttribute("aria-label") === "Conjur API backend configuration"');
    await page.evaluate('document.querySelector(".auth-settings-toggle").click(); true');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

    stage('abandoned password response does not verify a session in the background');
    await page.evaluate(`(() => {
      window.__cliharborLoginFetch = window.fetch;
      window.__cliharborLoginChecks = 0;
      window.fetch = async (...args) => {
        if (args[0] === '/api/v1/runs' && args[1]?.method === 'POST') window.__cliharborLoginChecks++;
        const response = await window.__cliharborLoginFetch(...args);
        if (args[0] === '/api/v1/auth/login' && args[1]?.method === 'POST') {
          return new Promise((resolve) => { window.__cliharborReleaseLogin = () => resolve(response); });
        }
        return response;
      };
    })()`);
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

    await waitJS(page, 'login response held after the real credential exchange', 'typeof window.__cliharborReleaseLogin === "function"');
    for (const width of [1366, 320]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth && document.querySelector(".auth-settings-toggle").disabled && document.querySelector(".cli-session-check").disabled && Array.from(document.querySelectorAll(".auth-actions button")).find((button) => button.textContent.trim() === "Check session").disabled'), true);
      await capture('authentication-pending-' + width);
    }
    await page.evaluate(`(() => {
      const originalConfirm = window.confirm;
      window.__cliharborLoginWarned = false;
      window.confirm = () => { window.__cliharborLoginWarned = true; return true; };
      document.querySelector('.section-switcher a[href="/tools"]').click();
      window.confirm = originalConfirm;
    })()`);
    await waitJS(page, 'left pending sign-in', 'location.pathname === "/tools"');
    assert.equal(await page.evaluate('window.__cliharborLoginWarned'), true, 'leaving a pending sign-in must preserve the mutation navigation warning');
    await page.evaluate('document.querySelector(".operation-activity summary").click(); true');
    await clickButton(page, 'Signing in to Conjur… · View operation');
    await waitJS(page, 'remounted sign-in remains locked', 'location.pathname === "/authentication" && document.querySelector("input[name=vendor-identity]")?.disabled');
    await page.evaluate('window.__cliharborReleaseLogin(); true');
    await waitJS(page, 'abandoned response clears busy state', 'document.querySelector("input[name=vendor-identity]")?.disabled === false');
    assert.equal(await page.evaluate('window.__cliharborLoginChecks'), 0, 'an abandoned login must not execute a session check');
    assert.equal(await page.evaluate('document.body.innerText.includes("Authentication not verified")'), true);
    await page.evaluate('window.fetch = window.__cliharborLoginFetch; true');
    await clickButton(page, 'Check session');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

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

    stage('session cancellation preserves live evidence and restores keyboard focus');
    await writeFile(conjurCheckDelay, 'wait', { mode: 0o600 });
    await page.evaluate(`(() => {
      const nativeFetch = window.fetch;
      const NativeEventSource = window.EventSource;
      window.__cliharborCancelFetch = nativeFetch;
      window.__cliharborCancelSource = NativeEventSource;
      window.__cliharborCancelStarts = 0;
      window.__cliharborCancelRequests = 0;
      window.fetch = async (...args) => {
        if (args[0] === '/api/v1/runs' && args[1]?.method === 'POST') window.__cliharborCancelStarts++;
        const response = await nativeFetch(...args);
        if (String(args[0]).endsWith('/cancel') && args[1]?.method === 'POST') {
          window.__cliharborCancelRequests++;
          return new Promise((resolve) => { window.__cliharborReleaseCancel = () => resolve(response); });
        }
        return response;
      };
      window.EventSource = function(...args) {
        const source = new NativeEventSource(...args);
        const add = source.addEventListener.bind(source);
        source.addEventListener = (type, listener, ...options) => add(type, type === 'run-complete'
          ? (event) => { window.__cliharborReleaseCheck = () => listener.call(source, event); }
          : listener, ...options);
        return source;
      };
    })()`);
    const cancellableCheckRequest = page.waitEvent('Network.requestWillBeSent', isConjurSessionCheckRequest);
    await clickButton(page, 'Re-check session');
    await cancellableCheckRequest;
    await waitJS(page, 'cancellable declared CLI session check', 'Array.from(document.querySelectorAll("button")).some((button) => button.textContent.trim() === "Cancel check")');
    await page.evaluate('Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Cancel check").focus()');
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitJS(page, 'real cancellation and terminal evidence held for the race', 'typeof window.__cliharborReleaseCancel === "function" && typeof window.__cliharborReleaseCheck === "function"');
    for (const width of [1366, 320]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      assert.equal(await page.evaluate('document.body.innerText.includes("Stopping session check") && !document.body.innerText.includes("Authentication check cancelled") && Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Cancellation requested")?.disabled && document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
      await capture('session-cancellation-' + width);
    }
    await page.evaluate('window.__cliharborReleaseCheck(); true');
    await waitJS(page, 'stream completion restores session-card focus', 'document.body.innerText.includes("Authentication check cancelled") && document.activeElement?.id === "vendor-session-cyberark-conjur-v9__conjur"');
    await page.evaluate('window.__cliharborReleaseCancel(); true');
    assert.equal(await page.evaluate('window.__cliharborCancelStarts === 1 && window.__cliharborCancelRequests === 1 && !document.body.innerText.includes("Authenticated")'), true, 'late cancellation response must preserve the streamed outcome without another check');
    await page.evaluate('window.fetch = window.__cliharborCancelFetch; window.EventSource = window.__cliharborCancelSource; true');
    await rm(conjurCheckDelay, { force: true });
    const restoredSession = page.waitEvent('Network.requestWillBeSent', isConjurSessionCheckRequest);
    await clickButton(page, 'Re-check session');
    await restoredSession;
    await waitJS(page, 'explicit session re-check after cancellation', 'document.body.innerText.includes("Authenticated")');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

    stage('top-right CLI session status across navigation and narrow layouts');
    await waitJS(page, 'verified sign-in indicator', 'document.querySelector(".cli-sessions:not(.operation-activity) summary")?.textContent.includes("1 signed in")');
    await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent.trim() === "Command Builder").click()');
    await waitJS(page, 'verified session retained on Tasks', 'location.pathname === "/tasks" && document.querySelector(".cli-sessions:not(.operation-activity) summary")?.textContent.includes("1 signed in")');
    for (const width of [1366, 320]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      await page.evaluate('document.querySelector(".cli-sessions:not(.operation-activity) summary").click()');
      await waitJS(page, 'session disclosure open', 'document.querySelector(".cli-sessions:not(.operation-activity)").open');
      const sessionPanel = await page.evaluate('(() => {' +
        'const panel = document.querySelector(".cli-sessions:not(.operation-activity) .cli-sessions-panel"); const bounds = panel.getBoundingClientRect();' +
        'return { fits: bounds.left >= 0 && bounds.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth,' +
        'hasCLI: panel.innerText.includes("conjur"), hasStatus: panel.innerText.includes("Signed in"), hasTime: panel.querySelector("time") !== null };' +
      '})()');
      assert.deepEqual(sessionPanel, { fits: true, hasCLI: true, hasStatus: true, hasTime: true }, 'session panel must identify verified CLIs and fit at ' + width + 'px');
      await capture('cli-sessions-' + width);
      await page.evaluate('document.querySelector(".cli-sessions:not(.operation-activity) summary").focus()');
      await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert.equal(await page.evaluate('!document.querySelector(".cli-sessions:not(.operation-activity)").open && document.activeElement === document.querySelector(".cli-sessions:not(.operation-activity) summary")'), true);
    }
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('document.querySelector(".cli-sessions:not(.operation-activity) summary").click()');
    await page.evaluate('document.querySelector(".cli-sessions:not(.operation-activity) .cli-sessions-panel > a").click()');
    await waitJS(page, 'manage sign-ins retains verified evidence', 'location.pathname === "/authentication" && document.body.innerText.includes("Authenticated") && document.activeElement?.id === "main-content"');

    stage('one-click session check from the top bar');
    const quickSessionRequest = page.waitEvent('Network.requestWillBeSent', isConjurSessionCheckRequest);
    await page.evaluate('document.querySelector(".cli-sessions:not(.operation-activity) summary").click()');
    await page.evaluate('document.querySelector(".cli-session-check").click()');
    const quickSession = await quickSessionRequest;
    assert.deepEqual(JSON.parse(quickSession.request.postData), { packId: 'cyberark-conjur-v9', commandId: 'whoami', values: {} });
    await waitJS(page, 'quick session re-verified', 'document.body.innerText.includes("Authenticated") && document.querySelector(".cli-sessions:not(.operation-activity) summary").textContent.includes("1 signed in")');

    stage('Conjur permissions stay dedicated with verified dropdowns and approval');
    await navigate(page, baseURL + '/dedicated/conjur/access-explorer');
    await waitJS(page, 'dedicated access explorer', 'document.querySelector("#access-heading") !== null');
    await clickButton(page, 'Grant secret permission · Approval required');
    await waitJS(page, 'dedicated permission variable options', 'location.pathname === "/dedicated/conjur" && Array.from(document.querySelectorAll("select option")).some((option) => option.value === "value:apps/db/password")');
    await page.evaluate(`(() => {
      const select = Array.from(document.querySelectorAll('select')).find((control) => control.closest('label')?.textContent.startsWith('Secret variable ID'));
      select.value = 'value:apps/db/password'; select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await clickButton(page, 'Show current permissions');
    await waitJS(page, 'dedicated grantee options', 'Array.from(document.querySelectorAll("select option")).some((option) => option.value === "group:operators")');
    await page.evaluate(`(() => {
      const select = Array.from(document.querySelectorAll('select')).find((control) => control.closest('label')?.textContent.startsWith('Grant access to'));
      select.value = 'group:operators'; select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await clickButton(page, 'Review grant');
    await waitJS(page, 'permission approval in Conjur', 'document.querySelector(".conjur-permissions-form .mutation-approval") !== null');
    assert.equal(await page.evaluate('location.pathname'), '/dedicated/conjur');
    for (const width of [1366, 320]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      await page.evaluate('document.querySelector(".conjur-permissions-form .mutation-approval").scrollIntoView({ block: "center" }); true');
      await capture('conjur-permission-approval-' + width);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Conjur approval must fit at ' + width + 'px: ' + JSON.stringify(await page.evaluate('Array.from(document.querySelectorAll("main *")).filter((element) => element.getClientRects().length > 0 && element.getBoundingClientRect().right > innerWidth).map((element) => ({ tag: element.tagName, class: element.className, text: element.textContent.slice(0, 80), x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width })).slice(0, 15)')));
    }
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('document.querySelector(".conjur-permissions-form .mutation-approval input[type=checkbox]").click()');
    const permissionStart = page.waitEvent('Network.requestWillBeSent', (params) => isRunCreateRequest(params, 'secret-permit', 'cyberark-conjur-v9'));
    await clickButton(page, 'Apply permission change');
    const permissionRequest = JSON.parse((await permissionStart).request.postData);
    assert.deepEqual(permissionRequest.values, { 'policy-branch': 'apps', 'variable-id': 'db/password', 'role-kind': 'group', 'role-id': '/operators', privileges: 'read, execute', 'dry-run': false });
    assert.match(permissionRequest.approval.id, /^[a-f0-9]{32}$/);
    await waitJS(page, 'permission mutation and authoritative readback', 'document.querySelector(".conjur-permissions-form .operation-result")?.textContent.includes("Permissions updated") && document.querySelector(".conjur-permissions-current table")?.textContent.includes("operators")');
    assert.equal(await page.evaluate('location.pathname'), '/dedicated/conjur');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await page.evaluate(`(() => {
      const grants = document.querySelector('.conjur-permissions-table');
      grants.focus(); grants.scrollLeft = grants.scrollWidth;
      const revoke = grants.querySelector('button');
      return document.activeElement === grants && grants.getBoundingClientRect().right <= innerWidth &&
        revoke.getBoundingClientRect().right <= grants.getBoundingClientRect().right + 1;
    })()`), true, 'permission grants must support keyboard focus and keep Revoke reachable by local scrolling');
    await page.evaluate('document.querySelector(".conjur-permissions-table").scrollIntoView({ block: "center" }); true');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'permission readback must fit at 320px');
    await capture('conjur-permission-readback-320');
    await clickButton(page, 'Revoke execute from operators');
    await waitJS(page, 'dedicated revoke review', 'document.querySelector(".conjur-permissions-form .mutation-approval")?.textContent.includes("Revoke execute from operators")');
    assert.equal(await page.evaluate('location.pathname'), '/dedicated/conjur');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await clickButton(page, 'Secrets');
    await waitJS(page, 'secret maintenance ready after permission readback', 'Array.from(document.querySelectorAll("button")).some((button) => button.getAttribute("aria-label") === "Update value" && button.getClientRects().length > 0 && !button.disabled)');
    await clickButton(page, 'Update value');
    await waitJS(page, 'dedicated update action', 'document.querySelector(".conjur-task-panel")?.textContent.includes("Set secret value") && document.querySelector(".conjur-task-panel input[type=password]") !== null');
    assert.equal(await page.evaluate('location.pathname'), '/dedicated/conjur');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('document.querySelector(".conjur-task-panel input[type=password]").scrollIntoView({ block: "center" }); true');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Conjur update selectors must fit at 320px');
    await capture('conjur-update-320');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await waitJS(page, 'update variable inventory', 'Array.from(document.querySelectorAll(".conjur-task-panel select option")).some((option) => option.value === "value:apps/db/password")');
    await page.evaluate(`(() => {
      const variable = document.querySelector('.conjur-task-panel select');
      variable.value = 'value:apps/db/password'; variable.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await setTextInput(page, 'Secret value', 'browser-review-only-fixture');
    await clickButton(page, 'Review action');
    await waitJS(page, 'update preflight and target-bound approval', 'document.querySelector(".conjur-task-panel .mutation-approval")?.textContent.includes("apps/db/password")');
    assert.equal(await page.evaluate('document.querySelector(".conjur-task-panel .mutation-approval").textContent.includes("browser-review-only-fixture")'), false, 'write-only value must stay out of the approved preview');
    assert.equal(await page.evaluate('location.pathname'), '/dedicated/conjur');

    stage('direct run history route');
    await navigate(page, baseURL + '/runs');
    await waitJS(page, 'runs route',
      'location.pathname === "/runs" && document.body.innerText.includes("Recent runs")');
    const runsSurface = await page.evaluate('(() => ({' +
      'horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,' +
      'hasRunsLink: Array.from(document.querySelectorAll("a")).some((link) => link.textContent?.trim() === "Execution History")' +
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
    assert.equal(await page.evaluate('document.querySelector(".execution-summary").open'), false);
    await page.evaluate('document.querySelector(".execution-summary summary").focus()');
    assert.equal(await page.evaluate('document.activeElement === document.querySelector(".execution-summary summary")'), true);
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitJS(page, 'keyboard preflight disclosure', 'document.querySelector(".execution-summary").open');

    stage('tool category filtering');
    await page.evaluate('Array.from(document.querySelectorAll(".tool-explorer-item")).find((button) => button.textContent.includes("fixture")).click()');
    await waitJS(page, 'fixture category', 'document.querySelector(".task-category-filter select").value === "integration/fixture" && document.querySelector(".task-discovery").open');
    assert.equal(await page.evaluate('Array.from(document.querySelectorAll("[data-task-action=select]")).every((button) => button.dataset.taskKey.startsWith("integration/"))'), true, 'category rows must belong to the selected tool');
    await page.evaluate('document.querySelector(".tool-explorer-all").click()');
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
      const selectors = await page.evaluate('(() => ({' +
        'explorer: document.querySelector(".tool-explorer").getBoundingClientRect().width > 0,' +
        'compact: document.querySelector(".task-category-filter").getBoundingClientRect().width > 0' +
      '}))()');
      assert.equal(selectors.explorer, width >= 1100, 'desktop Explorer visibility at ' + width);
      assert.equal(selectors.compact, width < 1100, 'compact selector visibility at ' + width);
      if (width === 1024) {
        await page.evaluate('(() => { const select = document.querySelector(".task-category-filter select"); select.value = "integration/fixture"; select.dispatchEvent(new Event("change", { bubbles: true })); })()');
        await waitJS(page, 'compact filter applies shared scope', 'document.querySelector(".task-category-filter select").value === "integration/fixture" && document.querySelector(".task-scope-banner") !== null');
      }
      if (width < 1024) assert.equal(await page.evaluate('document.querySelector(".task-category-filter select").value'), 'integration/fixture');
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
    await waitJS(page, 'desktop filter after resizing',
      'document.querySelector(".tool-explorer").getBoundingClientRect().width > 0 && Array.from(document.querySelectorAll(".tool-explorer-item")).some((button) => button.getAttribute("aria-pressed") === "true" && button.textContent.includes("fixture"))');
    await page.evaluate('document.querySelector(".tool-explorer-all").click()');

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
    await clickButton(page, 'Validate');
    assert.equal(await page.evaluate('document.querySelector("#task-input-query").validity.valueMissing'), true);
    assert.equal(await page.evaluate('document.activeElement?.id'), 'task-input-query');
    await setTextInput(page, 'Query', 'preview-only');
    await clickButton(page, 'Validate');
    await waitJS(page, 'validated preview', 'document.querySelector(".command-preview-state--valid") !== null');
    await clickButton(page, 'Reset inputs');
    assert.equal(await page.evaluate('document.querySelector("#task-input-query").value'), '');
    assert.equal(await page.evaluate('document.querySelector(".command-preview-state--valid") === null'), true);

    stage('navigation focus and page titles');
    await page.evaluate('Array.from(document.querySelectorAll("nav a")).find((link) => link.textContent.trim() === "Diagnostics").click(); true');
    await waitJS(page, 'diagnostics navigation', 'location.pathname === "/diagnostics" && document.title === "Diagnostics · CLIHarbor" && document.activeElement?.id === "main-content"');
    await page.evaluate('Array.from(document.querySelectorAll("nav a")).find((link) => link.textContent.trim() === "Command Builder").click(); true');
    await waitJS(page, 'tasks navigation', 'location.pathname === "/tasks" && document.title === "Command Builder · CLIHarbor" && document.activeElement?.id === "main-content"');

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
    await clickButton(page, 'Run command');
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
    await clickButton(page, 'Run command');
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

    stage('failed JSON output preserves immediate diagnostics in tasks and history');
    await chooseTask(page, 'integration/fail');
    await setTextInput(page, 'Exit code', '7');
    const failedCreateRequest = page.waitEvent('Network.requestWillBeSent',
      (params) => isRunCreateRequest(params, 'fail'));
    await clickButton(page, 'Run command');
    await failedCreateRequest;
    await waitJS(page, 'failed command diagnostics',
      'document.querySelector(".run-panel h2")?.textContent?.trim() === "Failed · exit 7" && ' +
      'document.querySelector(".output-grid")?.textContent.includes("fixture failure: inspect the target before retrying")');
    const failedRunID = await page.evaluate('document.querySelector(".run-meta dd")?.textContent?.trim()');
    const rawFailure = `(() => ({
      output: Array.from(document.querySelectorAll('.output-explorer pre')).map((pre) => pre.textContent),
      formattedDisabled: Array.from(document.querySelectorAll('.output-view-switch button')).find((button) => button.textContent === 'Formatted')?.disabled,
      rawSelected: Array.from(document.querySelectorAll('.output-view-switch button')).find((button) => button.textContent === 'Raw')?.getAttribute('aria-pressed'),
      fits: document.documentElement.scrollWidth <= innerWidth,
    }))()`;
    const expectedFailure = {
      output: ['{"ok":false}', 'fixture failure: inspect the target before retrying'],
      formattedDisabled: true, rawSelected: 'true', fits: true,
    };
    assert.deepEqual(await page.evaluate(rawFailure), expectedFailure);
    await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent.trim() === "Execution History").click()');
    await waitJS(page, 'history containing failed run',
      'document.querySelector(".run-history-entry")?.textContent.includes("Return fixture exit code")');
    await page.evaluate('document.querySelector(".run-history-entry").click(); true');
    await waitJS(page, 'failed history diagnostics',
      'document.querySelector(".run-history-id")?.textContent === ' + JSON.stringify(failedRunID) +
      ' && document.querySelector(".output-grid")?.textContent.includes("fixture failure: inspect the target before retrying")');
    assert.deepEqual(await page.evaluate(rawFailure), expectedFailure);
    await page.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.deepEqual(await page.evaluate(rawFailure), expectedFailure);
    await page.evaluate('document.querySelector(".output-explorer").scrollIntoView({ block: "start" }); true');
    await capture('failed-run-mobile');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    const failedSnapshot = await fetchJSON(page, '/api/v1/runs/' + failedRunID);
    assert.equal(failedSnapshot.body.exitCode, 7);
    assert.equal(failedSnapshot.body.events.filter((event) => event.type === 'run.started').length, 1);
    await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent.trim() === "Command Builder").click()');

    stage('formatted filter misses preserve successful evidence in tasks and history');
    await chooseTask(page, 'cyberark-conjur-v9/whoami');
    await clickButton(page, 'Run command');
    await waitJS(page, 'successful JSON values', 'document.querySelector(".output-value-list")?.textContent.includes("alice")');
    const filteredRunID = await page.evaluate('document.querySelector(".run-meta dd")?.textContent?.trim()');
    for (const surface of ['tasks', 'history']) {
      if (surface === 'history') {
        await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent.trim() === "Execution History").click()');
        await waitJS(page, 'history containing filtered run', 'document.querySelector(".run-history-entry")?.textContent.includes("Who am I")');
        await page.evaluate('document.querySelector(".run-history-entry").click(); true');
        await waitJS(page, 'selected JSON history evidence', 'document.querySelector(".run-history-id")?.textContent === ' + JSON.stringify(filteredRunID) +
          ' && document.querySelector(".output-value-list")?.textContent.includes("alice")');
      }
      const downloadPath = path.join(chrome.userDataDir, 'result-exports-' + surface);
      await mkdir(downloadPath, { recursive: true });
      await page.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
      await setTextInput(page, 'Find an ID or value', 'alice');
      await waitJS(page, 'filtered export field', 'document.querySelectorAll(".output-value-list li").length === 1');
      for (const format of ['JSON', 'CSV']) {
        await clickButton(page, 'Export ' + format);
        const downloaded = await poll('local ' + format + ' field download', () =>
          readFile(path.join(downloadPath, 'cliharbor-result-' + filteredRunID + '.' + format.toLowerCase()), 'utf8'));
        if (format === 'JSON') {
          const report = JSON.parse(downloaded);
          assert.equal(report.schemaVersion, 'cliharbor.result-fields/v1');
          assert.equal(report.runId, filteredRunID);
          assert.deepEqual(report.fields, [{ field: 'username', value: 'alice' }]);
          assert.deepEqual(Object.keys(report).sort(), ['fields', 'runId', 'schemaVersion']);
        } else {
          assert.match(downloaded, /"Run ID","Field","Present","Value"\r\n/);
          assert.equal(downloaded.includes('"' + filteredRunID + '","username","true","alice"'), true);
        }
      }
      await page.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: false });
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'exports must fit at 320px');
      await capture('result-export-' + surface + '-mobile');
      await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
      await page.evaluate(`(() => {
        const input = document.getElementById('output-value-search');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'no-matching-value');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitJS(page, 'local filter miss', 'document.querySelector(".output-explorer")?.textContent.includes("No values match. Try a different search or switch to Raw.")');
      await page.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: false });
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await clickButton(page, 'Raw');
      assert.equal(await page.evaluate('document.querySelector(".output-grid")?.textContent.includes("alice")'), true);
      await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    }
    const filteredSnapshot = await fetchJSON(page, '/api/v1/runs/' + filteredRunID);
    assert.equal(filteredSnapshot.body.exitCode, 0);
    assert.equal(filteredSnapshot.body.events.filter((event) => event.type === 'run.started').length, 1);

    stage('history filters preserve selected evidence without executing a command');
    await setTextInput(page, 'Search runs', filteredRunID);
    await waitJS(page, 'history run-ID search', 'document.querySelectorAll(".run-history-entry").length === 1');
    await page.evaluate(`(() => {
      const selects = document.querySelectorAll('.run-history-filters select');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(selects[0], 'failed'); selects[0].dispatchEvent(new Event('change', { bubbles: true }));
      setter.call(selects[1], 'cyberark-conjur-v9/conjur'); selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitJS(page, 'combined history filters', 'document.querySelectorAll(".run-history-entry").length === 0 && document.body.innerText.includes("No retained runs match these filters")');
    assert.equal(await page.evaluate('document.querySelector(".output-grid")?.textContent.includes("alice")'), true);
    await page.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: false });
    await capture('history-filters-mobile');
    const filteredGeometry = await page.evaluate(`(() => ({
      fits: document.documentElement.scrollWidth <= innerWidth,
      overflow: Array.from(document.querySelectorAll('main *')).filter((node) => node.getBoundingClientRect().right > innerWidth)
        .slice(0, 12).map((node) => ({ tag: node.tagName, className: node.className, width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right })),
    }))()`);
    assert.equal(filteredGeometry.fits, true, 'history filters must fit at 320px: ' + JSON.stringify(filteredGeometry.overflow));
    await clickButton(page, 'Clear filters');
    await waitJS(page, 'cleared history search', 'document.querySelector(".run-history-filters input") === document.activeElement && document.querySelectorAll(".run-history-entry").length > 0');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent.trim() === "Command Builder").click()');

    stage('compare recorded runs without execution side effects');
    const comparisonIDs = [];
    for (const query of ['comparison-before', 'comparison-after']) {
      await chooseTask(page, 'integration/inspect');
      await setTextInput(page, 'Query', query);
      await clickButton(page, 'Run command');
      await waitJS(page, 'completed comparison fixture', 'document.querySelector(".run-panel h2")?.textContent === "Succeeded" && document.querySelector(".output-explorer")?.textContent.includes(' + JSON.stringify(query) + ')');
      comparisonIDs.push(await page.evaluate('document.querySelector(".run-meta dd")?.textContent?.trim()'));
    }
    await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent.trim() === "Execution History").click()');
    await waitJS(page, 'comparison run history', 'document.querySelectorAll(".run-history-entry").length >= 2');
    await page.evaluate('document.querySelectorAll(".run-history-entry")[1].click(); true');
    await waitJS(page, 'baseline evidence loaded', 'document.querySelector(".run-history-id")?.textContent === ' + JSON.stringify(comparisonIDs[0]) + ' && Array.from(document.querySelectorAll("button")).some((button) => button.textContent === "Pin for comparison" && !button.disabled)');
    await page.evaluate(`(() => {
      const originalFetch = window.fetch;
      window.__cliharborComparisonFetch = originalFetch;
      window.__cliharborComparisonStarts = 0;
      window.fetch = (...args) => {
        if (String(args[0]) === '/api/v1/runs' && args[1]?.method === 'POST') window.__cliharborComparisonStarts++;
        return originalFetch(...args);
      };
    })()`);
    await clickButton(page, 'Pin for comparison');
    await waitJS(page, 'baseline pinned', 'document.querySelector(".run-comparison")?.textContent.includes("Baseline pinned")');
    await page.evaluate('document.querySelectorAll(".run-history-entry")[0].click(); true');
    await waitJS(page, 'selected comparison evidence', 'document.querySelector(".run-history-id")?.textContent === ' + JSON.stringify(comparisonIDs[1]) + ' && document.querySelector(".run-comparison")?.textContent.includes("stdout · Text differs")');
    assert.equal(await page.evaluate('document.querySelector(".run-comparison")?.textContent.includes("comparison-before") && document.querySelector(".run-comparison")?.textContent.includes("comparison-after")'), true);
    assert.equal(await page.evaluate('document.querySelectorAll(".run-comparison-line-changed").length > 0'), true);
    for (const width of [1366, 768, 320]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      await page.evaluate('document.querySelector(".run-comparison").scrollIntoView({ block: "start" }); true');
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'run comparison must fit at ' + width + 'px');
      await capture('run-comparison-' + width);
    }
    await clickButton(page, 'Clear comparison');
    await waitJS(page, 'comparison cleared with focus return', 'document.querySelector(".run-comparison") === null && document.activeElement?.id === "run-history-detail-heading"');
    await page.evaluate('history.back(); true');
    await waitJS(page, 'Back restores the earlier run URL and evidence',
      'location.search === ' + JSON.stringify('?run=' + comparisonIDs[0]) +
      ' && document.querySelector(".run-history-id")?.textContent === ' + JSON.stringify(comparisonIDs[0]) +
      ' && document.querySelector(".run-history-detail-panel")?.textContent.includes("comparison-before")');
    await page.evaluate('history.forward(); true');
    await waitJS(page, 'Forward restores the later run URL and evidence',
      'location.search === ' + JSON.stringify('?run=' + comparisonIDs[1]) +
      ' && document.querySelector(".run-history-id")?.textContent === ' + JSON.stringify(comparisonIDs[1]) +
      ' && document.querySelector(".run-history-detail-panel")?.textContent.includes("comparison-after")');
    assert.equal(await page.evaluate('window.__cliharborComparisonStarts'), 0);
    await page.evaluate('window.fetch = window.__cliharborComparisonFetch; delete window.__cliharborComparisonFetch; true');
    for (const runID of comparisonIDs) {
      const snapshot = await fetchJSON(page, '/api/v1/runs/' + runID);
      assert.equal(snapshot.body.events.filter((event) => event.type === 'run.started').length, 1);
    }
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent.trim() === "Command Builder").click()');

    stage('lost run-start acknowledgement recovers through history without replay');
    await chooseTask(page, 'integration/inspect');
    await setTextInput(page, 'Query', 'lost-acknowledgement-fixture');
    await page.evaluate(`(() => {
      const originalFetch = window.fetch;
      window.__cliharborFetchBeforeLostStart = originalFetch;
      window.__cliharborLostStarts = 0;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (String(args[0]) === '/api/v1/runs' && args[1]?.method === 'POST') {
          window.__cliharborLostStarts++;
          window.__cliharborLostRunID = (await response.clone().json()).runId;
          throw new TypeError('simulated lost acknowledgement after real acceptance');
        }
        return response;
      };
    })()`);
    await clickButton(page, 'Run command');
    await waitJS(page, 'unknown outcome guidance',
      'document.body.innerText.includes("The command start outcome is unknown.") && document.body.innerText.includes("Check Execution History and the target")');
    const lostRunID = await page.evaluate('window.__cliharborLostRunID');
    assert.match(lostRunID, /^[0-9a-f]{32}$/);
    assert.equal(await page.evaluate('window.__cliharborLostStarts'), 1, 'lost acknowledgement must never trigger automatic replay');
    await page.evaluate('window.fetch = window.__cliharborFetchBeforeLostStart; true');
    await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent.trim() === "Execution History").click()');
    await waitJS(page, 'history after lost acknowledgement', 'document.querySelectorAll(".run-history-entry").length > 0');
    await page.evaluate('document.querySelector(".run-history-entry").click(); true');
    await waitJS(page, 'authoritative history evidence for accepted run',
      'document.querySelector(".run-history-id")?.textContent === ' + JSON.stringify(lostRunID) +
      ' && document.querySelector(".run-history-detail-panel")?.textContent.includes("lost-acknowledgement-fixture")');
    const recoveredStart = await fetchJSON(page, '/api/v1/runs/' + lostRunID);
    assert.equal(recoveredStart.body.status, 'exited');
    assert.equal(recoveredStart.body.events.filter((event) => event.type === 'run.started').length, 1);
    assert.equal(await page.evaluate('window.__cliharborLostStarts'), 1);

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

    stage('silent sse reconciliation and cancellation');
    const eventSourceTrackerInstalled = await page.evaluate('(() => {' +
      'if (window.__cliharborNativeEventSource) return true;' +
      'const NativeEventSource = window.EventSource;' +
      'window.__cliharborNativeEventSource = NativeEventSource;' +
      'window.__cliharborE2ESources = [];' +
      'window.__cliharborNativeTimer = window.setTimeout;' +
      'window.setTimeout = (callback, ms, ...args) => {' +
        'if (ms === 45000) window.__cliharborIdleDeadline = callback;' +
        'return window.__cliharborNativeTimer(callback, ms, ...args);' +
      '};' +
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
    await clickButton(page, 'Run command');
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

    stage('visible command work and disabled repeat action');
    assert.equal(await page.evaluate('document.querySelector(".run-button").disabled && document.querySelector(".run-button").getAttribute("aria-busy") === "true"'), true);
    assert.equal(await page.evaluate('document.querySelector(".working-status").textContent.includes("Command running") && document.querySelector(".working-status .work-spinner") !== null'), true);
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".run-button"), "::before").clipPath'), 'none', 'busy spinner must replace the existing play icon');
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".run-button"), "::before").backgroundColor'), 'rgba(0, 0, 0, 0)');
    await page.evaluate('document.querySelector(".run-button").click()');
    for (const width of [1366, 320]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      await page.evaluate('document.querySelector(".working-status").scrollIntoView({ block: "end" })');
      assert.equal(await page.evaluate('(() => { const rect = document.querySelector(".working-status").getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth; })()'), true, 'working status must remain visible and fit at ' + width + 'px');
      await capture('working-' + width);
    }
    await page.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".work-spinner")).animationName'), 'none');
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".run-button"), "::before").animationName'), 'none');
    await page.call('Emulation.setEmulatedMedia', { features: [] });
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

    stage('global activity remains available across routes');
    await page.call('Page.bringToFront');
    await waitJS(page, 'global running activity', 'document.querySelector(".operation-activity summary").textContent.includes("running")');
    await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent.trim().startsWith("Diagnostics")).click()');
    await waitJS(page, 'running activity on Diagnostics', 'location.pathname === "/diagnostics" && document.querySelector(".operation-activity summary").textContent.includes("running")');
    for (const width of [1366, 320]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
      await page.evaluate('document.querySelector(".operation-activity summary").click()');
      assert.equal(await page.evaluate('(() => { const rect = document.querySelector(".operation-activity .cli-sessions-panel").getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; })()'), true, 'activity menu must fit at ' + width + 'px');
      await capture('global-activity-' + width);
      await page.evaluate('document.querySelector(".operation-activity summary").click()');
    }
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('document.querySelector(".operation-activity summary").click()');
    await page.evaluate('Array.from(document.querySelectorAll(".operation-activity a")).find((link) => link.getAttribute("href").endsWith(' + JSON.stringify(waitRunID) + ')).click()');
    await waitJS(page, 'activity opens exact retained run', 'location.pathname === "/runs" && location.search === ' + JSON.stringify('?run=' + waitRunID) + ' && document.querySelector(".run-history-id")?.textContent.trim() === ' + JSON.stringify(waitRunID));
    await page.evaluate('Array.from(document.querySelectorAll(".primary-nav a")).find((link) => link.textContent.trim() === "Command Builder").click()');
    await waitJS(page, 'return to running command without replay', 'location.pathname === "/tasks" && document.querySelector(".run-panel h2")?.textContent.trim() === "Running"');

    const reconciliationRequest = page.waitEvent('Network.requestWillBeSent',
      (params) => params.request?.url === baseURL + '/api/v1/runs/' + waitRunID && params.request?.method === 'GET',
      5000);
    const forcedStreamFailure = await page.evaluate('(() => {' +
      'const sources = window.__cliharborE2ESources ?? [];' +
      'const source = sources[sources.length - 1];' +
      'if (!source || typeof window.__cliharborIdleDeadline !== "function") return false;' +
      'source.close();' +
      // Expire the real subscriber's timer after silencing its native socket.
      // Unit tests verify the 45s duration; keep the 30s fixture cancellable here.
      'window.__cliharborIdleDeadline();' +
      'window.setTimeout = window.__cliharborNativeTimer;' +
      'return true;' +
    '})()');
    assert.equal(forcedStreamFailure, true, 'tracked live EventSource should be interruptible by the harness');

    await waitJS(page, 'silent EventSource deadline exposes recovery',
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
    assert.equal(await page.evaluate('document.querySelector(".working-status").textContent === "" && document.querySelector(".run-button").getAttribute("aria-busy") === "false"'), true, 'busy feedback must clear when the command ends');
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
      'inDedicated: document.querySelector(".section-switcher a[aria-current=page]")?.getAttribute("href") === "/dedicated" && document.querySelector(".breadcrumbs").textContent.includes("Security audit"),' +
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

