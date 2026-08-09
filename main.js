'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ExcelJS = require('exceljs');

const usage = require('./usage');
const activity = require('./activity');
const auth = require('./auth');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(os.homedir(), '.capy-usage-monitor');
const HISTORY_XLSX_PATH = path.join(DATA_DIR, 'historico-sessoes.xlsx');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const FULL_SIZE = { width: 320, height: 620 };
const COMPACT_SIZE = { width: 126, height: 148 };
const COMPACT_MARGIN = 16;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {
      softSessionLimitTokens: 3000000,
      dailyLimitTokens: 100000000,
      weeklyLimitTokens: 40000000,
      monthlyLimitTokens: 150000000,
      activityThresholdsMs: { working: 90000, coffeeAfter: 300000, sleepAfter: 600000 },
      pollIntervalMs: 15000,
      notifyThresholds: [0.75, 0.9, 1.0],
      startInTray: false,
      pricingPerMillionTokens: {},
    };
  }
}

// Configuracoes editaveis pelo usuario via UI (engrenagem), separadas do
// config.json (que e pra ajuste manual/avancado). Vive em ~/.capy-usage-monitor
// junto com auth.json e o export, fora do repo.
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return { dailyAlertEnabled: false, dailyAlertPercent: 100 };
  }
}

// "Limite diario" pro percentual do aviso é sempre config.dailyLimitTokens
// (unico lugar de configuração — de proposito simples, so a % é editavel
// pela UI). Se o uso do dia bater muito acima disso (ex.: uma sessao de
// trabalho excepcionalmente longa), QUALQUER percentual vai disparar —
// isso é matematicamente correto, nao um bug. Se isso acontecer sempre no
// seu uso normal, suba `dailyLimitTokens` em config.json.
function effectiveDailyLimit() {
  return config.dailyLimitTokens;
}

function saveSettings(next) {
  settings = {
    dailyAlertEnabled: !!next.dailyAlertEnabled,
    dailyAlertPercent: Math.max(0, Math.min(100, Number(next.dailyAlertPercent))) || 0,
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch {
    // best-effort: se nao conseguir persistir, vale so pra sessao atual.
  }
  return settings;
}

let config = loadConfig();
let settings = loadSettings();
let mainWindow = null;
let tray = null;
let pollTimer = null;
let isCompact = false;
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
  const dailyLimit = effectiveDailyLimit();
  snap.limits = {
    session: config.softSessionLimitTokens,
    daily: dailyLimit,
    weekly: config.weeklyLimitTokens,
    monthly: config.monthlyLimitTokens,
  };
  snap.ratios = {
    session: snap.currentSession.totalTokens / config.softSessionLimitTokens,
    daily: snap.todayTokens / dailyLimit,
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
      coffeeAfterMs: config.activityThresholdsMs.coffeeAfter,
      sleepAfterMs: config.activityThresholdsMs.sleepAfter,
    });
  }

  snap.toolCategory = snap.activityState === 'working'
    ? activity.categorizeTool(usage.getLastToolUse(config.activityThresholdsMs.working))
    : null;

  snap.settings = settings;
  // O usuario compara o percentual do alerta contra o mesmo numero que ve
  // em "Sessao (5h)" (snap.ratios.session) — a unica porcentagem 0-100%
  // real e sempre visivel na tela. "Hoje"/ratios.daily e uma estimativa
  // local que pode passar de 1000% numa sessao de trabalho longa, entao
  // nao serve de base pro alerta (ja tentamos, gerou confusao repetida).
  snap.dailyAlert = !!(
    settings.dailyAlertEnabled && snap.ratios.session >= settings.dailyAlertPercent / 100
  );

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
    width: FULL_SIZE.width,
    height: FULL_SIZE.height,
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
let savedFullBounds = null;

ipcMain.handle('window:setCompact', (event, compact) => {
  isCompact = !!compact;
  if (!mainWindow) return isCompact;

  if (isCompact) {
    savedFullBounds = mainWindow.getBounds();
    const { workArea } = screen.getDisplayMatching(savedFullBounds);
    mainWindow.setBounds({
      x: workArea.x + workArea.width - COMPACT_SIZE.width - COMPACT_MARGIN,
      y: workArea.y + workArea.height - COMPACT_SIZE.height - COMPACT_MARGIN,
      width: COMPACT_SIZE.width,
      height: COMPACT_SIZE.height,
    });
  } else if (savedFullBounds) {
    mainWindow.setBounds(savedFullBounds);
  } else {
    mainWindow.setSize(FULL_SIZE.width, FULL_SIZE.height);
  }
  return isCompact;
});

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:save', (event, next) => {
  const saved = saveSettings(next);
  pushSnapshot();
  return saved;
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
