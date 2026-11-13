const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'kitchen-station-ui-')));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const windows = [];
let mock;
let fatal;
ipcMain.on('smoke:fatal', (_, message) => { fatal = message; });
const waitFor = async predicate => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (fatal) throw new Error(fatal);
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Renderer smoke check timed out');
};
app.whenReady().then(async () => {
  try {
    mock = spawn(process.execPath, [path.join(root, 'mock/server.mjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: '0', EVENT_SECONDS: '60000' }, windowsHide: true });
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Mock startup timeout')), 10000);
      mock.once('error', reject);
      mock.stdout.on('data', data => { const match = String(data).match(/localhost:(\d+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    });
    const base = `http://localhost:${port}`;
    const kitchen = base + '/v1/merchant/branches/demo/kitchen';
    protocol.handle('app', req => {
      const file = path.join(root, decodeURIComponent(new URL(req.url).pathname));
      if (!file.startsWith(root + path.sep)) return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    const stations = await (await fetch(kitchen + '/stations')).json();
    for (const name of ['Food Kitchen', 'Drinks Bar']) {
      const station = stations.find(s => s.name === name);
      const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'ui-smoke-preload.cjs'), additionalArguments: [`--api=${base}`, `--station=${station.id}`], autoplayPolicy: 'no-user-gesture-required' } });
      windows.push(win);
      await win.loadURL('app://kitchen/renderer/index.html');
      await waitFor(() => win.webContents.executeJavaScript(`document.querySelector('#grid .card') !== null`));
    }
    const screen = windows[0];
    const selectLanguage = value => screen.webContents.executeJavaScript(`document.querySelector('#language').click(); document.querySelector('[data-language="${value}"]').click();`);
    await selectLanguage('de');
    assert.equal(await screen.webContents.executeJavaScript(`document.documentElement.lang`), 'de');
    assert.equal(await screen.webContents.executeJavaScript(`document.querySelector('#language').getAttribute('aria-label')`), 'Sprache: Deutsch');
    assert.ok(await screen.webContents.executeJavaScript(`document.querySelector('#grid').textContent.includes('Zubereiten')`));
    // Await the real reload: polling right after reload() could still see the old document.
    await screen.loadURL(screen.webContents.getURL());
    await waitFor(() => screen.webContents.executeJavaScript(`document.querySelector('#grid .card') !== null`));
    assert.equal(await screen.webContents.executeJavaScript(`document.documentElement.lang`), 'de');
    await selectLanguage('en');
    assert.ok(await screen.webContents.executeJavaScript(`document.querySelector('#grid').textContent.includes('Preparing')`));
    assert.equal(await screen.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#logo')).opacity`), '0.12');
    const cards = async win => win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#grid .card')).map(card => ({ id: card.dataset.id, pickup: card.querySelector('.pickup').textContent, text: card.textContent }))`);
    const food = (await cards(windows[0])).find(card => card.pickup === '#042');
    const drinks = (await cards(windows[1])).find(card => card.pickup === '#042');
    assert.ok(food.text.includes('Burger') && !food.text.includes('Cola'));
    assert.ok(drinks.text.includes('Cola') && !drinks.text.includes('Burger'));
    assert.ok(food.text.includes('Table 7') && drinks.text.includes('Table 7'));
    assert.ok(food.text.includes('TAKE-AWAY') && drinks.text.includes('TAKE-AWAY'));
    const stationId = stations.find(s => s.name === 'Drinks Bar').id;
    for (const status of ['PREPARING', 'READY']) {
      const response = await fetch(`${kitchen}/stations/${stationId}/orders/${drinks.id}/preparation-status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      assert.equal(response.status, 200);
    }
    await waitFor(async () => !(await cards(windows[1])).some(card => card.id === drinks.id));
    assert.ok((await cards(windows[0])).some(card => card.id === food.id));
    console.log('PASS: two Electron renderers show separate #42 tickets at Table 7; drinks completion leaves food visible.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const win of windows) win.destroy();
    mock?.kill();
    app.exit(process.exitCode || 0);
  }
});
