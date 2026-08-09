'use strict';

// Determina o estado do personagem a partir de ha quanto tempo a ultima
// mensagem do assistente foi registrada nos logs locais.
function computeState({ lastActivityMs, now, workingMs, lightMs }) {
  const currentTime = now == null ? Date.now() : now;
  if (lastActivityMs == null) return 'idle';
  const elapsed = currentTime - lastActivityMs;
  if (elapsed <= workingMs) return 'working';
  if (elapsed <= lightMs) return 'light';
  return 'idle';
}

const TOOL_CATEGORIES = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  PowerShell: 'run',
};

// Mapeia o nome de uma tool_use (como aparece no JSONL local) pra uma
// categoria de animacao. Nomes desconhecidos caem em "other".
function categorizeTool(name) {
  if (!name) return null;
  return TOOL_CATEGORIES[name] || 'other';
}

module.exports = { computeState, categorizeTool };

if (require.main === module) {
  const workingMs = 90 * 1000;
  const lightMs = 15 * 60 * 1000;
  const now = 1_000_000_000;
  const cases = [
    { lastActivityMs: null, expected: 'idle' },
    { lastActivityMs: now, expected: 'working' },
    { lastActivityMs: now - workingMs, expected: 'working' },
    { lastActivityMs: now - workingMs - 1, expected: 'light' },
    { lastActivityMs: now - lightMs, expected: 'light' },
    { lastActivityMs: now - lightMs - 1, expected: 'idle' },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = computeState({ lastActivityMs: c.lastActivityMs, now, workingMs, lightMs });
    const ok = got === c.expected;
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} lastActivityMs=${c.lastActivityMs} -> got=${got} expected=${c.expected}`);
  }

  const toolCases = [
    { name: 'Read', expected: 'read' },
    { name: 'Grep', expected: 'read' },
    { name: 'Edit', expected: 'edit' },
    { name: 'Write', expected: 'edit' },
    { name: 'Bash', expected: 'run' },
    { name: 'PowerShell', expected: 'run' },
    { name: 'AskUserQuestion', expected: 'other' },
    { name: null, expected: null },
  ];
  for (const c of toolCases) {
    const got = categorizeTool(c.name);
    const ok = got === c.expected;
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} categorizeTool(${c.name}) -> got=${got} expected=${c.expected}`);
  }

  process.exit(failed ? 1 : 0);
}
