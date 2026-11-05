import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKitchenApi } from '../dist/renderer/kitchen-api.js';

test('a rejected session refreshes once and retries the request with new credentials', async () => {
  const refreshes = [];
  const api = createKitchenApi('http://backend', {
    mock: false,
    headers: async force => { refreshes.push(force); return { Authorization: force ? 'Bearer refreshed' : 'Bearer initial' }; },
    login: async () => assert.fail('valid refreshed session should not require login'),
  }, async (_url, init) => new Response('', { status: init.headers.get('Authorization') === 'Bearer refreshed' ? 200 : 401 }));
  assert.equal((await api('/stations')).status, 200);
  assert.deepEqual(refreshes, [false, true]);
});

test('mock mode against a real authenticated API identifies the terminal override', async () => {
  const api = createKitchenApi('http://backend', { mock: true, headers: async () => ({}), login: async () => assert.fail('mock cannot login') }, async () => new Response('', { status: 401 }));
  await assert.rejects(api('/stations'), /MOCK_AUTH=0/);
});

test('a rejected refreshed session asks for a fresh login instead of looping 401 forever', async () => {
  let logins = 0;
  const api = createKitchenApi('http://backend', { mock: false, headers: async () => ({ Authorization: 'Bearer rejected' }), login: async () => { logins++; } }, async () => new Response('', { status: 401 }));
  await assert.rejects(api('/stations'), /Sign in again/);
  assert.equal(logins, 1);
});
