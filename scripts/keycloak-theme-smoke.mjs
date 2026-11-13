// Real Keycloak integration check. Only creates/removes its own disposable container.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const image = process.env.KEYCLOAK_TEST_IMAGE || 'quay.io/keycloak/keycloak:26.8.1';
const name = 'kitchen-theme-test-' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex');
const realm = 'kitchen-theme-test';
const callback = 'http://127.0.0.1:18999/callback';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let base;
let adminToken;
let started = false;
const cookies = new Map();
const decode = text => text.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), ...options.headers },
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0];
    cookies.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
  }
  return response;
}
async function admin(resource, method = 'GET', body) {
  const response = await fetch(base + '/admin/realms' + resource, {
    method, signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, 'Admin API ' + method + ' ' + resource + ': ' + response.status);
  return response;
}
function authorization(clientId = 'blitzpay-kitchen', locale = 'en') {
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: callback, response_type: 'code', scope: 'openid offline_access',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    state: randomBytes(12).toString('hex'), nonce: randomBytes(12).toString('hex'), prompt: 'login', kc_locale: locale,
  });
  return { verifier, url: base + '/realms/' + realm + '/protocol/openid-connect/auth?' + params };
}
async function loginPage(auth) {
  let response = await request(auth.url);
  for (let n = 0; response.status === 302 && n < 5; n++) response = await request(new URL(response.headers.get('location'), response.url));
  assert.equal(response.status, 200);
  return response.text();
}
function action(html) {
  const value = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1];
  assert.ok(value, 'Keycloak rendered the login form');
  return decode(value);
}
async function submit(html, pass) {
  return request(action(html), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'kitchen-test', password: pass, credentialId: '' }) });
}
async function authenticate(pass) {
  const auth = authorization();
  const html = await loginPage(auth);
  const response = await submit(html, pass);
  assert.equal(response.status, 302, 'Provisioned Kitchen Login authenticates');
  const redirect = new URL(response.headers.get('location'));
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.ok(redirect.searchParams.get('code'), 'Authorization code returned');
  const token = await fetch(base + '/realms/' + realm + '/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'blitzpay-kitchen',
      redirect_uri: callback, code: redirect.searchParams.get('code'), code_verifier: auth.verifier }),
  });
  assert.equal(token.status, 200, 'PKCE code exchange succeeds');
  const tokens = await token.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  return tokens;
}

try {
  docker('run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::8080',
    '--env', 'KC_BOOTSTRAP_ADMIN_USERNAME=theme-test-admin', '--env', 'KC_BOOTSTRAP_ADMIN_PASSWORD=' + password,
    '--mount', 'type=bind,source=' + path.join(root, 'keycloak/themes/blitzpay-kitchen') + ',target=/opt/keycloak/themes/blitzpay-kitchen,readonly',
    image, 'start-dev');
  started = true;
  const port = docker('port', name, '8080/tcp').split(':').at(-1);
  base = 'http://127.0.0.1:' + port;
  console.log('Waiting for isolated Keycloak (' + image + ')…');
  let ready = false;
  for (let n = 0; n < 90; n++) {
    try { ready = (await fetch(base + '/realms/master', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await sleep(1000);
  }
  assert.ok(ready, 'Keycloak started within 90 seconds');
  const token = await fetch(base + '/realms/master/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'theme-test-admin', password }),
  });
  assert.equal(token.status, 200);
  adminToken = (await token.json()).access_token;
  await admin('', 'POST', { realm, enabled: true, registrationAllowed: true, resetPasswordAllowed: true,
    rememberMe: true, loginWithEmailAllowed: true, registrationEmailAsUsername: false,
    internationalizationEnabled: true, supportedLocales: ['en', 'de'], defaultLocale: 'en' });
  for (const clientId of ['blitzpay-kitchen', 'control-client']) {
    await admin('/' + realm + '/clients', 'POST', { clientId, enabled: true, publicClient: true,
      standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: [callback],
      attributes: { 'pkce.code.challenge.method': 'S256', login_theme: clientId === 'blitzpay-kitchen' ? 'blitzpay-kitchen' : 'keycloak' } });
  }
  await admin('/' + realm + '/identity-provider/instances', 'POST', { alias: 'google', providerId: 'google',
    enabled: true, config: { clientId: 'smoke-test-only', clientSecret: 'not-a-real-secret' } });
  const created = await admin('/' + realm + '/users', 'POST', { username: 'kitchen-test', enabled: true,
    email: 'kitchen-test@kitchen.invalid', emailVerified: true, firstName: 'Kitchen', lastName: 'Test',
    credentials: [{ type: 'password', value: password, temporary: false }] });
  const userId = created.headers.get('location').split('/').at(-1);
  const user = await (await admin('/' + realm + '/users/' + userId)).json();
  assert.equal(user.username, 'kitchen-test', 'Realm preserves backend-provisioned usernames');
  await admin('/' + realm + '/users/' + userId + '/reset-password', 'PUT', { type: 'password', value: password, temporary: false });
  const auth = authorization();
  const html = await loginPage(auth);
  assert.match(html, /Ready for service/);
  assert.match(html, /<label for="username">Username<\/label>/);
  assert.doesNotMatch(html, /id="social-|id="kc-registration|login-actions\/registration|login-actions\/reset-credentials/);
  const bad = await submit(html, 'incorrect-password');
  assert.equal(bad.status, 200);
  const errorHtml = await bad.text();
  assert.match(errorHtml, /id="input-error"/);
  assert.match(errorHtml, /aria-invalid="true"/);
  assert.match(errorHtml, /value="kitchen-test"/);
  console.log('PASS: kitchen-only form, username label, retained username and accessible invalid-credential feedback.');

  const tokens = await authenticate(password);
  const refreshed = await fetch(base + '/realms/' + realm + '/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'blitzpay-kitchen', refresh_token: tokens.refresh_token }),
  });
  assert.equal(refreshed.status, 200, 'Offline refresh succeeds');
  const replacement = randomBytes(24).toString('hex');
  await admin('/' + realm + '/users/' + userId + '/reset-password', 'PUT', { type: 'password', value: replacement, temporary: false });
  const old = await submit(await loginPage(authorization()), password);
  assert.equal(old.status, 200);
  assert.match(await old.text(), /id="input-error"/);
  await authenticate(replacement);
  console.log('PASS: native login, PKCE exchange, offline refresh, manager password reset and rejection of old password.');

  const control = await loginPage(authorization('control-client'));
  assert.match(control, /id="social-google"/);
  assert.match(control, /id="kc-registration"/);
  assert.match(control, /login-actions\/reset-credentials/);
  const localizedPage = await loginPage(authorization());
  const germanLink = localizedPage.match(/href="([^"]*kc_locale=de)"/)?.[1];
  assert.ok(germanLink, 'German language selector is available');
  const german = await request(new URL(decode(germanLink), base));
  assert.ok((await german.text()).includes('Bereit für den Service'), 'Selecting German translates the kitchen page');
  console.log('PASS: other clients retain Google, registration and password recovery; German kitchen login renders.');

  const electron = process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe'
    : process.platform === 'darwin' ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    : 'node_modules/electron/dist/electron';
  const preview = spawn(path.join(root, electron), [
    path.join(root, 'scripts/keycloak-theme-preview.cjs'), authorization().url,
  ], { windowsHide: true, stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    preview.once('error', reject);
    preview.once('exit', code => code === 0 ? resolve() : reject(new Error('Electron theme preview failed: ' + code)));
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (started) docker('rm', '--force', name);
}
