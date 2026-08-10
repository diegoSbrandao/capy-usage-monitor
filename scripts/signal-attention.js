'use strict';

// Chamado por hooks do Claude Code (configurados em ~/.claude/settings.json):
// - "Notification" (kind default): dispara quando o Claude Code esta
//   esperando aprovacao/permissao ou avisando algo no terminal — grava
//   attention.json com o horario. E o unico sinal confiavel disso, nao da
//   pra adivinhar so lendo os .jsonl (eles so registram o que ja aconteceu).
// - "PreToolUse"/"UserPromptSubmit" com argumento "clear": disparam assim
//   que voce aprova algo (ferramenta comeca a rodar) ou manda uma mensagem
//   nova — sinal de que voce ja voltou pro terminal. Apaga attention.json
//   na hora, em vez de esperar main.js inferir isso pela proxima mensagem
//   completa do assistente (que podia demorar bem mais que o necessario).
const fs = require('fs');
const path = require('path');
const os = require('os');

const kind = process.argv[2] || 'notification';
const dir = path.join(os.homedir(), '.capy-usage-monitor');
const attentionPath = path.join(dir, 'attention.json');

fs.mkdirSync(dir, { recursive: true });
if (kind === 'clear') {
  try {
    fs.unlinkSync(attentionPath);
  } catch {
    // ja nao existia — nada a fazer.
  }
} else {
  fs.writeFileSync(attentionPath, JSON.stringify({ kind, ts: Date.now() }));
}
