import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConnectionConfig, verifyKeycloak, fetchService } from '../dist/renderer/connections.js';

const config = { apiBaseUrl: 'http://localhost:8080', branchId: 'real-branch', keycloakUrl: 'http://127.0.0.1:8084', keycloakRealm: 'blitzpay', mockAuth: false };

test('real screens reject the untouched demo defaults before navigating to login', () => {
  assert.throws(() => validateConnectionConfig({ ...config, branchId: 'demo-branch' }), /KITCHEN_BRANCH_ID/);
  assert.doesNotThrow(() => validateConnectionConfig({ ...config, branchId: 'demo-branch', mockAuth: true }));
});

test('a backend address used as Keycloak reports the failing realm URL and status', async () => {
  await assert.rejects(verifyKeycloak(config, async () => new Response('', { status: 401 })), /Keycloak.*127\.0\.0\.1:8084.*HTTP 401/);
});

test('unreachable API errors identify the API rather than saying only Failed to fetch', async () => {
  await assert.rejects(fetchService('http://localhost:8787/v1/test', 'Kitchen API', {}, async () => { throw new TypeError('Failed to fetch'); }), /Cannot reach Kitchen API at http:\/\/localhost:8787/);
});

test('mock mode never contacts Keycloak and real mode verifies realm discovery', async () => {
  await verifyKeycloak({ ...config, mockAuth: true }, async () => { throw new Error('must not contact Keycloak'); });
  let requested = '';
  await verifyKeycloak(config, async url => { requested = String(url); return Response.json({ issuer: 'http://127.0.0.1:8084/realms/blitzpay' }); });
  assert.equal(requested, 'http://127.0.0.1:8084/realms/blitzpay/.well-known/openid-configuration');
});
