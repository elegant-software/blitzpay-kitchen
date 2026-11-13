import { profileDirectory } from './profile.js';
import { app, BrowserWindow, ipcMain, Menu, net, powerSaveBlocker, protocol, safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { errorPage } from './renderer/error-page.js';
import { appVersion, backendVersion } from './version.js';

const root = path.join(import.meta.dirname, '..');
// Optional .env next to package.json (KEY=value lines). Real environment variables still win.
try { process.loadEnvFile(path.join(root, '.env')); } catch {}
const sharedUserData = app.getPath('userData');
const profile = process.env.KITCHEN_PROFILE ?? '';
if (profile) {
  const directory = profileDirectory(sharedUserData, profile);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
}
const kiosk = process.env.KIOSK !== '0';

// Bundled config.json < <userData>/config.json < environment variables.
function loadConfig() {
  const read = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
  const c = { ...read(path.join(root, 'config.json')), ...read(path.join(sharedUserData, 'config.json')), ...read(path.join(app.getPath('userData'), 'config.json')) };
  const env: Record<string, string> = {
    apiBaseUrl: 'KITCHEN_API_URL',
    branchId: 'KITCHEN_BRANCH_ID',
    stationId: 'KITCHEN_STATION_ID',
    keycloakUrl: 'KEYCLOAK_URL',
    keycloakRealm: 'KEYCLOAK_REALM',
    keycloakClientId: 'KEYCLOAK_CLIENT_ID',
    overdueMinutes: 'OVERDUE_MINUTES',
  };
  for (const [key, name] of Object.entries(env)) if (process.env[name]) c[key] = process.env[name];
  c.overdueMinutes = Number(c.overdueMinutes) || 15;
  c.mockAuth = process.env.MOCK_AUTH === '1' || c.mockAuth === true;
  log(`Kitchen Screen: API ${c.apiBaseUrl}, Keycloak ${c.keycloakUrl}, branch ${c.branchId}, auth ${c.mockAuth ? 'mock' : 'keycloak'}, profile ${profile || 'default'}`);
  return c;
}

// Linux has no setLoginItemSettings; use an XDG autostart entry instead.
function enableAutostart() {
  if (!app.isPackaged) return;
  if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: true });
  const dir = path.join(os.homedir(), '.config', 'autostart');
  fs.mkdirSync(dir, { recursive: true });
  const exec = process.env.APPIMAGE ?? process.execPath;
  fs.writeFileSync(path.join(dir, 'blitzpay-kitchen.desktop'),
    `[Desktop Entry]\nType=Application\nName=BlitzPay Kitchen\nExec="${exec}"\nX-GNOME-Autostart-enabled=true\n`);
}

// Persistent log for kiosks in the field: <userData>/kitchen.log (main process + renderer console warnings/errors).
// ponytail: grows unbounded, rotate if a device ever runs for months without reinstall
function log(line: string) {
  console.log(line);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'kitchen.log'), `${new Date().toISOString()} ${line}\n`); } catch {}
}

const tokenFile = () => path.join(app.getPath('userData'), 'token.bin');

ipcMain.handle('config', () => loadConfig());
// Fetched here, not in the renderer, so the backend's CORS rules for /actuator don't matter.
ipcMain.handle('versions', async (_e, apiBaseUrl: string) => ({
  app: appVersion(app.isPackaged, app.getVersion()),
  api: await backendVersion(String(apiBaseUrl), (url, init) => net.fetch(url, init)),
}));
ipcMain.handle('token:load', () => {
  try {
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(tokenFile())));
  } catch {
    return null;
  }
});
ipcMain.handle('token:save', (_e, tokens: unknown) => {
  if (!tokens) return fs.rmSync(tokenFile(), { force: true });
  if (!safeStorage.isEncryptionAvailable()) return console.warn('safeStorage unavailable; token not persisted');
  fs.writeFileSync(tokenFile(), safeStorage.encryptString(JSON.stringify(tokens)));
});

// The renderer is served from app://kitchen/ so Keycloak has a stable redirect URI and crypto.subtle (PKCE) works.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win: BrowserWindow | null = null;
const RETRY_S = 10;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win?.focus());
  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const file = path.join(root, decodeURIComponent(new URL(req.url).pathname));
      if (!file.startsWith(root + path.sep)) return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    loadConfig(); // logs which servers this run uses
    // Edit menu only: macOS needs it for Cmd+C/V (e.g. pasting the Kitchen Login). No Quit item, so the kiosk stays up.
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]));
    powerSaveBlocker.start('prevent-display-sleep');
    enableAutostart();
    win = new BrowserWindow({
      kiosk,
      fullscreen: kiosk,
      width: 1600,
      height: 900,
      autoHideMenuBar: true,
      backgroundColor: '#111',
      webPreferences: {
        preload: path.join(import.meta.dirname, 'preload.cjs'),
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const start = () => win!.loadURL('app://kitchen/renderer/index.html');
    // Show why instead of a black window, then retry. -3 = navigation aborted by a redirect, not a failure.
    const fail = (title: string, detail: string) => {
      log(`ERROR ${title}: ${detail}`);
      win!.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorPage(title, detail, RETRY_S))}`);
      setTimeout(start, RETRY_S * 1000);
    };
    win.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') log(`renderer ${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) fail(`Cannot reach ${new URL(url).origin}`, `${desc} (${code})`);
    });
    win.webContents.on('render-process-gone', (_e, d) => fail('The screen stopped unexpectedly', d.reason));
    ipcMain.on('fatal', (_e, message: string) => fail(profile ? `Startup failed (${profile})` : 'Startup failed', message));
    start();
  });
  app.on('window-all-closed', () => app.quit());
}
