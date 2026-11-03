import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kitchen', {
  config: () => ipcRenderer.invoke('config'),
  loadToken: () => ipcRenderer.invoke('token:load'),
  saveToken: (tokens: unknown) => ipcRenderer.invoke('token:save', tokens),
});
