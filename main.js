'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ExcelJS = require('exceljs');

const usage = require('./usage');
const activity = require('./activity');
const auth = require('./auth');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const HISTORY_XLSX_PATH = path.join(os.homedir(), '.capy-usage-monitor', 'historico-sessoes.xlsx');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {
      softSessionLimitTokens: 3000000,
      dailyLimitTokens: 8000000,
      weeklyLimitTokens: 40000000,
      monthlyLimitTokens: 150000000,
      activityThresholdsMs: { working: 90000, light: 900000 },
      pollIntervalMs: 15000,
      notifyThresholds: [0.75, 0.9, 1.0],
      startInTray: false,
      pricingPerMillionTokens: {},
    };
  }
}

let config = loadConfig();
let mainWindow = null;
let tray = null;
let pollTimer = null;
const notifiedThresholdsThisWindow = new Set();

// ---- uso real via OAuth (percentual autoritativo, igual ao painel oficial) ----
let realUsage = null; // { session: {pct, resetMs}, week: {...}, sonnet, opus }
let usageTimer = null;
let usageBackoff = 5 * 60 * 1000;

function scheduleUsagePoll() {
  clearTimeout(usageTimer);
  if (auth.isConnected()) usageTimer = setTimeout(pollUsage, usageBackoff);
}

async function pollUsage() {
  try {
    realUsage = await auth.fetchUsage();
    usageBackoff = 5 * 60 * 1000;
    pushSnapshot();
  } catch (e) {
    if (e && e.status === 429) {
      usageBackoff = Math.min(usageBackoff * 2, 30 * 60 * 1000);
    } else if (e && e.status === 401) {
      auth.clear();
      realUsage = null;
      pushSnapshot();
    }
  }
  scheduleUsagePoll();
}

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
  snap.limits = {
    session: config.softSessionLimitTokens,
    daily: config.dailyLimitTokens,
    weekly: config.weeklyLimitTokens,
    monthly: config.monthlyLimitTokens,
  };
  snap.ratios = {
    session: snap.currentSession.totalTokens / config.softSessionLimitTokens,
    daily: snap.todayTokens / config.dailyLimitTokens,
    weekly: snap.weeklyTokens / config.weeklyLimitTokens,
    monthly: snap.monthlyTokens / config.monthlyLimitTokens,
  };

  // Sessao (5h) e Semana tem equivalente oficial via OAuth — quando
  // conectado, essas duas viram o percentual REAL da conta (igual ao
  // painel Settings -> Usage). Hoje/Mes nao tem equivalente na API oficial
  // e continuam sendo estimativa local contra o teto configuravel.
  const connected = auth.isConnected();
  snap.real = { connected, session: null, week: null };
  if (connected && realUsage) {
    snap.real.session = realUsage.session;
    snap.real.week = realUsage.week;
    snap.ratios.session = realUsage.session.pct / 100;
    snap.ratios.weekly = realUsage.week.pct / 100;
  }

  // Compatibilidade com o campo antigo usado pelas notificacoes.
  snap.sessionRatio = snap.ratios.session;
  snap.estimatedWeeklyCostUsd = estimateCostUsd(snap.weeklyByModel);

  if (snap.ratios.session >= 1) {
    snap.activityState = 'alert';
  } else if (snap.ratios.session >= 0.9) {
    snap.activityState = 'hot';
  } else {
    snap.activityState = activity.computeState({
      lastActivityMs: snap.lastActivityMs,
      workingMs: config.activityThresholdsMs.working,
      lightMs: config.activityThresholdsMs.light,
    });
  }

  snap.toolCategory = snap.activityState === 'working'
    ? activity.categorizeTool(usage.getLastToolUse(config.activityThresholdsMs.working))
    : null;

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
          title: 'Spark Monitor',
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
    title: 'Spark Monitor',
    width: 320,
    height: 700,
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
  tray.setToolTip('Spark Monitor');
  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar/ocultar widget', click: () => {
      if (!mainWindow) return;
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    } },
    { label: 'Exportar historico (Excel)', click: () => {
      exportHistorySessions().catch((err) => dialog.showErrorBox('Erro ao exportar', String(err)));
    } },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

async function exportHistorySessions() {
  const sessions = usage.getSessionHistory();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Spark Monitor';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Sessoes', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = [
    { header: 'Sessao', key: 'sessionId', width: 12 },
    { header: 'Projeto', key: 'project', width: 22 },
    { header: 'Inicio', key: 'start', width: 18 },
    { header: 'Fim', key: 'end', width: 18 },
    { header: 'Duracao (min)', key: 'durationMin', width: 14 },
    { header: 'Tokens', key: 'tokens', width: 14 },
    { header: 'Modelo principal', key: 'topModel', width: 22 },
    { header: 'Mensagens', key: 'entryCount', width: 12 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF1B1712' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD97757' } };
  headerRow.alignment = { vertical: 'middle' };

  for (const s of sessions) {
    const row = sheet.addRow({
      sessionId: s.sessionId.slice(0, 8),
      project: s.project,
      start: new Date(s.startMs),
      end: new Date(s.endMs),
      durationMin: Math.max(1, Math.round((s.endMs - s.startMs) / 60000)),
      tokens: s.totalTokens,
      topModel: s.topModel,
      entryCount: s.entryCount,
    });
    row.getCell('start').numFmt = 'dd/mm/yyyy hh:mm';
    row.getCell('end').numFmt = 'dd/mm/yyyy hh:mm';
    row.getCell('tokens').numFmt = '#,##0';
  }

  fs.mkdirSync(path.dirname(HISTORY_XLSX_PATH), { recursive: true });
  await workbook.xlsx.writeFile(HISTORY_XLSX_PATH);

  dialog.showMessageBox({
    type: 'info',
    title: 'Exportado',
    message: `${sessions.length} sessoes exportadas para:\n${HISTORY_XLSX_PATH}`,
  });
}

ipcMain.handle('usage:request', () => buildSnapshot());
ipcMain.handle('usage:exportXlsx', async () => {
  await exportHistorySessions();
  return HISTORY_XLSX_PATH;
});
ipcMain.handle('window:hide', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('auth-start', () => shell.openExternal(auth.begin()));

ipcMain.on('auth-code', async (event, code) => {
  const reply = (ok, error) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth-result', { ok, error });
    }
  };
  try {
    await auth.complete(code);
    usageBackoff = 5 * 60 * 1000;
    try {
      realUsage = await auth.fetchUsage(); // tambem valida o token
      reply(true);
    } catch (e) {
      if (e && e.status === 429) {
        reply(true); // token ok, endpoint so esta com throttling
      } else {
        throw e;
      }
    }
    scheduleUsagePoll();
    pushSnapshot();
  } catch (err) {
    auth.clear();
    reply(false, String((err && err.message) || err));
  }
});

ipcMain.on('auth-logout', () => {
  auth.clear();
  realUsage = null;
  clearTimeout(usageTimer);
  pushSnapshot();
});

ipcMain.handle('auth:profile', async () => {
  if (!auth.isConnected()) return null;
  try {
    return await auth.fetchProfile();
  } catch {
    return null;
  }
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  pushSnapshot();
  pollTimer = setInterval(pushSnapshot, config.pollIntervalMs);
  if (auth.isConnected()) pollUsage();
});

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (process.platform !== 'darwin') app.quit();
});
