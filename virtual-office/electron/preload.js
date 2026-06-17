const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  onMenuCommand: (callback) => ipcRenderer.on('menu-command', callback),
});
