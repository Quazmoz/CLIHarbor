import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDevToolsActivePort } from './browser_harness_helpers.mjs';

test('parses the Chrome-owned DevTools port from the active-port file', () => {
  assert.equal(parseDevToolsActivePort('43123\n/devtools/browser/abc123\n'), 43123);
  assert.equal(parseDevToolsActivePort('9222\r\n/devtools/browser/abc123\r\n'), 9222);
});

test('rejects incomplete, malformed, and out-of-range active-port content', () => {
  for (const raw of ['', '\n', '0\n', '65536\n', '-1\n', 'abc\n', '123abc\n', '123456\n']) {
    assert.equal(parseDevToolsActivePort(raw), undefined, raw);
  }
  assert.equal(parseDevToolsActivePort(undefined), undefined);
});
