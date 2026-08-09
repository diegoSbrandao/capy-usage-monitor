'use strict';

// OAuth do Claude (mesmo fluxo do Claude Code) + o endpoint oficial de uso.
// Portado do claude-usage-monitor (renatoaug/Clauddy) a pedido explicito do
// usuario: mesmo CLIENT_ID publico que o proprio Claude Code usa, mesmos
// endpoints. Ver .claude/skills/monitor-dev/SKILL.md pra contexto da decisao.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT = 'https://platform.claude.com/oauth/code/callback';
const AUTHORIZE = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const SCOPE = 'org:create_api_key user:profile user:inference';
const UA = 'capy-usage-monitor/0.1.0 (external, electron)';

const DATA_DIR = path.join(os.homedir(), '.capy-usage-monitor');
const TOKEN_PATH = path.join(DATA_DIR, 'auth.json');

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let tokens = null; // { access_token, refresh_token, expires_at }
let pending = null; // { verifier, state }
let profile = null; // { email, name, plan }

function load() {
  if (tokens) return tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    tokens = null;
  }
  return tokens;
}

function save(t) {
  tokens = t;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2), { mode: 0o600 });
  } catch {
    // best-effort: se nao conseguir persistir, o token so vive na memoria desta sessao.
  }
}

function clear() {
  tokens = null;
  profile = null;
  try {
    fs.unlinkSync(TOKEN_PATH);
  } catch {
    // ja nao existia, tudo bem.
  }
}

function isConnected() {
  return !!load();
}

// Passo 1: monta a URL de autorizacao (abre no navegador do usuario).
function begin() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(32));
  pending = { verifier, state };
  const params = {
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  };
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${AUTHORIZE}?${query}`;
}

// Passo 2: troca o "code#state" colado pelo usuario por tokens.
async function complete(pasted) {
  const raw = String(pasted).trim();
  if (!raw.includes('#')) {
    // Token de vida longa colado direto (ex: `claude setup-token`).
    save({ access_token: raw, refresh_token: null, expires_at: Date.now() + 365 * 864e5 });
    pending = null;
    return;
  }
  if (!pending) throw new Error('nenhuma autenticacao pendente');
  const [code, returnedState] = raw.split('#');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state: returnedState || pending.state,
      code_verifier: pending.verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`troca falhou ${res.status}: ${body.slice(0, 150)}`);
  }
  const j = await res.json();
  save({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
  });
  pending = null;
}

async function refresh() {
  const t = load();
  if (!t || !t.refresh_token) throw Object.assign(new Error('sem refresh token'), { status: 401 });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const dead = res.status === 400 || res.status === 403;
    throw Object.assign(new Error('refresh falhou'), { status: dead ? 401 : res.status });
  }
  const j = await res.json();
  save({
    access_token: j.access_token,
    refresh_token: j.refresh_token || t.refresh_token,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
  });
}

async function validToken() {
  const t = load();
  if (!t) throw Object.assign(new Error('nao conectado'), { status: 401 });
  if (!t.expires_at || t.expires_at - Date.now() < 60000) await refresh();
  return load().access_token;
}

function win(o) {
  return o && typeof o.utilization === 'number'
    ? { pct: o.utilization, resetMs: o.resets_at ? Date.parse(o.resets_at) - Date.now() : null }
    : null;
}

// Passo 3: percentual oficial de uso (o mesmo do painel Settings -> Usage).
async function fetchUsage() {
  const token = await validToken();
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'User-Agent': UA,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`usage ${res.status}: ${body.slice(0, 150)}`), { status: res.status });
  }
  const j = await res.json();
  return {
    session: win(j.five_hour) || { pct: 0, resetMs: null },
    week: win(j.seven_day) || { pct: 0, resetMs: null },
    sonnet: win(j.seven_day_sonnet),
    opus: win(j.seven_day_opus),
  };
}

async function fetchProfile() {
  if (profile) return profile;
  const token = await validToken();
  const res = await fetch(PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'User-Agent': UA,
    },
  });
  if (!res.ok) throw Object.assign(new Error(`profile ${res.status}`), { status: res.status });
  const a = (await res.json()).account || {};
  profile = {
    email: a.email || null,
    name: a.display_name || a.full_name || null,
    plan: a.has_claude_max ? 'Max' : a.has_claude_pro ? 'Pro' : null,
  };
  return profile;
}

module.exports = { begin, complete, fetchUsage, fetchProfile, clear, isConnected };
