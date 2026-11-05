// Real Electron rendering and interaction checks; run with npm run test:ui.
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { createServer } = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(os.tmpdir(), `blitzpay-ui-${process.pid}`));
app.commandLine.appendSwitch('lang', process.env.UI_TEST_LANG || 'en-US');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const clients = new Set();
const orders = Array.from({ length: 30 }, (_, n) => ({
  orderId: `order-${n}`, orderCode: `BP-${n}`, pickupNumber: n + 1, orderType: 'PRE_ORDER',
  receivedAt: new Date(Date.now() - (35 - n) * 60_000).toISOString(),
  preparationStatus: n === 0 ? 'PREPARING' : 'RECEIVED', cancelled: false, shopperFirstName: 'Anna',
  items: Array.from({ length: n === 0 ? 40 : 3 }, (_, i) => ({ itemId: `item-${i}`, name: ['Pide mit Spinat und Käse', 'Nan û Köfte', 'Meze'][i % 3], quantity: i + 1, locked: false })),
}));
let failNext = false, server, win;
const emit = o => { for (const c of clients) c.write(`event: order.changed\ndata: ${JSON.stringify(o)}\n\n`); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const js = source => win.webContents.executeJavaScript(source, true);
async function until(source, label) {
  for (let i = 0; i < 100; i++) { if (await js(source)) return; await wait(50); }
  throw Error(`Timed out: ${label}`);
}
const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);

