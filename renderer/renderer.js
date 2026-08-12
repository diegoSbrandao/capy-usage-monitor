'use strict';

const sparkEl = document.getElementById('spark');
const sparkStatusEl = document.getElementById('sparkStatus');
const statusDotEl = document.getElementById('statusDot');
const modelBreakdownEl = document.getElementById('modelBreakdown');
const realModelPctEl = document.getElementById('realModelPct');
const estCostSectionEl = document.getElementById('estCostSection');
const estCostEl = document.getElementById('estCost');
const heatmapEl = document.getElementById('heatmap');
const heatmapTotalEl = document.getElementById('heatmapTotal');
const exportBtn = document.getElementById('exportBtn');
const closeBtn = document.getElementById('closeBtn');
const spendPanelEl = document.getElementById('spendPanel');
const spendCloseBtn = document.getElementById('spendCloseBtn');
const spendSubtitleEl = document.getElementById('spendSubtitle');
const spendAvgValueEl = document.getElementById('spendAvgValue');
const spendCacheValueEl = document.getElementById('spendCacheValue');
const spendExplainerEl = document.getElementById('spendExplainer');
const spendOffendersLabelEl = document.getElementById('spendOffendersLabel');
const spendOffendersEl = document.getElementById('spendOffenders');
const spendClearBtn = document.getElementById('spendClearBtn');

const metrics = {
  session: {
    subtext: document.getElementById('sessionSubtext'),
    value: document.getElementById('sessionValue'),
    fill: document.getElementById('sessionBar'),
    badge: document.getElementById('sessionBadge'),
  },
  daily: {
    subtext: document.getElementById('dailySubtext'),
    value: document.getElementById('dailyValue'),
    fill: document.getElementById('dailyBar'),
  },
  monthly: {
    subtext: document.getElementById('monthlySubtext'),
    value: document.getElementById('monthlyValue'),
    fill: document.getElementById('monthlyBar'),
  },
  weekly: {
    subtext: document.getElementById('weeklySubtext'),
    value: document.getElementById('weeklyValue'),
    fill: document.getElementById('weeklyBar'),
    badge: document.getElementById('weeklyBadge'),
  },
  sonnet: {
    subtext: document.getElementById('sonnetSubtext'),
    value: document.getElementById('sonnetValue'),
    fill: document.getElementById('sonnetBar'),
  },
  opus: {
    subtext: document.getElementById('opusSubtext'),
    value: document.getElementById('opusValue'),
    fill: document.getElementById('opusBar'),
  },
};

const perModelSectionEl = document.getElementById('perModelSection');
const sonnetCardEl = document.getElementById('sonnetCard');
const opusCardEl = document.getElementById('opusCard');

const extraUsageSectionEl = document.getElementById('extraUsageSection');
const extraUsageDotEl = document.getElementById('extraUsageDot');
const extraUsageValueEl = document.getElementById('extraUsageValue');

const accountDisconnectedEl = document.getElementById('accountDisconnected');
const accountPasteRowEl = document.getElementById('accountPasteRow');
const accountConnectedEl = document.getElementById('accountConnected');
const accountErrorEl = document.getElementById('accountError');
const titlebarEmailEl = document.getElementById('titlebarEmail');
const titlebarEmailTextEl = document.getElementById('titlebarEmailText');
const connectBtn = document.getElementById('connectBtn');
const submitCodeBtn = document.getElementById('submitCodeBtn');
const codeInput = document.getElementById('codeInput');
const logoutBtn = document.getElementById('logoutBtn');

