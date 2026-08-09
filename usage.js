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

function getSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    currentSession: getCurrentSessionUsage(),
    weeklyByModel: getWeeklyModelBreakdown(),
    dailyLast30: getThirtyDayHeatmap(),
  };
}

module.exports = {
  getSnapshot,
  getCurrentSessionUsage,
  getWeeklyModelBreakdown,
  getThirtyDayHeatmap,
};

if (require.main === module) {
  console.log(JSON.stringify(getSnapshot(), null, 2));
}
