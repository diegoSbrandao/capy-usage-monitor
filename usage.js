'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const activity = require('./activity');

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
  // O Claude Code grava cada bloco de conteudo (thinking/text/tool_use)
  // de UMA resposta da API como uma linha "assistant" separada no
  // .jsonl, repetindo o `usage` inteiro da resposta em cada linha. Sem
  // deduplicar por `message.id`, cada resposta com pensamento estendido
  // (quase sempre 2-3 blocos) e contada 2-3x - inflava o total em ~45%
  // numa sessao real. So conta tokens na 1a linha de cada id; linhas
  // seguintes so contribuem conteudo extra (pra achar tool_use).
  const seenById = new Map();
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
      const id = obj.message.id;
      if (id && seenById.has(id)) {
        const existing = seenById.get(id);
        if (Array.isArray(obj.message.content)) {
          existing.content = (existing.content || []).concat(obj.message.content);
        }
        continue;
      }
      const entry = {
        timestamp: ts,
        model: obj.message.model || 'unknown',
        tokens: tokensForEntry(obj.message.usage),
        cacheCreationTokens: obj.message.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: obj.message.usage.cache_read_input_tokens || 0,
        content: obj.message.content,
      };
      if (id) seenById.set(id, entry);
      entries.push(entry);
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

// Chave de dia no fuso LOCAL, nao UTC. toISOString() e' sempre UTC -
// uso feito a noite (fuso negativo, ex. Brasil UTC-3) cairia no balde
// de "amanha" em vez de "hoje", distorcendo o heatmap/mediana. Mesma
// funcao usada tanto pra gravar quanto pra consultar as chaves.
function localDateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getThirtyDayHeatmap() {
  const entries = readEntries(THIRTY_DAYS_MS);
  const byDay = {};
  for (const e of entries) {
    const day = localDateKey(e.timestamp);
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

// "Hoje" = dia de calendario LOCAL (desde meia-noite), nao janela movel
// de 24h - pedido explicito do usuario, pra bater com a barra de "hoje"
// do heatmap (mesmo criterio de dia dos dois lugares da tela).
function getTodayTokens() {
  const now = new Date();
  const startOfDayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const entries = readEntries(ONE_DAY_MS); // superset seguro: um dia local nunca passa de 24h
  return entries
    .filter((e) => e.timestamp >= startOfDayMs)
    .reduce((sum, e) => sum + e.tokens, 0);
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
    const key = localDateKey(d);
    values.push(dailyLast30[key] || 0);
  }
  values.sort((a, b) => a - b);
  return values[3]; // mediana de 7 valores = o do meio, apos ordenar
}

// Proxy de "cache desperdicado": razao entre tokens lidos do cache
// (cache_read, ~10% do preco normal) e o total de tokens ligados a cache
// (leitura + criacao) na janela da sessao atual (5h, mesma escala de
// getCurrentSessionUsage()). Uma razao baixa sugere reenvio de contexto
// grande sem se beneficiar do cache — algo que a Anthropic recomenda
// evitar. Retorna null se nao houver atividade de cache na janela ainda
// (nada pra julgar) — nunca inventa um numero antes disso.
function getCacheEfficiency() {
  const entries = readEntries(FIVE_HOURS_MS);
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  for (const e of entries) {
    cacheCreationTokens += e.cacheCreationTokens;
    cacheReadTokens += e.cacheReadTokens;
  }
  const total = cacheCreationTokens + cacheReadTokens;
  if (total === 0) return null;
  return { cacheCreationTokens, cacheReadTokens, hitRatio: cacheReadTokens / total };
}

// Deteccao de "sessao god": sessao dominada por releitura repetida de
// arquivos/busca (Read/Glob/Grep) em vez de trabalho novo — o padrao
// descrito no guia P0 que infla custo super-linearmente (M^1,46): cada
// releitura reenvia conteudo que ja estava no contexto, sem fazer o
// modelo avancar. Diferente de getCacheEfficiency() (que mede reuso de
// CACHE: cache_read vs cache_creation), esse conta quantas vezes
// ferramentas de leitura rodaram e quanto texto de retorno pesaram,
// relativo ao custo REAL da janela (tokensForEntry) — por isso pode
// acender cedo (ex. sessao ainda em 30% do teto) se a maior parte do
// gasto ja' e' releitura, mesmo com uso total ainda baixo. approxTokens
// de tool_result e' estimativa por tamanho de texto (chars/4), mesma
// logica ja usada em analyzeSessionCost/getToolBreakdownAllTime.
function getReadDominance(sinceMs) {
  const windowMs = sinceMs == null ? FIVE_HOURS_MS : sinceMs;
  const cutoff = Date.now() - windowMs;
  let totalTokens = 0;
  let readApproxTokens = 0;
  let readCount = 0;

  for (const file of listTranscriptFiles()) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const toolNameById = {};
    const seenIds = new Set();

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = Date.parse(obj.timestamp);
      if (Number.isNaN(ts) || ts < cutoff) continue;

      if (obj.type === 'assistant' && obj.message && obj.message.usage) {
        if (Array.isArray(obj.message.content)) {
          for (const c of obj.message.content) {
            if (c.type === 'tool_use' && c.id && c.name) toolNameById[c.id] = c.name;
          }
        }
        const id = obj.message.id;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        totalTokens += tokensForEntry(obj.message.usage);
      } else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
        for (const c of obj.message.content) {
          if (c.type !== 'tool_result') continue;
          const name = toolNameById[c.tool_use_id];
          if (activity.categorizeTool(name) !== 'read') continue;
          const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
          readApproxTokens += Math.round(text.length / 4);
          readCount += 1;
        }
      }
    }
  }

  return {
    totalTokens,
    readApproxTokens,
    readCount,
    readSharePct: totalTokens > 0 ? readApproxTokens / totalTokens : 0,
  };
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
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  const tokensByModel = {};
  // Mesmo motivo do dedup em readEntries(): cada resposta da API vira
  // varias linhas "assistant" (uma por bloco de conteudo), todas com o
  // `usage` inteiro repetido - sem isso, entryCount/totalTokens ficam
  // ~2x inflados numa sessao com pensamento estendido.
  const seenIds = new Set();

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
    const id = obj.message.id;
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    const u = obj.message.usage;
    const tokens = tokensForEntry(u);
    totalTokens += tokens;
    entryCount += 1;
    inputTokens += u.input_tokens || 0;
    outputTokens += u.output_tokens || 0;
    cacheCreationTokens += u.cache_creation_input_tokens || 0;
    cacheReadTokens += u.cache_read_input_tokens || 0;
    const model = obj.message.model || 'unknown';
    tokensByModel[model] = (tokensByModel[model] || 0) + tokens;
  }

  if (entryCount === 0) return null;

  const cacheTotal = cacheCreationTokens + cacheReadTokens;
  const cacheHitRatio = cacheTotal > 0 ? cacheReadTokens / cacheTotal : null;

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
    tokensByModel,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    cacheHitRatio,
    avgTokensPerMessage: totalTokens / entryCount,
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

