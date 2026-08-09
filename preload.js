'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capyApi', {
  requestSnapshot: () => ipcRenderer.invoke('usage:request'),
  exportCsv: () => ipcRenderer.invoke('usage:exportCsv'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  onUpdate: (callback) => {
    ipcRenderer.on('usage:update', (_event, snapshot) => callback(snapshot));
  },
});
