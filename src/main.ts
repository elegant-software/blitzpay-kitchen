import { app, BrowserWindow, ipcMain, Menu, net, powerSaveBlocker, protocol, safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.join(import.meta.dirname, '..');
const kiosk = process.env.KIOSK !== '0';

// Bundled config.json < <userData>/config.json < environment variables.
function loadConfig() {
  const read = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
  const c = { ...read(path.join(root, 'config.json')), ...read(path.join(app.getPath('userData'), 'config.json')) };
  const env: Record<string, string> = {
    apiBaseUrl: 'KITCHEN_API_URL',
    branchId: 'KITCHEN_BRANCH_ID',
    keycloakUrl: 'KEYCLOAK_URL',
    keycloakRealm: 'KEYCLOAK_REALM',
    keycloakClientId: 'KEYCLOAK_CLIENT_ID',
    overdueMinutes: 'OVERDUE_MINUTES',
  };
  for (const [key, name] of Object.entries(env)) if (process.env[name]) c[key] = process.env[name];
  c.overdueMinutes = Number(c.overdueMinutes) || 15;
  c.mockAuth = process.env.MOCK_AUTH === '1' || c.mockAuth === true;
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

const tokenFile = () => path.join(app.getPath('userData'), 'token.bin');

ipcMain.handle('config', () => loadConfig());
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
    Menu.setApplicationMenu(null);
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
    win.loadURL('app://kitchen/renderer/index.html');
  });
  app.on('window-all-closed', () => app.quit());
}
