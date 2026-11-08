// Render a real Keycloak authorization URL in hidden Electron windows.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'kitchen-theme-preview-')));
const url = process.argv[2];
const output = path.resolve(__dirname, '../test-results');
app.whenReady().then(async () => {
  let win;
  try {
    assert.ok(url && ['http:', 'https:'].includes(new URL(url).protocol), 'Supply a real Keycloak authorization URL');
    fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1280, height: 900, useContentSize: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    await win.loadURL(url);
    const checks = await win.webContents.executeJavaScript(`(() => {
      const form = document.getElementById('kc-form-login');
      const toggle = document.getElementById('kitchen-password-toggle');
      const password = document.getElementById('password');
      const input = document.getElementById('username');
      if (!form || !toggle || !password || !input) throw new Error('Missing kitchen form');
      toggle.click();
      const visible = password.type === 'text' && toggle.getAttribute('aria-pressed') === 'true';
      toggle.click();
      return {
        visible, hidden: password.type === 'password' && toggle.getAttribute('aria-pressed') === 'false',
        forbidden: !!document.querySelector('#kc-registration, #social-google'),
        username: input.labels[0].textContent,
        touch: [input, password, toggle, document.getElementById('kc-login')].every(el => el.getBoundingClientRect().height >= 44),
        buttonSpacing: document.getElementById('kc-login').getBoundingClientRect().top - password.getBoundingClientRect().bottom >= 20,
      };
    })()`);
    assert.deepEqual(checks, { visible: true, hidden: true, forbidden: false, username: 'Username', touch: true, buttonSpacing: true });
    // Check real keyboard navigation follows the visible form controls.
    await win.webContents.executeJavaScript("document.getElementById('username').focus()");
    for (const expected of ['password', 'kitchen-password-toggle', 'kc-login']) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(await win.webContents.executeJavaScript('document.activeElement.id'), expected);
    }
    await win.webContents.executeJavaScript("document.getElementById('username').focus()");
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(output, 'kitchen-login-desktop.png'), (await win.webContents.capturePage()).toPNG());
    for (const [width, height] of [[390, 844], [1024, 600]]) {
      win.setContentSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 150));
      const layout = await win.webContents.executeJavaScript(`({
        overflow: document.documentElement.scrollWidth > innerWidth,
        fits: document.getElementById('kc-login').getBoundingClientRect().right <= innerWidth,
      })`);
      assert.deepEqual(layout, { overflow: false, fits: true }, 'Form fits at ' + width + 'x' + height);
      fs.writeFileSync(path.join(output, 'kitchen-login-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    console.log('PASS: Electron password visibility, keyboard navigation, touch targets and responsive screenshots.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win?.destroy();
    app.exit(process.exitCode || 0);
  }
});