app.whenReady().then(async () => {
  server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.end();
    if (req.url.endsWith('/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); clients.add(res);
      req.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'POST') {
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        if (failNext) { failNext = false; res.writeHead(503); return res.end(); }
        const o = orders.find(o => req.url.includes(`/orders/${o.orderId}/`));
        o.preparationStatus = JSON.parse(body).status;
        res.writeHead(204); res.end(); emit(o);
      }); return;
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(orders.filter(o => o.preparationStatus !== 'READY')));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  ipcMain.handle('config', () => ({ mockAuth: true, apiBaseUrl: `http://127.0.0.1:${server.address().port}`, branchId: 'test', overdueMinutes: 15 }));
  protocol.handle('app', req => net.fetch(pathToFileURL(path.join(root, decodeURIComponent(new URL(req.url).pathname))).href));
  win = new BrowserWindow({ width: 1600, height: 900, useContentSize: true, show: false,
    webPreferences: { preload: path.join(root, 'dist/preload.cjs'), autoplayPolicy: 'no-user-gesture-required' } });
  const errors = [];
  win.webContents.on('console-message', (_event, ...args) => {
    const details = args[0];
    if (details && typeof details === 'object' && details.level === 'error') errors.push(details.message);
  });
  await win.loadURL('app://kitchen/renderer/index.html');
  await until(`document.querySelectorAll('[data-select]').length === 30 && document.querySelector('#connection').classList.contains('connected')`, '30 orders and connection');
  assert.equal(await js(`document.querySelector('#detail').dataset.order`), 'order-0');
  assert.ok(await js(`document.querySelector('.brand img').naturalWidth > 0`), 'bundled logo loads');
  assert.ok(await js(`document.querySelector('#queue').scrollHeight > document.querySelector('#queue').clientHeight`), 'queue scrolls');
  assert.ok(await js(`document.querySelector('.items-scroll').scrollHeight > document.querySelector('.items-scroll').clientHeight`), 'items scroll');
  assert.ok(await js(`document.querySelector('.action').getBoundingClientRect().bottom <= innerHeight`), 'action stays onscreen');
  const screenshot = path.join(os.tmpdir(), `blitzpay-kitchen-${process.env.UI_TEST_LANG || 'en'}.png`);
  await wait(300); // Allow Chromium to paint after DOM reconciliation in a hidden window.
  require('node:fs').writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('.items-scroll').scrollTop = 200; document.querySelector('#queue').scrollTop = 300`);
  orders[5].items[0].quantity = 9; emit(orders[5]);
  await until(`document.querySelector('[data-select="order-5"] .changed')`, 'background change');
  assert.equal(await js(`document.querySelector('#detail').dataset.order`), 'order-0');
  assert.equal(await js(`document.querySelector('.items-scroll').scrollTop`), 200);
  assert.ok(Math.abs(await js(`document.querySelector('#queue').scrollTop`) - 300) < 2, 'queue scroll preserved within pixel rounding');
  await click('[data-select="order-5"]');
  assert.ok(await js(`document.querySelector('[data-advance]').disabled`), 'changed preparation blocked');
  await click('[data-ack]');
  failNext = true; await click('[data-advance]');
  await until(`document.querySelector('[data-retry]')`, 'failed update retained');
  await click('[data-retry]');
  await until(`!document.querySelector('[data-retry]') && !document.querySelector('[data-advance]').disabled`, 'retry successful');
  orders[5].cancelled = true; emit(orders[5]);
  await until(`document.querySelector('[data-dismiss]')`, 'cancellation');
  await click('[data-filter="PREPARING"]');
  assert.ok(await js(`document.querySelector('[data-select="order-5"]')`), 'cancellation in preparing filter');
  await click('[data-filter="RECEIVED"]');
  assert.ok(await js(`document.querySelector('[data-select="order-5"]')`), 'cancellation in new filter');
  await click('[data-dismiss]');
  assert.equal(await js(`document.querySelector('#detail').dataset.order`), 'order-0');
  assert.equal(await js(`document.querySelector('[data-filter="all"]').getAttribute('aria-pressed')`), 'true');
  await click('[data-advance]');
  assert.equal(await js(`document.querySelector('#detail').dataset.order`), 'order-1');
  assert.ok(await js(`document.querySelector('[data-countdown]').textContent.includes('10')`), '10 second Undo');
  await click('[data-undo]');
  assert.equal(await js(`document.querySelector('#detail').dataset.order`), 'order-1');
  await click('[data-select="order-0"]'); await click('[data-advance]');
  await until(`document.querySelector('[data-undo]')`, 'second ready');
  await wait(10_500);
  await until(`!document.querySelector('[data-select="order-0"]') && !document.querySelector('[data-undo]')`, 'Ready committed');
  orders[0].items.forEach(i => i.locked = true);
  orders[0].items.push({ itemId: 'extra', name: 'Extra Pide', quantity: 2, locked: false });
  orders[0].preparationStatus = 'RECEIVED'; emit(orders[0]);
  await until(`document.querySelector('[data-select="order-0"] .changed')`, 'reopened');
  assert.equal(await js(`document.querySelector('#detail').dataset.order`), 'order-1');
  await click('[data-select="order-0"]');
  assert.ok(await js(`document.querySelector('.prepared') && document.querySelector('[data-ack]')`), 'reopened sections and acknowledgement');
  await click('[data-ack]');
  for (const c of clients) c.end();
  await until(`!document.querySelector('#offline').classList.contains('hidden')`, 'offline banner');
  assert.ok(await js(`document.querySelector('[data-advance]').disabled`), 'offline action blocked');
  assert.equal(await js(`document.querySelectorAll('[data-select]').length`), 29);
  await until(`document.querySelector('#offline').classList.contains('hidden')`, 'reconnect');
  await click('#mute'); assert.equal(await js(`document.querySelector('#mute').getAttribute('aria-pressed')`), 'true');
  assert.ok(await js(`document.querySelector('#mute svg') && document.querySelector('#mute').getAttribute('aria-label')`), 'mute icon has accessible label');
  await click('#theme');
  assert.equal(await js(`document.documentElement.dataset.theme`), 'light');
  assert.equal(await js(`localStorage.getItem('theme')`), 'light');
  assert.ok(await js(`document.querySelector('#theme svg') && document.querySelector('#theme').getAttribute('aria-label')`), 'theme icon has accessible label');
  assert.equal(await js(`getComputedStyle(document.documentElement).colorScheme`), 'light');
  await win.webContents.reload();
  await until(`document.documentElement.dataset.theme === 'light' && document.querySelector('#mute[aria-pressed="true"] svg')`, 'theme and mute persist after reload');
  await click('#theme');
  assert.equal(await js(`document.documentElement.dataset.theme`), 'dark');
  assert.deepEqual(errors, []);
  console.log(`PASS: Electron UI: 30 orders, scrolling, focus, changes, cancellations, retries, Ready Undo, reopened orders, offline/reconnect, mute. Screenshot: ${screenshot}`);
  app.exit(0);
}).catch(err => { console.error(err); app.exit(1); });
