'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, dialog, shell, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ExcelJS = require('exceljs');

const usage = require('./usage');
const activity = require('./activity');
const auth = require('./auth');

// Config default vem empacotado junto com o app (dentro do asar depois de
// empacotado — so leitura, nunca escrita). A copia de verdade, que o
// usuario pode editar, mora em DATA_DIR — se nao existir ainda (primeira
// execucao), copiamos o default pra la. Isso e obrigatorio pra funcionar
// depois de empacotado: a pasta onde o app fica instalado nao e gravavel.
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(os.homedir(), '.capy-usage-monitor');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const HISTORY_XLSX_PATH = path.join(DATA_DIR, 'historico-sessoes.xlsx');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const ATTENTION_PATH = path.join(DATA_DIR, 'attention.json');
const ATTENTION_MAX_AGE_MS = 5 * 60 * 1000;
const SPEND_ALERT_COLD_GAP_MS = 10 * 60 * 1000;
// Cache-waste: so avalia com volume minimo de tokens de cache na janela
// (sessoes muito curtas naturalmente comecam com hitRatio baixo, ainda
// sem cache pra ler) e sinaliza quando menos da metade dos tokens de
// cache foram leituras — ver getCacheEfficiency() em usage.js.
const CACHE_WASTE_MIN_TOKENS = 20000;
const CACHE_WASTE_HIT_RATIO = 0.5;

const FULL_SIZE = { width: 320, height: 648 };
const COMPACT_SIZE = { width: 210, height: 68 };
const COMPACT_MARGIN = 16;

const HARDCODED_FALLBACK_CONFIG = {
  softSessionLimitTokens: 3000000,
  dailyLimitTokens: 100000000,
  weeklyLimitTokens: 40000000,
  monthlyLimitTokens: 150000000,
  activityThresholdsMs: { working: 90000, coffeeAfter: 300000, sleepAfter: 600000 },
  pollIntervalMs: 500,
  notifyThresholds: [0.75, 0.9, 1.0],
  startInTray: false,
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH);
    } catch {
      // best-effort: se nao conseguir copiar, cai no fallback abaixo.
    }
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    try {
      return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
    } catch {
      return HARDCODED_FALLBACK_CONFIG;
    }
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

// Sinal gravado por um hook "Notification" do Claude Code (ver
// scripts/signal-attention.js) — o unico jeito confiavel de saber que ele
// esta esperando aprovacao/te avisando algo agora, porque os .jsonl locais
// so registram o que ja aconteceu, nao um estado "pendente". Fica ativo
// ate no maximo ATTENTION_MAX_AGE_MS, ou ate uma nova mensagem assistant
// aparecer depois do sinal (sinal de que voce ja respondeu e o Claude
// Code seguiu em frente).
function isAttentionActive(lastActivityMs) {
  let signal;
  try {
    signal = JSON.parse(fs.readFileSync(ATTENTION_PATH, 'utf8'));
  } catch {
    return false;
  }
  if (!signal || typeof signal.ts !== 'number') return false;
  const age = Date.now() - signal.ts;
  if (age > ATTENTION_MAX_AGE_MS) return false;
  if (lastActivityMs != null && lastActivityMs > signal.ts) return false;
  return true;
}

function persistSettingsToDisk() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch {
    // best-effort: se nao conseguir persistir, vale so pra sessao atual.
  }
}

