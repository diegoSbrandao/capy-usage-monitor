---
name: monitor-dev
description: Use ao trabalhar no projeto capy-usage-monitor (adicionar features, mexer no calculo de uso, mudar o mascote, ajustar config). Explica arquitetura, onde cada coisa fica e como testar sem quebrar o parser de tokens.
---

# Capy Usage Monitor — guia de manutenção

Widget Electron que le os transcripts locais do Claude Code
(`~/.claude/projects/**/*.jsonl`) e mostra consumo de tokens com uma
capivara mascote. Sem rede, sem OAuth — de proposito (veja README.md, secao
"Por que é diferente").

## Onde fica cada coisa

- `usage.js` — toda a logica de leitura/agregação de tokens. Zero
  dependencia do Electron, roda isolado com `node usage.js` (imprime um
  snapshot JSON). Sempre valide mudanças aqui rodando esse comando antes de
  integrar no app.
- `main.js` — processo principal: janela, tray, polling (`config.json ->
  pollIntervalMs`), notificações de threshold, export de CSV.
- `preload.js` — unica ponte entre renderer e main (`contextBridge`). Se
  adicionar uma nova acao que o renderer precisa pedir ao main, exponha
  aqui, nao habilite `nodeIntegration`.
- `renderer/` — UI. `style.css` tem os estados do capy (`.idle`,
  `.working`, `.sleeping`, `.alert`) controlados via `className` em
  `renderer.js::setCapyState`.
- `config.json` — unico lugar de configuração do usuário (limites,
  thresholds, preços). Nao hardcode numero de limite/preço em outro lugar.
- `scripts/generate-icon.js` — gera `assets/icon.png` sem dependencia
  externa (PNG feito na mao com zlib). Rode de novo se mudar o desenho do
  icone do tray.

## Formato dos dados de origem (JSONL do Claude Code)

Cada linha de `~/.claude/projects/<projeto>/<sessao>.jsonl` é um evento.
Só interessam linhas com `"type":"assistant"`, que tem:

```json
{
  "type": "assistant",
  "timestamp": "2026-08-09T01:03:37.676Z",
  "message": {
    "model": "claude-sonnet-5",
    "usage": {
      "input_tokens": 3,
      "output_tokens": 775,
      "cache_creation_input_tokens": 6255,
      "cache_read_input_tokens": 15348
    }
  }
}
```

`tokensForEntry()` em `usage.js` soma os quatro campos de token. Se a
Anthropic mudar esse schema (novo campo relevante, nome diferente), é so
esse ponto que precisa mudar.

## Adicionando uma feature nova

1. Se envolve novo dado agregado (ex: custo por dia em vez de por semana),
   adicione a função em `usage.js` primeiro e teste com
   `node usage.js` isolado.
2. Exponha no snapshot (`buildSnapshot()` em `main.js`) se o renderer
   precisa saber.
3. Renderer le tudo via `window.capyApi.onUpdate(render)` — adicione o
   campo em `render()` de `renderer.js` e o elemento correspondente em
   `index.html`/`style.css`.
4. Nunca acesse `fs`/`node` direto do renderer — sempre via IPC
   (`preload.js`).

## Testar

```bash
npm install   # so na primeira vez / apos mudar package.json
npm start
```

A janela deve abrir mostrando números reais da sua máquina (mesmos que
`node usage.js` imprime). Se `currentSession.totalTokens` ficar sempre 0,
confira se `~/.claude/projects/` existe e tem `.jsonl` recentes.

## Do NOT

- Nao reintroduzir OAuth/login contra endpoint privado da Anthropic sem
  decisão explícita — é o diferencial de robustez deste projeto frente ao
  claude-usage-monitor e ao Claude-Glass.
- Nao commitar `~/.claude/.credentials.json` nem qualquer conteúdo de
  transcript (só os números agregados importam).