// Classificacao de "verbosidade" de uma sessao: media de tokens por
// mensagem, relativa a sessao mais verbosa de um conjunto de referencia
// (normalmente o proprio historico local do usuario) — nao um numero
// absoluto inventado, mesma logica de honestidade de dados usada em
// getSevenDayMedian(). Usada tanto no export Excel (evaluation por
// sessao) quanto no alerta ao vivo do mascote.
function tierForAvgTokensPerMessage(avg, maxAvg) {
  const ratio = maxAvg > 0 ? avg / maxAvg : 0;
  if (ratio >= 0.9) return 'bad';
  if (ratio >= 0.6) return 'warn';
  return 'ok';
}

// Analise ao vivo do que esta pesando na janela de 5h: le tanto as
// linhas "assistant" (usage, dedupe por message.id) quanto as "user"
// (tool_result) pra achar qual ferramenta produziu mais volume de
// texto de retorno (Read de arquivo grande, saida de Bash, relatorio
// de um subagente Task/Agent, etc). approxTokens de tool_result e uma
// estimativa grosseira por tamanho de texto (chars/4) — nao vem com
// `usage` proprio, só a resposta inteira da API tem esse dado.
function analyzeSessionCost(sinceMs) {
  const windowMs = sinceMs == null ? FIVE_HOURS_MS : sinceMs;
  const cutoff = Date.now() - windowMs;
  const byTool = {};
  const bySession = {};
  let totalTokens = 0;
  let entryCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  for (const file of listTranscriptFiles()) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const toolNameById = {};
    const seenIds = new Set();
    const sessionKey = path.basename(file, '.jsonl');
    let sessionTokens = 0;
    let sessionCwd = null;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      // cwd e propriedade da sessao inteira, nao de uma entrada dentro
      // da janela de tempo - captura mesmo em linhas fora do cutoff,
      // senao uma sessao com atividade so no inicio nunca teria label.
      if (!sessionCwd && obj.cwd) sessionCwd = obj.cwd;

      const ts = Date.parse(obj.timestamp);
      if (Number.isNaN(ts) || ts < cutoff) continue;

      if (obj.type === 'assistant' && obj.message && obj.message.usage) {
        if (Array.isArray(obj.message.content)) {
          for (const c of obj.message.content) {
            if (c.type === 'tool_use' && c.id && c.name) toolNameById[c.id] = c.name;
          }
        }
        const id = obj.message.id;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        const u = obj.message.usage;
        const tokens = tokensForEntry(u);
        totalTokens += tokens;
        sessionTokens += tokens;
        entryCount += 1;
        inputTokens += u.input_tokens || 0;
        outputTokens += u.output_tokens || 0;
        cacheCreationTokens += u.cache_creation_input_tokens || 0;
        cacheReadTokens += u.cache_read_input_tokens || 0;
      } else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
        for (const c of obj.message.content) {
          if (c.type !== 'tool_result') continue;
          const name = toolNameById[c.tool_use_id] || 'outro';
          const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
          const approxTokens = Math.round(text.length / 4);
          byTool[name] = byTool[name] || { count: 0, approxTokens: 0 };
          byTool[name].count += 1;
          byTool[name].approxTokens += approxTokens;
        }
      }
    }

    if (sessionTokens > 0) {
      bySession[sessionKey] = {
        sessionId: sessionKey,
        project: sessionCwd ? path.basename(sessionCwd) : path.basename(path.dirname(file)),
        cwd: sessionCwd,
        tokens: sessionTokens,
      };
    }
  }

  const topOffenders = Object.entries(byTool)
    .map(([name, v]) => ({ name, count: v.count, approxTokens: v.approxTokens }))
    .sort((a, b) => b.approxTokens - a.approxTokens)
    .slice(0, 5);

  const sessionBreakdown = Object.values(bySession).sort((a, b) => b.tokens - a.tokens);

  return {
    windowHours: windowMs / (60 * 60 * 1000),
    totalTokens,
    entryCount,
    avgTokensPerMessage: entryCount > 0 ? totalTokens / entryCount : 0,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    topOffenders,
    activeSessionCount: sessionBreakdown.length,
    topSession: sessionBreakdown[0] || null,
    topSessionSharePct: totalTokens > 0 && sessionBreakdown[0]
      ? Math.round((sessionBreakdown[0].tokens / totalTokens) * 100)
      : 0,
  };
}