function saveSettings(next) {
  // Merge, nao substitui inteiro: senao um save vindo so do painel de
  // "meta diaria" (que nao manda autoStartEnabled) apagaria a intencao
  // de autostart guardada por setAutoStart().
  settings = {
    ...settings,
    dailyAlertEnabled: !!next.dailyAlertEnabled,
    dailyAlertPercent: Math.max(0, Math.min(100, Number(next.dailyAlertPercent))) || 0,
  };
  persistSettingsToDisk();
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

// Deteccao do reset real da janela de 5h: resetMs normalmente so
// diminui (contagem regressiva). Se o valor novo for MAIOR que o
// anterior, a janela virou entre um poll e outro - e o proprio reset
// acontecendo, independente do % de uso no momento (diferente da
// heuristica antiga no renderer, que so pegava reset vindo de perto do
// limite). Margem de 1min pra nao disparar por jitter de relogio.
let previousResetMsSession = null;
let justResetSession = false;
const RESET_JITTER_MARGIN_MS = 60 * 1000;

function scheduleUsagePoll() {
  clearTimeout(usageTimer);
  if (auth.isConnected()) usageTimer = setTimeout(pollUsage, usageBackoff);
}

async function pollUsage() {
  try {
    realUsage = await auth.fetchUsage();
    const nextReset = realUsage.session.resetMs;
    if (
      previousResetMsSession != null &&
      nextReset != null &&
      nextReset > previousResetMsSession + RESET_JITTER_MARGIN_MS
    ) {
      justResetSession = true;
    }
    previousResetMsSession = nextReset;
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
  snap.real = { connected, session: null, week: null, sonnet: null, opus: null, extraUsage: null };
  if (connected && realUsage) {
    snap.real.session = realUsage.session;
    snap.real.week = realUsage.week;
    snap.real.sonnet = realUsage.sonnet;
    snap.real.opus = realUsage.opus;
    snap.real.extraUsage = realUsage.extraUsage;
    snap.ratios.session = realUsage.session.pct / 100;
    snap.ratios.weekly = realUsage.week.pct / 100;
  }

  // Consumido aqui (nao em pushSnapshot) pra so entregar `true` uma vez,
  // mesmo com buildSnapshot() sendo chamado tanto pelo poll periodico
  // quanto por ipcMain 'usage:request'.
  snap.justReset = justResetSession;
  justResetSession = false;

  // Compatibilidade com o campo antigo usado pelas notificacoes.
  snap.sessionRatio = snap.ratios.session;
  // Mediana real de tokens/dia nos ultimos 7 dias (null ate ter 7 dias de
  // historico local) — dado real, nao um preco inventado.
  snap.sevenDayMedianTokens = usage.getSevenDayMedian();
  // Proxy de "prompt desperdicado": cache pouco reaproveitado na sessao
  // atual (ver CACHE_WASTE_* acima e getCacheEfficiency() em usage.js).
  const cacheEfficiency = usage.getCacheEfficiency();
  snap.cacheEfficiency = cacheEfficiency;
  snap.cacheWaste = !!(
    cacheEfficiency &&
    cacheEfficiency.cacheCreationTokens + cacheEfficiency.cacheReadTokens >= CACHE_WASTE_MIN_TOKENS &&
    cacheEfficiency.hitRatio < CACHE_WASTE_HIT_RATIO
  );

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
  snap.attention = isAttentionActive(snap.lastActivityMs);

  // So mostra o card "sessao esta pesando" quando a sessao (5h) esta
  // mesmo perto/no teto - o mesmo percentual REAL que o usuario ja ve
  // no badge "Sessao (5h)". Tinha um segundo gatilho comparando a media
  // de tokens/mensagem contra o proprio historico, mas isso e' um
  // numero que o usuario nunca ve em lugar nenhum - disparava o alerta
  // sem bater com nada visivel na tela (mesma classe de confusao que o
  // dailyAlert ja evitou de proposito, ver comentario abaixo).
  snap.spendAlert = snap.ratios.session >= 0.9;

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

// Mesma logica de abreviacao de tokens do renderer (formatTokens em
// renderer.js), replicada aqui porque o processo main nao carrega o
// bundle do renderer.
function formatTokensShort(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatModelBreakdown(tokensByModel) {
  return Object.entries(tokensByModel || {})
    .sort((a, b) => b[1] - a[1])
    .map(([model, tokens]) => `${model}: ${formatTokensShort(tokens)}`)
    .join(', ');
}

// Avaliacao de "boa pratica" por sessao: media de tokens/mensagem,
// relativa a sessao mais verbosa do PROPRIO historico exportado (nao um
// numero absoluto inventado - mesma logica de "dado real, sem
// benchmark oficial" ja usada em getSevenDayMedian). Mesmas 3 cores do
// esquema de %-uso ja usado no widget (renderCompactPct em renderer.js:
// verde/amarelo/vermelho), so os cortes mudam (60%/90% do pior caso,
// nao 41%/80% de um teto).
const EVAL_TIER_COLOR = {
  ok: 'FFD9F5E3', // tinta clara do verde #3ee673
  warn: 'FFFFF3C4', // tinta clara do amarelo #ffd23f
  bad: 'FFFFD6D1', // tinta clara do vermelho #ff4d3d
};
const EVAL_TIER_LABEL = {
  ok: 'Boa pratica',
  warn: 'Pode melhorar',
  bad: 'Excessiva',
};

// Classificacao de eficiencia de cache por sessao pro export Excel — 3
// faixas (em vez das 2 de CACHE_WASTE_HIT_RATIO) pra dar contexto na
// planilha, nao so alertar/nao alertar. MESMO dado local que ja usamos pro
// badge do mascote (cacheHitRatio de usage.js::parseSessionFile) — nao le
// UMA linha sequer de conteudo de prompt, nao chama nenhuma API/LLM, custo
// de token ZERO (decisao deliberada: "prompt quality" de verdade exigiria
// ler o texto, o que quebraria a linha de privacidade do projeto e custaria
// tokens a cada export — a razao de cache e um proxy que fica so com dados
// que o Claude Code ja registra localmente).
function cacheHealthTier(session) {
  const cacheTotal = (session.cacheCreationTokens || 0) + (session.cacheReadTokens || 0);
  if (session.cacheHitRatio == null || cacheTotal < CACHE_WASTE_MIN_TOKENS) {
    return { label: 'Sem dado', argb: 'FFB8B0A6' };
  }
  if (session.cacheHitRatio >= 0.8) return { label: 'Verde', argb: 'FF3EE673' };
  if (session.cacheHitRatio >= CACHE_WASTE_HIT_RATIO) return { label: 'Amarelo', argb: 'FFFFD23F' };
  return { label: 'Vermelho', argb: 'FFFF4D3D' };
}

async function exportHistorySessions() {
  const sessions = usage.getSessionHistory();
  const maxAvgTokensPerMessage = Math.max(1, ...sessions.map((s) => s.avgTokensPerMessage));

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
    { header: 'Tokens entrada', key: 'inputTokens', width: 14 },
    { header: 'Tokens saida', key: 'outputTokens', width: 14 },
    { header: 'Tokens cache (criacao)', key: 'cacheCreationTokens', width: 18 },
    { header: 'Tokens cache (leitura)', key: 'cacheReadTokens', width: 18 },
    { header: 'Modelo principal', key: 'topModel', width: 22 },
    { header: 'Modelos (detalhe)', key: 'modelBreakdown', width: 30 },
    { header: 'Mensagens', key: 'entryCount', width: 12 },
    { header: 'Tokens/mensagem', key: 'avgTokensPerMessage', width: 16 },
    { header: 'Avaliacao', key: 'evaluation', width: 16 },
    { header: 'Cache reaproveitado', key: 'cachePct', width: 18 },
    { header: 'Eficiencia', key: 'efficiency', width: 8 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF1B1712' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD97757' } };
  headerRow.alignment = { vertical: 'middle' };
  headerRow.getCell('evaluation').note =
    'Relativa a sessao mais verbosa (mais tokens/mensagem) do proprio historico exportado, nao um numero oficial da Anthropic. <60% do pior caso = boa pratica, 60-90% = pode melhorar, >=90% = excessiva.';
  headerRow.getCell('efficiency').note =
    'Baseado na razao de tokens de cache lidos vs. criados na sessao (dado local, sem ler o conteudo dos prompts). '
    + 'Verde >=80% reaproveitado, Amarelo >=50%, Vermelho <50%. "Sem dado" = sessao pequena demais pra julgar.';

  for (const s of sessions) {
    const tier = usage.tierForAvgTokensPerMessage(s.avgTokensPerMessage, maxAvgTokensPerMessage);
    const cacheTier = cacheHealthTier(s);
    const row = sheet.addRow({
      sessionId: s.sessionId.slice(0, 8),
      project: s.project,
      start: new Date(s.startMs),
      end: new Date(s.endMs),
      durationMin: Math.max(1, Math.round((s.endMs - s.startMs) / 60000)),
      tokens: s.totalTokens,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheCreationTokens: s.cacheCreationTokens,
      cacheReadTokens: s.cacheReadTokens,
      topModel: s.topModel,
      modelBreakdown: formatModelBreakdown(s.tokensByModel),
      entryCount: s.entryCount,
      avgTokensPerMessage: Math.round(s.avgTokensPerMessage),
      evaluation: EVAL_TIER_LABEL[tier],
      cachePct: s.cacheHitRatio == null ? null : s.cacheHitRatio,
      efficiency: '',
    });
    row.getCell('start').numFmt = 'dd/mm/yyyy hh:mm';
    row.getCell('end').numFmt = 'dd/mm/yyyy hh:mm';
    row.getCell('tokens').numFmt = '#,##0';
    row.getCell('inputTokens').numFmt = '#,##0';
    row.getCell('outputTokens').numFmt = '#,##0';
    row.getCell('cacheCreationTokens').numFmt = '#,##0';
    row.getCell('cacheReadTokens').numFmt = '#,##0';
    row.getCell('avgTokensPerMessage').numFmt = '#,##0';
    row.getCell('cachePct').numFmt = '0%';
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EVAL_TIER_COLOR[tier] } };
    });
    // So a cor da celula (sem texto) — a legenda fica na nota do cabecalho.
    row.getCell('efficiency').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cacheTier.argb } };
  }

  // Aba nova: onde foi gasto tokens por ferramenta (Read, Bash, Grep,
  // etc.), historico inteiro (mesmo escopo das sessoes acima) - pedido
  // do usuario pra saber o que mais pesa alem de olhar sessao por sessao.
  const toolBreakdown = usage.getToolBreakdownAllTime();
  const toolTotal = Math.max(1, toolBreakdown.reduce((sum, t) => sum + t.approxTokens, 0));
  const toolSheet = workbook.addWorksheet('Ferramentas', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  toolSheet.columns = [
    { header: 'Ferramenta', key: 'name', width: 20 },
    { header: 'Chamadas', key: 'count', width: 12 },
    { header: 'Tokens (aprox.)', key: 'approxTokens', width: 16 },
    { header: '% do total', key: 'pct', width: 12 },
  ];
  const toolHeaderRow = toolSheet.getRow(1);
  toolHeaderRow.font = { bold: true, color: { argb: 'FF1B1712' } };
  toolHeaderRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD97757' } };
  toolHeaderRow.alignment = { vertical: 'middle' };
  toolHeaderRow.getCell('approxTokens').note =
    'Estimativa por tamanho do texto de retorno da ferramenta (chars/4) - nao vem com `usage` proprio da API, so a resposta inteira tem esse dado.';
  for (const t of toolBreakdown) {
    const row = toolSheet.addRow({
      name: t.name,
      count: t.count,
      approxTokens: t.approxTokens,
      pct: t.approxTokens / toolTotal,
    });
    row.getCell('count').numFmt = '#,##0';
    row.getCell('approxTokens').numFmt = '#,##0';
    row.getCell('pct').numFmt = '0.0%';
  }
  if (toolBreakdown.length > 0) {
    toolSheet.getRow(2).font = { bold: true };
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
ipcMain.handle('usage:analyzeSpend', () => {
  const analysis = usage.analyzeSessionCost();
  const coldSessions = usage.getSessionHistory().filter(
    (s) => Date.now() - s.endMs > SPEND_ALERT_COLD_GAP_MS
  );
  const maxHistoricalAvg = Math.max(0, ...coldSessions.map((s) => s.avgTokensPerMessage));
  analysis.avgTier = usage.tierForAvgTokensPerMessage(analysis.avgTokensPerMessage, maxHistoricalAvg);
  return analysis;
});
// Abre um terminal novo ja rodando `claude --continue` na pasta da
// sessao mais pesada da janela de 5h — retoma com contexto intacto em
// vez de perder tudo. --continue sozinho NAO economiza token nenhum
// (recarrega o historico inteiro) - quem compacta de verdade e' o
// comando /compact, por isso ele ja fica copiado pra colar assim que a
// sessao retomada carregar.
ipcMain.handle('usage:openContinueTerminal', () => {
  const analysis = usage.analyzeSessionCost();
  const cwd = analysis.topSession && analysis.topSession.cwd;
  if (!cwd || !fs.existsSync(cwd)) {
    return { ok: false, error: 'nao achei a pasta da sessao ativa' };
  }
  const mintty = 'C:\\Program Files\\Git\\usr\\bin\\mintty.exe';
  if (!fs.existsSync(mintty)) {
    return { ok: false, error: 'Git Bash nao encontrado (esperado em ' + mintty + ')' };
  }
  try {
    // -c 'cd ... && claude --continue; exec bash': roda o continue e,
    // quando ele sair (erro, ctrl+c, ou fim), cai num bash interativo
    // em vez de fechar a janela sozinha.
    const bashCwd = cwd.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
    const cmd = `cd "${bashCwd}" && claude --continue; exec bash`;
    const child = spawn(mintty, ['-e', 'bash', '-c', cmd], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    clipboard.writeText('/compact');
    return { ok: true, cwd };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

// Abrir com o Windows: a fonte de verdade pra UI e a INTENCAO do usuario
// (settings.autoStartEnabled), nao mais uma leitura ao vivo do registro
// do Windows. Motivo: o Windows pode desligar a entrada de startup por
// fora do app (reinstalar em outro caminho, "Startup impact" no Task
// Manager, etc) sem o app saber - com a fonte de verdade sendo so o SO,
// isso aparecia como "toggle volta desligado sozinho". Agora o app
// reaplica a intencao salva no SO toda vez que abre (ver app.whenReady
// abaixo), entao mesmo se o Windows tiver derrubado o registro, o
// proximo lancamento do app (manual ou por acaso ainda estar no
// startup) conserta sozinho.
// Em dev (`electron .`) o execPath e o binario do Electron, entao precisa
// apontar path/args pro projeto explicitamente; empacotado, o exe ja e o
// app certo, nao precisa de nada extra.
// No Windows, getLoginItemSettings() so reconhece uma entrada custom
// (path/args) se voce passar o MESMO path/args na leitura — sem isso ele
// checa contra o execPath padrao (sem args), nao acha a entrada que o dev
// criou com args, e sempre volta openAtLogin:false mesmo com o registro
// gravado certinho. Por isso path/args tem que ser identicos em leitura
// (osReportsAutoStart) e escrita (setAutoStart).
function loginItemOptions() {
  if (app.isPackaged) return {};
  return { path: process.execPath, args: [path.resolve(process.argv[1] || '.')] };
}
function osReportsAutoStart() {
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}
function getAutoStart() {
  return !!settings.autoStartEnabled;
}
function setAutoStart(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemOptions() });
  settings = { ...settings, autoStartEnabled: enabled };
  persistSettingsToDisk();
  return getAutoStart();
}

ipcMain.handle('autostart:get', () => getAutoStart());
ipcMain.handle('autostart:set', (event, enabled) => setAutoStart(!!enabled));

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
  // Reafirma "abrir com o Windows" a cada lancamento, segundo a ultima
  // intencao salva - se settings.json ainda nao tem esse campo (versao
  // anterior a esse fix), usa o que o SO ja reportava como ponto de
  // partida, pra nao desligar de surpresa algo que o usuario ja tinha
  // ligado antes.
  const desiredAutoStart = typeof settings.autoStartEnabled === 'boolean'
    ? settings.autoStartEnabled
    : osReportsAutoStart();
  setAutoStart(desiredAutoStart);
  pushSnapshot();
  pollTimer = setInterval(pushSnapshot, config.pollIntervalMs);
  if (auth.isConnected()) pollUsage();

  // Watcher dedicado pro attention.json, separado do poll pesado acima.
  // buildSnapshot() le todos os .jsonl de sessao do disco (caro, cresce com
  // o historico) — rodar isso a cada mudanca do sinal de attention seria
  // pesado demais. Aqui so checamos a existencia do arquivo (fs.existsSync,
  // praticamente gratis) e mandamos um IPC leve que so alterna o badge no
  // renderer, sem re-renderizar o resto do snapshot.
  let attentionDebounce;
  fs.watch(DATA_DIR, (eventType, filename) => {
    if (filename !== 'attention.json') return;
    clearTimeout(attentionDebounce);
    attentionDebounce = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('attention:update', fs.existsSync(ATTENTION_PATH));
      }
    }, 15);
  });
});

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (process.platform !== 'darwin') app.quit();
});
