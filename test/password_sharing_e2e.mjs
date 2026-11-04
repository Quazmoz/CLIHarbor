import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ChromeHarness } from './browser_e2e.mjs';

const invitation = process.env.CLIHARBOR_E2E_PASSWORD_INVITATION;
if (!invitation) throw new Error('missing isolated password receiver invitation');
const url = new URL(invitation);
const fields = new URLSearchParams(url.hash.slice(1));
const trustedSPKI = Buffer.from(fields.get('pin'), 'hex').toString('base64');
const chrome = await ChromeHarness.start({ trustedSPKI });
const page = await chrome.newPage();
const wait = async (expression) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('password-sharing browser condition timed out: ' + expression);
};
try {
  await page.call('Page.navigate', { url: invitation });
  await wait('document.querySelector("#password")?.disabled === false');
  assert.equal(await page.evaluate('location.hash'), '', 'invitation capability must leave browser history immediately');
  for (const width of [1366, 320]) {
    await page.call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'sender form must fit at ' + width);
    if (process.env.CLIHARBOR_E2E_SCREENSHOT_DIR) {
      await mkdir(process.env.CLIHARBOR_E2E_SCREENSHOT_DIR, { recursive: true });
      const screenshot = await page.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(process.env.CLIHARBOR_E2E_SCREENSHOT_DIR, 'password-sender-' + width + '.png'), Buffer.from(screenshot.data, 'base64'));
    }
  }
  await page.evaluate(`(() => {
    window.__passwordPosts = 0;
    const original = window.fetch;
    window.fetch = (...args) => { if (args[0] === '/deliver') window.__passwordPosts++; return original(...args); };
    document.querySelector('#password').value = 'browser-wire-fixture';
    document.querySelector('#confirmed').checked = true;
    document.querySelector('#submit').focus();
  })()`);
  assert.equal(await page.evaluate('document.body.innerText.includes("browser-wire-fixture")'), false);
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait('document.querySelector("#status").textContent.includes("Password delivered")');
  assert.equal(await page.evaluate('document.querySelector("#password").value === "" && document.querySelector("#submit").disabled && window.__passwordPosts === 1'), true);
  assert.equal(await page.evaluate('localStorage.length + sessionStorage.length'), 0, 'no browser persistence');
  assert.equal(await page.evaluate('(async () => (await fetch("/api/v1/runs")).status)()'), 404, 'no remote command API');
  const replay = await page.evaluate(`(async () => (await fetch('/deliver', { method: 'POST', headers: {
    Authorization: 'Bearer ' + ${JSON.stringify(fields.get('token'))}, 'Content-Type': 'text/plain'
  }, body: 'replacement-fixture' })).status)()`);
  assert.equal(replay, 403, 'invitation can accept only one submission');
  console.log('CLIHarbor password sender browser E2E passed');
} finally {
  page.close(); await chrome.close();
}