// Quanto cada ferramenta (Read, Bash, Grep, etc.) pesou em tokens de
// retorno, no historico INTEIRO (sem corte de tempo — usado no export
// Excel, que tambem cobre o historico completo de sessoes). approxTokens
// e' estimativa por tamanho de texto (chars/4), mesma logica de
// analyzeSessionCost, so' que sem janela de tempo.
function getToolBreakdownAllTime() {
  const byTool = {};
  for (const file of listTranscriptFiles()) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const toolNameById = {};
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
        for (const c of obj.message.content) {
          if (c.type === 'tool_use' && c.id && c.name) toolNameById[c.id] = c.name;
        }
      } else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
        for (const c of obj.message.content) {
          if (c.type !== 'tool_result') continue;
          const name = toolNameById[c.tool_use_id] || 'outro';
          const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
          const approxTokens = Math.round(text.length / 4);
          byTool[name] = byTool[name] || { count: 0, approxTokens: 0 };
          byTool[name].count += 1;
          byTool[name].approxTokens += approxTokens;
        }
      }
    }
  }
  return Object.entries(byTool)
    .map(([name, v]) => ({ name, count: v.count, approxTokens: v.approxTokens }))
    .sort((a, b) => b.approxTokens - a.approxTokens);
}

function getSnapshot() {
  const dailyLast30 = getThirtyDayHeatmap();
  const weeklyByModel = getWeeklyModelBreakdown();
  return {
    generatedAt: new Date().toISOString(),
    currentSession: getCurrentSessionUsage(),
    weeklyByModel,
    dailyLast30,
    todayTokens: getTodayTokens(),
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
  tierForAvgTokensPerMessage,
  analyzeSessionCost,
  getCacheEfficiency,
  getReadDominance,
  getToolBreakdownAllTime,
};

if (require.main === module) {
  console.log(JSON.stringify(getSnapshot(), null, 2));
}
