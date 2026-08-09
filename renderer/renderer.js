'use strict';

const sparkEl = document.getElementById('spark');
const sparkStatusEl = document.getElementById('sparkStatus');
const modelBreakdownEl = document.getElementById('modelBreakdown');
const estCostEl = document.getElementById('estCost');
const heatmapEl = document.getElementById('heatmap');
const heatmapTotalEl = document.getElementById('heatmapTotal');
const exportBtn = document.getElementById('exportBtn');
const closeBtn = document.getElementById('closeBtn');

const bars = {
  session: { text: document.getElementById('sessionTokens'), fill: document.getElementById('sessionBar') },
  daily: { text: document.getElementById('dailyTokens'), fill: document.getElementById('dailyBar') },
  weekly: { text: document.getElementById('weeklyTokens'), fill: document.getElementById('weeklyBar') },
  monthly: { text: document.getElementById('monthlyTokens'), fill: document.getElementById('monthlyBar') },
};
const sessionTagEl = document.getElementById('sessionTag');
const weeklyTagEl = document.getElementById('weeklyTag');

const accountDisconnectedEl = document.getElementById('accountDisconnected');
const accountPasteRowEl = document.getElementById('accountPasteRow');
const accountConnectedEl = document.getElementById('accountConnected');
const accountLabelEl = document.getElementById('accountLabel');
const accountErrorEl = document.getElementById('accountError');
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
const dailyCurrentHint = document.getElementById('dailyCurrentHint');

const clockEl = document.getElementById('clock');
const sceneEl = document.getElementById('scene');
const compactPctEl = document.getElementById('compactPct');

let showingPasteRow = false;
let profileRequested = false;
let isCompact = false;
let lastSnapshot = null;

const FLAG_MESSAGE = 'Eita! Meta diaria batida, desacelera um pouco!';

const STATUS_LABEL = {
  working: 'trabalhando',
  idle: 'parado',
  light: 'tomando cafe',
  asleep: 'dormindo',
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

function formatDuration(ms) {
  if (ms == null || ms <= 0) return null;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}min` : `${m}min`;
}

function renderBar(bar, used, limit, ratio, realInfo) {
  if (realInfo) {
    const pct = Math.round(realInfo.pct);
    const resetTxt = formatDuration(realInfo.resetMs);
    bar.text.textContent = resetTxt ? `${pct}% (reinicia em ${resetTxt})` : `${pct}%`;
  } else {
    bar.text.textContent = `${formatTokens(used)} / ${formatTokens(limit)}`;
  }
  const pct = Math.min(100, Math.round(ratio * 100));
  bar.fill.style.width = `${pct}%`;
  bar.fill.className = 'bar-fill';
  if (ratio >= 1) bar.fill.classList.add('danger');
  else if (ratio >= 0.75) bar.fill.classList.add('warn');
}

function setTag(el, isReal) {
  if (!el) return;
  el.textContent = isReal ? 'real' : 'estimado';
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
        accountLabelEl.textContent = p && p.email
          ? `${p.email}${p.plan ? ' · ' + p.plan : ''}`
          : 'conectado';
      });
    }
  } else {
    accountConnectedEl.classList.add('hidden');
    profileRequested = false;
    accountDisconnectedEl.classList.toggle('hidden', showingPasteRow);
    accountPasteRowEl.classList.toggle('hidden', !showingPasteRow);
  }
}

function renderModelBreakdown(byModel) {
  modelBreakdownEl.innerHTML = '';
  const entries = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    modelBreakdownEl.innerHTML = '<div class="model-row-top"><span>sem dados</span></div>';
    return;
  }
  const max = Math.max(1, ...entries.map(([, tokens]) => tokens));
  for (const [model, tokens] of entries) {
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

function levelFor(tokens, max) {
  if (!max || tokens === 0) return 0;
  const ratio = tokens / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.2) return 2;
  return 1;
}

function periodForHour(h) {
  if (h >= 6 && h < 17) return 'day';
  if (h >= 17 && h < 19) return 'afternoon';
  return 'night';
}

function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  clockEl.textContent = `${hh}:${mm}`;
  sceneEl.dataset.period = periodForHour(now.getHours());
}

updateClock();
setInterval(updateClock, 15000);

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
  let total = 0;
  for (const day of days) {
    const tokens = dailyLast30[day] || 0;
    total += tokens;
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.title = `${day}: ${formatTokens(tokens)} tokens`;
    cell.dataset.level = String(levelFor(tokens, max));
    heatmapEl.appendChild(cell);
  }
  heatmapTotalEl.textContent = `${formatTokens(total)} tokens`;
}

function renderCompactPct(ratio) {
  const pct = Math.round(ratio * 100);
  compactPctEl.textContent = `${pct}%`;
  compactPctEl.className = 'compact-pct';
  if (ratio >= 1) compactPctEl.classList.add('danger');
  else if (ratio >= 0.75) compactPctEl.classList.add('warn');
}

function render(snapshot) {
  lastSnapshot = snapshot;
  const { currentSession, weeklyByModel, dailyLast30, limits, ratios, estimatedWeeklyCostUsd, activityState, toolCategory, real, dailyAlert } = snapshot;

  renderBar(bars.session, currentSession.totalTokens, limits.session, ratios.session, real.session);
  renderBar(bars.daily, snapshot.todayTokens, limits.daily, ratios.daily);
  renderBar(bars.weekly, snapshot.weeklyTokens, limits.weekly, ratios.weekly, real.week);
  renderBar(bars.monthly, snapshot.monthlyTokens, limits.monthly, ratios.monthly);
  setTag(sessionTagEl, !!real.session);
  setTag(weeklyTagEl, !!real.week);
  updateAccountUI(real.connected);

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
  sparkEl.classList.toggle('flagged', !!dailyAlert);

  sparkStatusEl.textContent = dailyAlert ? FLAG_MESSAGE : (STATUS_LABEL[activityState] || activityState);
  renderCompactPct(ratios.session);
}

window.capyApi.onUpdate(render);
window.capyApi.requestSnapshot().then(render);

sparkEl.addEventListener('click', () => addTransient('poked', 400));

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

minimizeBtn.addEventListener('click', () => {
  isCompact = !isCompact;
  document.body.classList.toggle('compact', isCompact);
  minimizeBtn.title = isCompact ? 'Restaurar' : 'Modo compacto';
  window.capyApi.setCompact(isCompact);
});

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
  if (!settingsPanel.classList.contains('hidden')) {
    window.capyApi.getSettings().then((s) => {
      dailyAlertToggle.checked = !!s.dailyAlertEnabled;
      dailyAlertPercent.value = s.dailyAlertPercent || 100;
      dailyAlertPercentRow.classList.toggle('disabled', !s.dailyAlertEnabled);
    });
    const currentPct = lastSnapshot ? Math.round(lastSnapshot.ratios.daily * 100) : null;
    dailyCurrentHint.textContent = currentPct == null
      ? 'uso atual do dia: --%'
      : `uso atual do dia: ${currentPct}% (do teto local em config.json)`;
  }
});

dailyAlertToggle.addEventListener('change', () => {
  dailyAlertPercentRow.classList.toggle('disabled', !dailyAlertToggle.checked);
});

settingsSaveBtn.addEventListener('click', () => {
  window.capyApi.saveSettings({
    dailyAlertEnabled: dailyAlertToggle.checked,
    dailyAlertPercent: Number(dailyAlertPercent.value) || 100,
  });
  settingsPanel.classList.add('hidden');
});
