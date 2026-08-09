'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function listTranscriptFiles() {
  const files = [];
  if (!fs.existsSync(PROJECTS_DIR)) return files;
  for (const projectDir of fs.readdirSync(PROJECTS_DIR)) {
    const full = path.join(PROJECTS_DIR, projectDir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const entry of fs.readdirSync(full)) {
      if (entry.endsWith('.jsonl')) files.push(path.join(full, entry));
    }
  }
  return files;
}

function tokensForEntry(usage) {
  if (!usage) return 0;
  return (
    (usage.input_tokens || 0) +
    (usage.output_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
  );
}

function readEntries(sinceMs) {
  const cutoff = sinceMs ? Date.now() - sinceMs : 0;
  const entries = [];
  for (const file of listTranscriptFiles()) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;
      const ts = Date.parse(obj.timestamp);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      entries.push({
        timestamp: ts,
        model: obj.message.model || 'unknown',
        tokens: tokensForEntry(obj.message.usage),
        content: obj.message.content,
      });
    }
  }
  return entries;
}

function getCurrentSessionUsage() {
  const entries = readEntries(FIVE_HOURS_MS);
  const total = entries.reduce((sum, e) => sum + e.tokens, 0);
  return { totalTokens: total, entryCount: entries.length, windowHours: 5 };
}

function getWeeklyModelBreakdown() {
  const entries = readEntries(SEVEN_DAYS_MS);
  const byModel = {};
  for (const e of entries) {
    byModel[e.model] = (byModel[e.model] || 0) + e.tokens;
  }
  return byModel;
}

function getThirtyDayHeatmap() {
  const entries = readEntries(THIRTY_DAYS_MS);
  const byDay = {};
  for (const e of entries) {
    const day = new Date(e.timestamp).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + e.tokens;
  }
  return byDay;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function getLastActivityMs() {
  const entries = readEntries(ONE_DAY_MS);
  if (entries.length === 0) return null;
  return Math.max(...entries.map((e) => e.timestamp));
}

function sumTokens(map) {
  return Object.values(map).reduce((sum, v) => sum + v, 0);
}

// "Hoje" = janela real de 24h corridas (nao dia de calendario em UTC).
function getLast24hTokens() {
  const entries = readEntries(ONE_DAY_MS);
  return entries.reduce((sum, e) => sum + e.tokens, 0);
}

// "Mes" = mes corrente (do dia 1 local ate agora), nao uma janela
// rolante de 30 dias — sao coisas diferentes e o rotulo precisa bater.
function getCurrentMonthTokens() {
  const now = new Date();
  const startOfMonthMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const entries = readEntries(); // historico inteiro, filtra por timestamp abaixo
  return entries
    .filter((e) => e.timestamp >= startOfMonthMs)
    .reduce((sum, e) => sum + e.tokens, 0);
}

// Mediana real de tokens/dia nos ultimos 7 dias corridos (hoje + 6
// anteriores, dias sem uso contam como 0). Retorna null se o historico
// local ainda nao cobre 7 dias — nao inventa numero antes disso.
function getSevenDayMedian() {
  const allEntries = readEntries(); // sem corte de tempo = historico inteiro
  if (allEntries.length === 0) return null;

  const earliestMs = Math.min(...allEntries.map((e) => e.timestamp));
  const daysOfHistory = (Date.now() - earliestMs) / ONE_DAY_MS;
  if (daysOfHistory < 6) return null;

  const dailyLast30 = getThirtyDayHeatmap();
  const values = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    values.push(dailyLast30[key] || 0);
  }
  values.sort((a, b) => a - b);
  return values[3]; // mediana de 7 valores = o do meio, apos ordenar
}

// Nome da ultima tool_use dentro da janela informada (default: 90s, mesma
// escala do estado "working"). Usado so pra escolher o icone de acao —
// nao afeta calculo de tokens.
function getLastToolUse(windowMs) {
  const ms = windowMs == null ? 90 * 1000 : windowMs;
  const entries = readEntries(ms);
  entries.sort((a, b) => b.timestamp - a.timestamp);
  for (const entry of entries) {
    if (!Array.isArray(entry.content)) continue;
    for (let i = entry.content.length - 1; i >= 0; i--) {
      const item = entry.content[i];
      if (item && item.type === 'tool_use' && item.name) return item.name;
    }
  }
  return null;
}

// Resumo de UMA sessao (um arquivo .jsonl inteiro), usado pro export por
// sessao. Diferente de readEntries(), le e agrega arquivo por arquivo pra
// nao perder a fronteira entre sessoes.
function parseSessionFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let startMs = null;
  let endMs = null;
  let totalTokens = 0;
  let entryCount = 0;
  const tokensByModel = {};

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;
    const ts = Date.parse(obj.timestamp);
    if (Number.isNaN(ts)) continue;
    if (startMs == null || ts < startMs) startMs = ts;
    if (endMs == null || ts > endMs) endMs = ts;
    const tokens = tokensForEntry(obj.message.usage);
    totalTokens += tokens;
    entryCount += 1;
    const model = obj.message.model || 'unknown';
    tokensByModel[model] = (tokensByModel[model] || 0) + tokens;
  }

  if (entryCount === 0) return null;

  let topModel = null;
  let topModelTokens = -1;
  for (const [model, tokens] of Object.entries(tokensByModel)) {
    if (tokens > topModelTokens) {
      topModel = model;
      topModelTokens = tokens;
    }
  }

  return {
    sessionId: path.basename(file, '.jsonl'),
    project: path.basename(path.dirname(file)),
    startMs,
    endMs,
    totalTokens,
    entryCount,
    topModel,
  };
}

// Uma linha por sessao (arquivo .jsonl), mais recente primeiro.
function getSessionHistory() {
  const sessions = [];
  for (const file of listTranscriptFiles()) {
    const summary = parseSessionFile(file);
    if (summary) sessions.push(summary);
  }
  sessions.sort((a, b) => b.startMs - a.startMs);
  return sessions;
}

function getSnapshot() {
  const dailyLast30 = getThirtyDayHeatmap();
  const weeklyByModel = getWeeklyModelBreakdown();
  return {
    generatedAt: new Date().toISOString(),
    currentSession: getCurrentSessionUsage(),
    weeklyByModel,
    dailyLast30,
    todayTokens: getLast24hTokens(),
    weeklyTokens: sumTokens(weeklyByModel),
    monthlyTokens: getCurrentMonthTokens(),
    lastActivityMs: getLastActivityMs(),
  };
}

module.exports = {
  getSnapshot,
  getCurrentSessionUsage,
  getWeeklyModelBreakdown,
  getThirtyDayHeatmap,
  getLastActivityMs,
  getLastToolUse,
  getSessionHistory,
  getSevenDayMedian,
};

if (require.main === module) {
  console.log(JSON.stringify(getSnapshot(), null, 2));
}