const minimizeBtn = document.getElementById('minimizeBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const dailyAlertToggle = document.getElementById('dailyAlertToggle');
const dailyAlertPercent = document.getElementById('dailyAlertPercent');
const dailyAlertPercentRow = document.getElementById('dailyAlertPercentRow');
const settingsSaveBtn = document.getElementById('settingsSaveBtn');
const autoStartToggle = document.getElementById('autoStartToggle');

const clockEl = document.getElementById('clock');
const sceneEl = document.getElementById('scene');
const compactPctEl = document.getElementById('compactPct');
const compactBarFillEl = document.getElementById('compactBarFill');
const compactExpandBtn = document.getElementById('compactExpandBtn');

let showingPasteRow = false;
let profileRequested = false;
let isCompact = false;
let lastSnapshot = null;

const FLAG_MESSAGE = 'Eita! Meta diaria batida, desacelera um pouco!';
const ATTENTION_MESSAGE = 'Terminal te chamando, da uma olhada!';
const RESET_MESSAGE = 'Prontos de novo!';
const CACHE_WASTE_MESSAGE = 'Cache pouco aproveitado, contexto repetindo sem reuso.';

const STATUS_LABEL = {
  working: 'trabalhando',
  idle: 'parado',
  light: 'tomando cafe',
  asleep: 'dormindo',
  hot: 'quase la...',
  alert: 'no limite!',
};

const STATUS_DOT_COLOR = {
  working: 'oklch(0.75 0.16 150)',
  idle: 'oklch(0.55 0.01 260)',
  light: 'oklch(0.75 0.15 85)',
  asleep: 'oklch(0.55 0.01 260)',
  hot: 'oklch(0.75 0.15 55)',
  alert: 'oklch(0.65 0.19 25)',
};

let previousSessionRatio = null;
let transientTimeout = null;
let currentTransient = null;

function addTransient(cls, durationMs) {
  currentTransient = cls;
  sparkEl.classList.add(cls);
  clearTimeout(transientTimeout);
  transientTimeout = setTimeout(() => {
    sparkEl.classList.remove(cls);
    currentTransient = null;
  }, durationMs);
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Preenche o painel "por que essa sessao esta pesando" a partir do
// retorno de window.capyApi.analyzeSpend() (dados brutos, ver
// usage.js::analyzeSessionCost). Formatacao/decisao de texto fica no
// renderer de proposito - main/usage.js so fornecem numeros.
function renderSpendAnalysis(a) {
  const cacheSharePct = a.totalTokens > 0 ? Math.round((a.cacheReadTokens / a.totalTokens) * 100) : 0;

  spendSubtitleEl.textContent = `Ultimas ${a.windowHours}h · ${formatTokens(a.totalTokens)} tokens · ${a.entryCount} mensagens`;
  spendAvgValueEl.textContent = formatTokens(Math.round(a.avgTokensPerMessage));
  spendCacheValueEl.textContent = `${cacheSharePct}%`;

  const offenders = a.topOffenders.filter((o) => o.approxTokens > 0);
  const topOffender = offenders[0];
  const base = 'O contexto cresce a cada resposta e nao diminui sozinho — conversas longas ficam caras.';

  // Cada terminal Claude Code grava seu proprio arquivo de sessao -
  // topSession vem de usage.js agrupado por sessionId. IMPORTANTE: isso
  // conta sessoes com atividade na janela, nao terminais que ainda
  // estao abertos agora - um terminal fechado ha 4h ainda entra na
  // janela de 5h. Por isso o texto nao diz "terminais ativos".
  let sessionNote = '';
  if (a.activeSessionCount > 1 && a.topSession) {
    sessionNote = ` ${a.activeSessionCount} sessoes tiveram atividade nessa janela de ${a.windowHours}h (podem ja estar fechadas) — a de "${a.topSession.project}" pesou mais, ${a.topSessionSharePct}% do total.`;
  }

  let explainer;
  if (a.avgTier === 'bad' && topOffender) {
    explainer = `${base} ${topOffender.name} sozinho ja consumiu ${formatTokens(topOffender.approxTokens)} tokens nessa janela — e o maior peso agora.${sessionNote} Abra um terminal novo com o contexto intacto e cole /compact pra reduzir o custo.`;
  } else if (a.avgTier === 'bad') {
    explainer = `${base} Media por mensagem esta na faixa mais alta do seu historico.${sessionNote} Abra um terminal novo com o contexto intacto e cole /compact pra reduzir o custo.`;
  } else if (a.avgTier === 'warn' && topOffender) {
    explainer = `${base} ${topOffender.name} e quem mais pesa por enquanto (${formatTokens(topOffender.approxTokens)} tokens).${sessionNote} De olho antes de crescer mais.`;
  } else if (cacheSharePct < 50 && a.totalTokens > 0) {
    explainer = `${base} Pouco cache reaproveitado ainda (${cacheSharePct}%) — cada resposta esta relendo bastante contexto do zero.${sessionNote}`;
  } else {
    explainer = `${base}${sessionNote} Abra um terminal novo com o contexto intacto e cole /compact pra reduzir o custo.`;
  }
  spendExplainerEl.textContent = explainer;

  spendOffendersEl.innerHTML = '';
  spendOffendersLabelEl.classList.toggle('hidden', offenders.length === 0);
  const max = Math.max(1, ...offenders.map((o) => o.approxTokens));
  for (const o of offenders) {
    const pct = Math.max(4, Math.round((o.approxTokens / max) * 100));
    const row = document.createElement('div');
    row.className = 'spend-offender-row';
    row.innerHTML = `
      <div class="spend-offender-top">
        <span class="spend-offender-name">${o.name}</span>
        <span class="spend-offender-value">~${formatTokens(o.approxTokens)} · ${o.count}x</span>
      </div>
      <div class="spend-offender-track"><div class="spend-offender-fill" style="width:${pct}%"></div></div>
    `;
    spendOffendersEl.appendChild(row);
  }
}

function formatMoney(amount, currency) {
  if (!currency) return String(amount);
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatDuration(ms) {
  if (ms == null || ms <= 0) return null;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}min` : `${m}min`;
}

// Pra janelas longas (semana), dias fazem mais sentido que "137h".
function formatDurationDays(ms) {
  if (ms == null || ms <= 0) return null;
  const totalHours = Math.round(ms / 3600000);
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  if (d === 0) return `${h}h`;
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

// Progressao de 0 a 100% em 6 faixas (verde claro -> vermelho maximo).
function tierFor(ratio) {
  const pct = Math.min(1, ratio) * 100;
  if (pct < 20) return 'l1';
  if (pct < 40) return 'l2';
  if (pct < 60) return 'l3';
  if (pct < 80) return 'l4';
  if (pct < 95) return 'l5';
  return 'l6';
}

function setBarTier(fillEl, ratio) {
  const pct = Math.min(100, Math.round(ratio * 100));
  fillEl.style.width = `${pct}%`;
  fillEl.className = `bar-fill ${tierFor(ratio)}`;
}

function renderMetric(m, used, limit, ratio, realInfo, useDaysForReset) {
  setBarTier(m.fill, ratio);
  m.value.className = `metric-value ${tierFor(ratio)}`;
  if (realInfo) {
    const resetTxt = useDaysForReset
      ? formatDurationDays(realInfo.resetMs)
      : formatDuration(realInfo.resetMs);
    m.subtext.textContent = resetTxt ? `reinicia em ${resetTxt}` : '';
    m.value.textContent = `${Math.round(realInfo.pct)}%`;
  } else {
    const limitPct = limit ? Math.round((used / limit) * 100) : 0;
    m.subtext.textContent = `${limitPct}% do teto`;
    m.value.textContent = `${formatTokens(used)} / ${formatTokens(limit)}`;
  }
}

// Hoje/Mes: nao existe teto oficial da Anthropic pra nenhum dos dois, entao
// nao mostramos percentual nem "usado/limite" (confunde, parece um limite
// real) — so o total de tokens gastos na janela. A barra usa a cor de
// marca (laranja, mesma do icone/mascote) em vez do gradiente verde->
// vermelho — nao e mais um indicador de "quao perto do limite", entao a
// cor de urgencia nao faz sentido aqui.
function renderSpentOnly(m, used, ratio) {
  const pct = Math.min(100, Math.round(ratio * 100));
  m.fill.style.width = `${pct}%`;
  m.fill.className = 'bar-fill accent';
  m.subtext.textContent = '';
  m.value.className = 'metric-value';
  m.value.textContent = `${formatTokens(used)} tokens`;
}

function setBadge(el, isReal) {
  if (!el) return;
  el.textContent = isReal ? 'real' : 'teto pessoal';
  el.title = isReal
    ? 'Percentual oficial, vindo direto da API da Anthropic (mesmo dado do painel Settings -> Usage).'
    : 'Sem conta conectada: comparado contra um teto local configuravel (config.json), nao um limite oficial da Anthropic.';
  el.classList.toggle('real', isReal);
}

function updateAccountUI(connected) {
  if (connected) {
    showingPasteRow = false;
    accountDisconnectedEl.classList.add('hidden');
    accountPasteRowEl.classList.add('hidden');
    accountConnectedEl.classList.remove('hidden');
    if (!profileRequested) {
      profileRequested = true;
      window.capyApi.getProfile().then((p) => {
        if (p && p.email) {
          titlebarEmailTextEl.textContent = p.email;
          titlebarEmailEl.classList.remove('hidden');
        }
      });
    }
  } else {
    accountConnectedEl.classList.add('hidden');
    profileRequested = false;
    accountDisconnectedEl.classList.toggle('hidden', showingPasteRow);
    accountPasteRowEl.classList.toggle('hidden', !showingPasteRow);
    titlebarEmailEl.classList.add('hidden');
  }
}

function renderModelBreakdown(byModel) {
  modelBreakdownEl.innerHTML = '';
  const entries = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    modelBreakdownEl.innerHTML = '<div class="model-row-top"><span>sem dados</span></div>';
    return;
  }
  const filteredEntries = entries.filter(([, tokens]) => tokens > 0);
  if (filteredEntries.length === 0) {
    modelBreakdownEl.innerHTML = '<div class="model-row-top"><span>sem dados</span></div>';
    return;
  }
  const max = Math.max(1, ...filteredEntries.map(([, tokens]) => tokens));
  for (const [model, tokens] of filteredEntries) {
    const row = document.createElement('div');
    row.className = 'model-row';
    const pct = Math.max(2, Math.round((tokens / max) * 100));
    row.innerHTML = `
      <div class="model-row-top">
        <span class="model-name">${model}</span>
        <span class="model-value">${formatTokens(tokens)}</span>
      </div>
      <div class="model-bar-track"><div class="model-bar-fill" style="width:${pct}%"></div></div>
    `;
    modelBreakdownEl.appendChild(row);
  }
}

// Sonnet/Opus (janela de 7 dias) sao percentuais oficiais que ja vem de
// graca no mesmo fetchUsage() do OAuth (auth.js) mas ate agora eram
// descartados. So mostra quando conectado e quando a API de fato manda
// aquele campo (plano sem Opus, por exemplo, nao deve aparecer como 0%).
function renderRealModelPct(sonnet, opus) {
  const parts = [];
  if (sonnet) parts.push(`Sonnet 7d: ${Math.round(sonnet.pct)}%`);
  if (opus) parts.push(`Opus 7d: ${Math.round(opus.pct)}%`);
  if (parts.length === 0) {
    realModelPctEl.classList.add('hidden');
    return;
  }
  realModelPctEl.textContent = parts.join(' · ');
  realModelPctEl.title = 'Percentual oficial da API (mesma janela do painel Settings -> Usage), por modelo.';
  realModelPctEl.classList.remove('hidden');
}

// Raiz quadrada em vez de razao linear: um unico dia excepcional (ex.:
// sessao maratona de milhares de mensagens) nao pode esmagar a escala
// e jogar todo o resto do mes pro piso quase invisivel - sqrt comprime
// a distancia até o pico mas ainda preserva diferenca entre dias
// "normais" (o que a razao linear contra o maximo bruto perdia).
function levelFor(tokens, max) {
  if (!max || tokens === 0) return 0;
  const ratio = Math.sqrt(tokens) / Math.sqrt(max);
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.2) return 2;
  return 1;
}

function periodForHour(h) {
  if (h < 6) return 'madrugada';
  if (h < 10) return 'manha';
  if (h < 16) return 'meiodia';
  if (h < 19) return 'tarde';
  return 'noite';
}

// Chuva e' independente do horario (camada extra por cima do periodo do
// dia, igual no design de referencia) - sem API de clima, so' sorteia
// uma chance pequena de vez em quando, por variedade visual. Reroll a
// cada 3h pra nao ficar travado num estado o dia inteiro.
const RAIN_CHANCE = 0.15;
const RAIN_REROLL_MS = 3 * 60 * 60 * 1000;
let isRaining = Math.random() < RAIN_CHANCE;
setInterval(() => { isRaining = Math.random() < RAIN_CHANCE; }, RAIN_REROLL_MS);

function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  clockEl.textContent = `${hh}:${mm}`;
  sceneEl.dataset.period = periodForHour(now.getHours());
  sceneEl.dataset.weather = isRaining ? 'rain' : 'clear';
}

updateClock();
setInterval(updateClock, 15000);

// Chave de dia no fuso LOCAL, nao UTC - tem que bater com localDateKey()
// de usage.js (mesmo fuso, mesmo criterio de "dia"), senao o rotulo
// aqui nao acha os tokens que o main process guardou sob outra chave.
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function renderHeatmap(dailyLast30) {
  heatmapEl.innerHTML = '';
  const days = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(localDateKey(d));
  }
  const max = Math.max(1, ...Object.values(dailyLast30));
  let total = 0;
  for (const day of days) {
    const tokens = dailyLast30[day] || 0;
    total += tokens;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.title = `${day}: ${formatTokens(tokens)} tokens`;
    bar.dataset.level = String(levelFor(tokens, max));
    const heightPct = tokens === 0 ? 6 : Math.max(10, Math.round((Math.sqrt(tokens) / Math.sqrt(max)) * 100));
    bar.style.height = `${heightPct}%`;
    heatmapEl.appendChild(bar);
  }
  heatmapTotalEl.textContent = `${formatTokens(total)} tokens`;
}

function renderCompactPct(ratio) {
  const pct = Math.round(ratio * 100);
  compactPctEl.textContent = `${pct}%`;
  compactPctEl.className = 'compact-pct';
  compactBarFillEl.className = 'compact-bar-fill';
  compactBarFillEl.style.width = `${Math.min(100, pct)}%`;
  // Faixas: 0-40 verde, 41-79 amarelo, 80-100+ vermelho.
  let glowColor = '#3ee673';
  if (pct >= 80) {
    compactPctEl.classList.add('danger');
    compactBarFillEl.classList.add('danger');
    glowColor = '#ff4d3d';
  } else if (pct >= 41) {
    compactPctEl.classList.add('warn');
    compactBarFillEl.classList.add('warn');
    glowColor = '#ffd23f';
  }
  sparkEl.style.setProperty('--glow-color', glowColor);
}

function render(snapshot) {
  lastSnapshot = snapshot;
  const { currentSession, weeklyByModel, dailyLast30, limits, ratios, sevenDayMedianTokens, activityState, toolCategory, real, dailyAlert, attention, justReset, spendAlert, cacheWaste } = snapshot;

  renderMetric(metrics.session, currentSession.totalTokens, limits.session, ratios.session, real.session);
  renderSpentOnly(metrics.daily, snapshot.todayTokens, ratios.daily);
  renderSpentOnly(metrics.monthly, snapshot.monthlyTokens, ratios.monthly);
  renderMetric(metrics.weekly, snapshot.weeklyTokens, limits.weekly, ratios.weekly, real.week, true);
  setBadge(metrics.session.badge, !!real.session);
  setBadge(metrics.weekly.badge, !!real.week);
  updateAccountUI(real.connected);

  // Buckets por modelo (Sonnet/Opus) so existem no retorno oficial da API
  // pra quem tem plano Max — sem conta conectada ou em Pro, ambos vem
  // null e a secao inteira fica escondida (sem teto local pra fallback,
  // nao tem como estimar isso por modelo especifico).
  const hasSonnet = !!real.sonnet;
  const hasOpus = !!real.opus;
  perModelSectionEl.classList.toggle('hidden', !hasSonnet && !hasOpus);
  sonnetCardEl.classList.toggle('hidden', !hasSonnet);
  opusCardEl.classList.toggle('hidden', !hasOpus);
  if (hasSonnet) renderMetric(metrics.sonnet, 0, 0, real.sonnet.pct / 100, real.sonnet, true);
  if (hasOpus) renderMetric(metrics.opus, 0, 0, real.opus.pct / 100, real.opus, true);

  // Credito avulso (pay-per-use): mostra sempre que ja teve gasto extra no
  // periodo (usedAmount > 0), mesmo se `eu.enabled` vier false da API —
  // esse campo reflete se o pay-per-use esta ligado AGORA pra futuros
  // gastos, nao se ha historico pra mostrar (ex.: usuario desligou depois
  // de estourar o limite, mas o gasto do periodo continua real e relevante).
  const eu = real.extraUsage;
  const hasExtraUsage = !!(eu && eu.usedAmount > 0);
  extraUsageSectionEl.classList.toggle('hidden', !hasExtraUsage);
  if (hasExtraUsage) {
    extraUsageDotEl.classList.toggle('danger', !!eu.spendLimitReached);
    extraUsageValueEl.classList.toggle('danger', !!eu.spendLimitReached);
    extraUsageValueEl.textContent = formatMoney(eu.usedAmount, eu.currency);
    extraUsageValueEl.title = eu.spendLimitReached ? 'Limite de gasto extra batido' : 'Cobrindo alem do teto do plano';
  }

  renderModelBreakdown(weeklyByModel);
  renderRealModelPct(real.sonnet, real.opus);
  renderHeatmap(dailyLast30);
  if (sevenDayMedianTokens == null) {
    estCostSectionEl.classList.add('hidden');
  } else {
    estCostSectionEl.classList.remove('hidden');
    estCostEl.textContent = `${formatTokens(sevenDayMedianTokens)} tokens/dia`;
  }

  // Conectado: `justReset` vem do main (main.js::pollUsage), detectado a
  // partir do resetMs oficial da API voltando pra cima entre um poll e
  // outro - pega o reset de verdade, mesmo com uso baixo/medio. Sem
  // conta conectada nao ha timestamp oficial, entao mantem a heuristica
  // antiga como fallback (so pega reset vindo de perto do limite).
  if (justReset) {
    addTransient('celebrating', 3200);
  } else if (previousSessionRatio != null && previousSessionRatio >= 0.9 && ratios.session < 0.3) {
    addTransient('celebrating', 3200);
  }
  previousSessionRatio = ratios.session;

  sparkEl.className = `spark ${activityState}`;
  if (toolCategory) sparkEl.dataset.tool = toolCategory;
  else delete sparkEl.dataset.tool;
  if (activityState === 'light') {
    // Alterna entre cafe e TV a cada 30s pra dar variedade na mesma fase.
    sparkEl.dataset.light = Math.floor(Date.now() / 30000) % 2 === 0 ? 'coffee' : 'tv';
  } else {
    delete sparkEl.dataset.light;
  }
  if (currentTransient) sparkEl.classList.add(currentTransient);
  sparkEl.classList.toggle('flagged', !!dailyAlert);
  sparkEl.classList.toggle('attention', !!attention);
  sparkEl.classList.toggle('spendAlert', !!spendAlert);
  sparkEl.classList.toggle('cache-warn', !!cacheWaste);

  // Prioridade: precisa de voce agora (terminal) > acabou de renovar >
  // meta diaria > cache desperdicado (o mais soft dos tres, so
  // informativo) > estado normal. Reset so aparece durante a propria
  // janela transiente de `.celebrating` (nao fica preso na tela).
  sparkStatusEl.textContent = attention
    ? ATTENTION_MESSAGE
    : currentTransient === 'celebrating'
      ? RESET_MESSAGE
      : dailyAlert
        ? FLAG_MESSAGE
        : cacheWaste
          ? CACHE_WASTE_MESSAGE
          : (STATUS_LABEL[activityState] || activityState);
  statusDotEl.style.background = attention
    ? 'oklch(0.75 0.15 85)'
    : dailyAlert
      ? STATUS_DOT_COLOR.alert
      : cacheWaste
        ? 'oklch(0.7 0.12 220)'
        : (STATUS_DOT_COLOR[activityState] || STATUS_DOT_COLOR.idle);
  renderCompactPct(ratios.session);
}

window.capyApi.onUpdate(render);
window.capyApi.requestSnapshot().then(render);

// Reage a mudanca de attention.json na hora, sem esperar o proximo poll
// pesado (que le todo o historico de sessao do disco). So alterna o badge
// e a linha de status, reaproveitando o resto do ultimo snapshot renderizado.
function applyAttention(active) {
  if (!lastSnapshot) return;
  lastSnapshot.attention = active;
  sparkEl.classList.toggle('attention', active);
  const { dailyAlert, cacheWaste, activityState } = lastSnapshot;
  sparkStatusEl.textContent = active
    ? ATTENTION_MESSAGE
    : currentTransient === 'celebrating'
      ? RESET_MESSAGE
      : dailyAlert
        ? FLAG_MESSAGE
        : cacheWaste
          ? CACHE_WASTE_MESSAGE
          : (STATUS_LABEL[activityState] || activityState);
  statusDotEl.style.background = active
    ? 'oklch(0.75 0.15 85)'
    : dailyAlert
      ? STATUS_DOT_COLOR.alert
      : cacheWaste
        ? 'oklch(0.7 0.12 220)'
        : (STATUS_DOT_COLOR[activityState] || STATUS_DOT_COLOR.idle);
}
window.capyApi.onAttentionUpdate(applyAttention);

sparkEl.addEventListener('click', () => {
  addTransient('poked', 400);
  if (lastSnapshot && lastSnapshot.spendAlert) {
    spendPanelEl.classList.remove('hidden');
    spendSubtitleEl.textContent = 'Analisando...';
    window.capyApi.analyzeSpend().then(renderSpendAnalysis);
  }
});

spendCloseBtn.addEventListener('click', () => {
  spendPanelEl.classList.add('hidden');
});

spendClearBtn.addEventListener('click', async () => {
  const original = spendClearBtn.textContent;
  spendClearBtn.disabled = true;
  spendClearBtn.textContent = 'Abrindo terminal...';
  const result = await window.capyApi.openContinueTerminal();
  spendClearBtn.disabled = false;
  spendClearBtn.textContent = result.ok ? 'Aberto! Cole "/compact" la pra economizar' : `Erro: ${result.error}`;
  setTimeout(() => {
    spendClearBtn.textContent = original;
    if (result.ok) spendPanelEl.classList.add('hidden');
  }, 2600);
});

exportBtn.addEventListener('click', () => {
  window.capyApi.exportXlsx();
});

closeBtn.addEventListener('click', () => {
  window.capyApi.hideWindow();
});

connectBtn.addEventListener('click', () => {
  window.capyApi.authStart();
  showingPasteRow = true;
  updateAccountUI(false);
  accountErrorEl.classList.add('hidden');
});

submitCodeBtn.addEventListener('click', () => {
  const code = codeInput.value.trim();
  if (!code) return;
  submitCodeBtn.disabled = true;
  submitCodeBtn.textContent = 'verificando...';
  window.capyApi.authSubmitCode(code);
});

logoutBtn.addEventListener('click', () => {
  window.capyApi.authLogout();
});

window.capyApi.onAuthResult((result) => {
  submitCodeBtn.disabled = false;
  submitCodeBtn.textContent = 'Confirmar';
  if (result.ok) {
    codeInput.value = '';
    accountErrorEl.classList.add('hidden');
  } else {
    accountErrorEl.textContent = result.error || 'falha ao conectar';
    accountErrorEl.classList.remove('hidden');
  }
});

function setCompactMode(next) {
  isCompact = next;
  document.body.classList.toggle('compact', isCompact);
  minimizeBtn.title = isCompact ? 'Restaurar' : 'Modo compacto';
  window.capyApi.setCompact(isCompact);
}

minimizeBtn.addEventListener('click', () => setCompactMode(!isCompact));
compactExpandBtn.addEventListener('click', () => setCompactMode(false));

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
  if (!settingsPanel.classList.contains('hidden')) {
    window.capyApi.getSettings().then((s) => {
      dailyAlertToggle.checked = !!s.dailyAlertEnabled;
      dailyAlertPercent.value = s.dailyAlertPercent == null ? 100 : s.dailyAlertPercent;
      dailyAlertPercentRow.classList.toggle('disabled', !s.dailyAlertEnabled);
    });
    window.capyApi.getAutoStart().then((enabled) => {
      autoStartToggle.checked = !!enabled;
    });
  }
});

dailyAlertToggle.addEventListener('change', () => {
  dailyAlertPercentRow.classList.toggle('disabled', !dailyAlertToggle.checked);
});

// Estado do SO, nao de settings.json — aplica na hora, sem esperar "Salvar".
autoStartToggle.addEventListener('change', () => {
  window.capyApi.setAutoStart(autoStartToggle.checked);
});

settingsSaveBtn.addEventListener('click', () => {
  window.capyApi.saveSettings({
    dailyAlertEnabled: dailyAlertToggle.checked,
    dailyAlertPercent: Number(dailyAlertPercent.value),
  });
  settingsPanel.classList.add('hidden');
});
