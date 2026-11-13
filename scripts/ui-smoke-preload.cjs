const { contextBridge, ipcRenderer } = require('electron');
const value = name => process.argv.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
contextBridge.exposeInMainWorld('kitchen', {
  config: async () => ({ apiBaseUrl: value('--api'), branchId: 'demo', stationId: value('--station'), mockAuth: true, overdueMinutes: 15 }),
  versions: async () => ({ app: 'dev', api: 'v0.0.0-smoke' }),
  loadToken: async () => null,
  saveToken: async () => {},
  fatal: message => ipcRenderer.send('smoke:fatal', message),
});
