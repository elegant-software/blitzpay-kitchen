import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appVersion, backendVersion } from '../dist/version.js';

test('packaged builds show the release tag, local runs show dev', () => {
  assert.equal(appVersion(true, '1.3.0'), 'v1.3.0');
  assert.equal(appVersion(false, '0.1.0'), 'dev');
});

test('backend version comes from build.version of /actuator/info and fails soft', async () => {
  let called;
  const ok = async (url) => { called = url; return Response.json({ build: { version: 'v2.26.0' } }); };
  assert.equal(await backendVersion('http://backend/', ok), 'v2.26.0');
  assert.equal(called, 'http://backend/actuator/info');
  assert.equal(await backendVersion('http://backend', async () => new Response('', { status: 404 })), 'unknown');
  assert.equal(await backendVersion('http://backend', async () => Response.json({})), 'unknown');
  assert.equal(await backendVersion('http://backend', async () => { throw new TypeError('fetch failed'); }), 'unknown');
});
