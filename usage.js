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

function getSnapshot() {
  const dailyLast30 = getThirtyDayHeatmap();
  const weeklyByModel = getWeeklyModelBreakdown();
  const todayKey = new Date().toISOString().slice(0, 10);
  return {
    generatedAt: new Date().toISOString(),
    currentSession: getCurrentSessionUsage(),
    weeklyByModel,
    dailyLast30,
    todayTokens: dailyLast30[todayKey] || 0,
    weeklyTokens: sumTokens(weeklyByModel),
    monthlyTokens: sumTokens(dailyLast30),
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
};

if (require.main === module) {
  console.log(JSON.stringify(getSnapshot(), null, 2));
}
