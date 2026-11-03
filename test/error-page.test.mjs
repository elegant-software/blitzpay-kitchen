import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorPage } from '../dist/renderer/error-page.js';

test('errorPage names what failed and why, and escapes it', () => {
  const html = errorPage('Cannot reach http://localhost:8080/<x>', 'ERR_CONNECTION_REFUSED', 10);
  assert.match(html, /Cannot reach http:\/\/localhost:8080\/&#60;x&#62;/);
  assert.match(html, /ERR_CONNECTION_REFUSED/);
  assert.match(html, /10 s/);
  assert.doesNotMatch(html, /<x>/);
});
