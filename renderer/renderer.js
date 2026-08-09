'use strict';

const sparkEl = document.getElementById('spark');
const sparkStatusEl = document.getElementById('sparkStatus');
const modelBreakdownEl = document.getElementById('modelBreakdown');
const estCostEl = document.getElementById('estCost');
const heatmapEl = document.getElementById('heatmap');
const exportBtn = document.getElementById('exportBtn');
const closeBtn = document.getElementById('closeBtn');

const bars = {
  session: { text: document.getElementById('sessionTokens'), fill: document.getElementById('sessionBar') },
  daily: { text: document.getElementById('dailyTokens'), fill: document.getElementById('dailyBar') },
  weekly: { text: document.getElementById('weeklyTokens'), fill: document.getElementById('weeklyBar') },
  monthly: { text: document.getElementById('monthlyTokens'), fill: document.getElementById('monthlyBar') },
};

const STATUS_LABEL = {
  working: 'trabalhando',
  light: 'uma pausa pro cafe',
  idle: 'dormindo',
  hot: 'quase la...',
  alert: 'no limite!',
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

function renderBar(bar, used, limit, ratio) {
  bar.text.textContent = `${formatTokens(used)} / ${formatTokens(limit)}`;
  const pct = Math.min(100, Math.round(ratio * 100));
  bar.fill.style.width = `${pct}%`;
  bar.fill.className = 'bar-fill';
  if (ratio >= 1) bar.fill.classList.add('danger');
  else if (ratio >= 0.75) bar.fill.classList.add('warn');
}

function renderModelBreakdown(byModel) {
  modelBreakdownEl.innerHTML = '';
  const entries = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    modelBreakdownEl.innerHTML = '<div class="model-row"><span>sem dados</span></div>';
    return;
  }
  for (const [model, tokens] of entries) {
    const row = document.createElement('div');
    row.className = 'model-row';
    row.innerHTML = `<span>${model}</span><span>${formatTokens(tokens)}</span>`;
    modelBreakdownEl.appendChild(row);
  }
}

function levelFor(tokens, max) {
  if (!max || tokens === 0) return 0;
  const ratio = tokens / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.2) return 2;
  return 1;
}

function renderHeatmap(dailyLast30) {
  heatmapEl.innerHTML = '';
  const days = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const max = Math.max(1, ...Object.values(dailyLast30));
  for (const day of days) {
    const tokens = dailyLast30[day] || 0;
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.title = `${day}: ${formatTokens(tokens)} tokens`;
    cell.dataset.level = String(levelFor(tokens, max));
    heatmapEl.appendChild(cell);
  }
}

function render(snapshot) {
  const { currentSession, weeklyByModel, dailyLast30, limits, ratios, estimatedWeeklyCostUsd, activityState, toolCategory } = snapshot;

  renderBar(bars.session, currentSession.totalTokens, limits.session, ratios.session);
  renderBar(bars.daily, snapshot.todayTokens, limits.daily, ratios.daily);
  renderBar(bars.weekly, snapshot.weeklyTokens, limits.weekly, ratios.weekly);
  renderBar(bars.monthly, snapshot.monthlyTokens, limits.monthly, ratios.monthly);

  renderModelBreakdown(weeklyByModel);
  renderHeatmap(dailyLast30);
  estCostEl.textContent = `~$${estimatedWeeklyCostUsd.toFixed(2)}`;

  // Janela de 5h estourada (>=90%) que caiu bem baixo de novo = renovou. Comemora.
  if (previousSessionRatio != null && previousSessionRatio >= 0.9 && ratios.session < 0.3) {
    addTransient('celebrating', 1200);
  }
  previousSessionRatio = ratios.session;

  sparkEl.className = `spark ${activityState}`;
  if (toolCategory) sparkEl.dataset.tool = toolCategory;
  else delete sparkEl.dataset.tool;
  if (currentTransient) sparkEl.classList.add(currentTransient);

  sparkStatusEl.textContent = STATUS_LABEL[activityState] || activityState;
}

window.capyApi.onUpdate(render);
window.capyApi.requestSnapshot().then(render);

sparkEl.addEventListener('click', () => addTransient('poked', 400));

exportBtn.addEventListener('click', () => {
  window.capyApi.exportCsv();
});

closeBtn.addEventListener('click', () => {
  window.capyApi.hideWindow();
});
