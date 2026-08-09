'use strict';

// Chamado por um hook "Notification" do Claude Code (configurado em
// ~/.claude/settings.json). O Claude Code dispara esse evento quando esta
// esperando aprovacao/permissao ou avisando algo pro usuario no terminal —
// e o unico sinal confiavel disso, nao da pra adivinhar isso so lendo os
// .jsonl (eles so registram o que ja aconteceu). Esse script so grava um
// arquivo pequeno com o horario; quem le e decide o que fazer com isso e
// o main.js do Spark Monitor.
const fs = require('fs');
const path = require('path');
const os = require('os');

const kind = process.argv[2] || 'notification';
const dir = path.join(os.homedir(), '.capy-usage-monitor');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'attention.json'), JSON.stringify({ kind, ts: Date.now() }));
