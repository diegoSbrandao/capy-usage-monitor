'use strict';

// Hook "UserPromptSubmit" do Claude Code (configurado em
// ~/.claude/settings.json, GLOBAL - roda em qualquer sessao, nao so
// dentro deste repo). Avisa DENTRO DO TERMINAL (via additionalContext,
// mesmo mecanismo usado pelo caveman-mode-tracker.js) quando a sessao
// atual (o arquivo .jsonl que esse hook recebeu em transcript_path) ja
// esta "sessao god": extensa demais (muitas mensagens ou tempo) OU cara
// demais por mensagem (media bem acima da mediana historica). E'
// complementar ao badge/painel do widget (ver LONG_SESSION_* em main.js) -
// mesma logica de gatilho, aplicada aqui a UMA sessao/conversa especifica
// em vez do agregado de 5h de todos os projetos.
//
// Desempenho: nao pode escanear o historico inteiro a cada prompt (caro,
// ver nota de performance em usage.js/README) - so le o PROPRIO arquivo de
// transcript (rapido, usage.parseSessionFile) e um cache pequeno
// (session-baseline.json) que o widget (main.js::refreshSessionBaseline)
// atualiza sozinho a cada poucos minutos. Se o widget nao estiver rodando
// (cache ausente/velho), o gatilho de custo fica desligado e so' o de
// tamanho/duracao continua ativo.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.capy-usage-monitor');
const BASELINE_PATH = path.join(DATA_DIR, 'session-baseline.json');
const BASELINE_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h - widget parado por mais tempo que isso, ignora
const WARN_STATE_DIR = path.join(DATA_DIR, 'long-session-warned');
const WARN_COOLDOWN_MS = 10 * 60 * 1000; // nao repete o aviso a cada prompt, so' a cada 10min

// Mesmos valores/logica de LONG_SESSION_* em main.js (widget) - mantenha os
// dois em sincronia se ajustar um dos lados.
const LONG_SESSION_MIN_MESSAGES = 40;
const LONG_SESSION_MIN_DURATION_MS = 3 * 60 * 60 * 1000;
const LONG_SESSION_MIN_MESSAGES_FOR_COST = 8;
const LONG_SESSION_COST_MULTIPLIER = 1.8;

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}min` : `${m}min`;
}

function readBaseline() {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    if (Date.now() - raw.computedAt > BASELINE_MAX_AGE_MS) return null;
    return raw.medianAvgTokensPerMessage > 0 ? raw.medianAvgTokensPerMessage : null;
  } catch {
    return null;
  }
}

function shouldWarn(sessionId) {
  const statePath = path.join(WARN_STATE_DIR, `${sessionId}.json`);
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (Date.now() - state.lastWarnedAt < WARN_COOLDOWN_MS) return false;
  } catch {
    // sem estado previo - primeiro aviso desta sessao, segue.
  }
  return true;
}

function markWarned(sessionId) {
  try {
    fs.mkdirSync(WARN_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WARN_STATE_DIR, `${sessionId}.json`), JSON.stringify({ lastWarnedAt: Date.now() }));
  } catch {
    // best-effort - pior caso, avisa nas proximas mensagens tambem.
  }
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const transcriptPath = data.transcript_path;
    const sessionId = data.session_id || (transcriptPath && path.basename(transcriptPath, '.jsonl'));
    if (!transcriptPath || !sessionId || !fs.existsSync(transcriptPath)) return;

    const usage = require(path.join(__dirname, '..', 'usage.js'));
    const summary = usage.parseSessionFile(transcriptPath);
    if (!summary) return;

    const durationMs = Date.now() - summary.startMs;
    const sizeTrigger = summary.entryCount >= LONG_SESSION_MIN_MESSAGES || durationMs >= LONG_SESSION_MIN_DURATION_MS;

    const median = readBaseline();
    const costTrigger = !!(
      summary.entryCount >= LONG_SESSION_MIN_MESSAGES_FOR_COST &&
      median &&
      summary.avgTokensPerMessage >= median * LONG_SESSION_COST_MULTIPLIER
    );

    if (!sizeTrigger && !costTrigger) return;
    if (!shouldWarn(sessionId)) return;
    markWarned(sessionId);

    const reasons = [];
    if (sizeTrigger) {
      reasons.push(`${summary.entryCount} mensagens, ${formatDuration(durationMs)} de sessao`);
    }
    if (costTrigger) {
      reasons.push(`media de ${formatTokens(summary.avgTokensPerMessage)} tokens/mensagem (mediana historica: ${formatTokens(median)})`);
    }

    const message =
      `Aviso: sua sessao esta longa/cara demais (${reasons.join('; ')}). ` +
      `Recomendo abrir uma sessao nova. Use subagentes pra acelerar tarefas grandes sem inflar o contexto principal.`;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: message,
      },
    }));
  } catch {
    // silencioso - hook nunca pode travar o fluxo do Claude Code.
  }
});
