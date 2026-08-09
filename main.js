'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const usage = require('./usage');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const HISTORY_CSV_PATH = path.join(os.homedir(), '.capy-usage-monitor', 'history.csv');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { softSessionLimitTokens: 3000000, pollIntervalMs: 15000, notifyThresholds: [0.75, 0.9, 1.0], startInTray: false, pricingPerMillionTokens: {} };
  }
}

let config = loadConfig();
let mainWindow = null;
let tray = null;
let pollTimer = null;
const notifiedThresholdsThisWindow = new Set();

function estimateCostUsd(weeklyByModel) {
  let total = 0;
  for (const [model, tokens] of Object.entries(weeklyByModel)) {
    const price = config.pricingPerMillionTokens[model];
    if (!price) continue;
    // Aproximacao: sem separar input/output no agregado, usa media dos dois precos.
    const avgPerMillion = (price.input + price.output) / 2;
    total += (tokens / 1_000_000) * avgPerMillion;
  }
  return total;
}

function buildSnapshot() {
  const snap = usage.getSnapshot();
  snap.softSessionLimitTokens = config.softSessionLimitTokens;
  snap.sessionRatio = snap.currentSession.totalTokens / config.softSessionLimitTokens;
  snap.estimatedWeeklyCostUsd = estimateCostUsd(snap.weeklyByModel);
  return snap;
}

function maybeNotify(snap) {
  const ratio = snap.sessionRatio;
  for (const threshold of config.notifyThresholds) {
    const key = `${threshold}`;
    if (ratio >= threshold && !notifiedThresholdsThisWindow.has(key)) {
      notifiedThresholdsThisWindow.add(key);
      if (Notification.isSupported()) {
        new Notification({
          title: 'Capy Usage Monitor',
          body: `Sessao atual em ${Math.round(ratio * 100)}% do limite configurado (${snap.currentSession.totalTokens.toLocaleString()} tokens).`,
        }).show();
      }
    }
  }
  if (ratio < Math.min(...config.notifyThresholds)) {
    notifiedThresholdsThisWindow.clear();
  }
}

function pushSnapshot() {
  const snap = buildSnapshot();
  maybeNotify(snap);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('usage:update', snap);
  }
  return snap;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 300,
    height: 420,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: config.startInTray,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (config.startInTray) mainWindow.hide();
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'icon.png'));
  tray.setToolTip('Capy Usage Monitor');
  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar/ocultar widget', click: () => {
      if (!mainWindow) return;
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    } },
    { label: 'Exportar historico (CSV)', click: exportHistoryCsv },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

function exportHistoryCsv() {
  const daily = usage.getThirtyDayHeatmap();
  const rows = ['date,tokens'];
  for (const [day, tokens] of Object.entries(daily).sort()) {
    rows.push(`${day},${tokens}`);
  }
  fs.mkdirSync(path.dirname(HISTORY_CSV_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_CSV_PATH, rows.join('\n'), 'utf8');
  dialog.showMessageBox({
    type: 'info',
    title: 'Exportado',
    message: `Historico exportado para:\n${HISTORY_CSV_PATH}`,
  });
}

ipcMain.handle('usage:request', () => buildSnapshot());
ipcMain.handle('usage:exportCsv', () => {
  exportHistoryCsv();
  return HISTORY_CSV_PATH;
});
ipcMain.handle('window:hide', () => {
  if (mainWindow) mainWindow.hide();
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  pushSnapshot();
  pollTimer = setInterval(pushSnapshot, config.pollIntervalMs);
});

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (process.platform !== 'darwin') app.quit();
});
