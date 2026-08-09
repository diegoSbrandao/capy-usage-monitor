'use strict';

const capyEl = document.getElementById('capy');
const capyStatusEl = document.getElementById('capyStatus');
const sessionTokensEl = document.getElementById('sessionTokens');
const sessionBarEl = document.getElementById('sessionBar');
const modelBreakdownEl = document.getElementById('modelBreakdown');
const estCostEl = document.getElementById('estCost');
const heatmapEl = document.getElementById('heatmap');
const exportBtn = document.getElementById('exportBtn');
const closeBtn = document.getElementById('closeBtn');

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function setCapyState(ratio, entryCount) {
  capyEl.className = 'capy';
  if (ratio >= 1) {
    capyEl.classList.add('alert');
    capyStatusEl.textContent = 'no limite!';
  } else if (ratio >= 0.75) {
    capyEl.classList.add('working');
    capyStatusEl.textContent = 'trabalhando duro';
  } else if (entryCount === 0) {
    capyEl.classList.add('sleeping');
    capyStatusEl.textContent = 'dormindo';
  } else {
    capyEl.classList.add('idle');
    capyStatusEl.textContent = 'tranquilo';
  }
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
  const { currentSession, weeklyByModel, dailyLast30, sessionRatio, estimatedWeeklyCostUsd } = snapshot;

  sessionTokensEl.textContent = `${formatTokens(currentSession.totalTokens)} / ${formatTokens(snapshot.softSessionLimitTokens)}`;
  const pct = Math.min(100, Math.round(sessionRatio * 100));
  sessionBarEl.style.width = `${pct}%`;
  sessionBarEl.className = 'bar-fill';
  if (sessionRatio >= 1) sessionBarEl.classList.add('danger');
  else if (sessionRatio >= 0.75) sessionBarEl.classList.add('warn');

  renderModelBreakdown(weeklyByModel);
  renderHeatmap(dailyLast30);
  estCostEl.textContent = `~$${estimatedWeeklyCostUsd.toFixed(2)}`;

  setCapyState(sessionRatio, currentSession.entryCount);
}

window.capyApi.onUpdate(render);
window.capyApi.requestSnapshot().then(render);

exportBtn.addEventListener('click', () => {
  window.capyApi.exportCsv();
});

closeBtn.addEventListener('click', () => {
  window.capyApi.hideWindow();
});
