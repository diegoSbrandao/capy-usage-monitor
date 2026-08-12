'use strict';

const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('capyApi', {
  requestSnapshot: () => ipcRenderer.invoke('usage:request'),
  exportXlsx: () => ipcRenderer.invoke('usage:exportXlsx'),
  analyzeSpend: () => ipcRenderer.invoke('usage:analyzeSpend'),
  copyClearHint: () => clipboard.writeText('/clear'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  onUpdate: (callback) => {
    ipcRenderer.on('usage:update', (_event, snapshot) => callback(snapshot));
  },
  onAttentionUpdate: (callback) => {
    ipcRenderer.on('attention:update', (_event, active) => callback(active));
  },

  authStart: () => ipcRenderer.send('auth-start'),
  authSubmitCode: (code) => ipcRenderer.send('auth-code', code),
  authLogout: () => ipcRenderer.send('auth-logout'),
  getProfile: () => ipcRenderer.invoke('auth:profile'),
  onAuthResult: (callback) => {
    ipcRenderer.on('auth-result', (_event, result) => callback(result));
  },

  setCompact: (compact) => ipcRenderer.invoke('window:setCompact', compact),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (next) => ipcRenderer.invoke('settings:save', next),

  getAutoStart: () => ipcRenderer.invoke('autostart:get'),
  setAutoStart: (enabled) => ipcRenderer.invoke('autostart:set', enabled),
});
