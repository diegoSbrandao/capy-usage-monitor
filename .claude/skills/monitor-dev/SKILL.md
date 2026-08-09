---
name: monitor-dev
description: Use ao trabalhar no projeto capy-usage-monitor (adicionar features, mexer no calculo de uso, mudar o mascote, ajustar config). Explica arquitetura, onde cada coisa fica e como testar sem quebrar o parser de tokens.
---

# Capy Usage Monitor — guia de manutenção

Widget Electron que le os transcripts locais do Claude Code
(`~/.claude/projects/**/*.jsonl`) e mostra consumo de tokens com um
personagem faisca (paleta de cores do Claude, forma original — nao é o
logo oficial). Sem rede, sem OAuth — de proposito (veja README.md, secao
"Por que é diferente").

## Onde fica cada coisa

- `usage.js` — toda a logica de leitura/agregação de tokens, incluindo
  `getLastActivityMs()` (timestamp da ultima mensagem assistant nas
  ultimas 24h, usado pra decidir se o personagem esta ativo). Zero
  dependencia do Electron, roda isolado com `node usage.js` (imprime um
  snapshot JSON). Sempre valide mudanças aqui rodando esse comando antes de
  integrar no app.
- `activity.js` — duas funcoes puras. `computeState({lastActivityMs, now,
  workingMs, lightMs})` decide `working | light | idle` a partir de ha
  quanto tempo veio a ultima atividade. `categorizeTool(name)` mapeia o
  nome de uma tool_use (`Read`, `Edit`, `Bash`, etc.) pra uma categoria de
  animação (`read | edit | run | other`). Ambas testaveis isolado com
  `node activity.js` (bateria de casos de borda embutida). Os estados
  `hot` (>=90%) e `alert` (>=100%, sessao estourou o limite) sao decididos
  separadamente em `main.js::buildSnapshot`, com prioridade sobre o
  resultado de `computeState`.
- `main.js` — processo principal: janela, tray, polling (`config.json ->
  pollIntervalMs`), calculo dos 4 ratios (session/daily/weekly/monthly),
  `activityState` final (`working|light|idle|hot|alert`), `toolCategory`
  (so preenchido quando `activityState === 'working'`), notificações de
  threshold, export de CSV.
- `preload.js` — unica ponte entre renderer e main (`contextBridge`). Se
  adicionar uma nova acao que o renderer precisa pedir ao main, exponha
  aqui, nao habilite `nodeIntegration`.
- `renderer/` — UI. `style.css` tem os estados do personagem (`.working`,
  `.light`, `.idle`, `.hot`, `.alert` — mesmos nomes de `activityState`),
  os `.prop` que aparecem/somem por estado (`.tool` com 3 icones
  selecionados via `[data-tool]`, `.mug`, `.bed`), e duas classes
  efemeras controladas só no renderer: `.poked` (clique no personagem) e
  `.celebrating` (janela de 5h renovou depois de quase estourar).
  `renderer.js::render()` troca `className` do `#spark` pro valor de
  `activityState`, seta `dataset.tool`, e reaplica a classe efemera ativa
  (se houver) por cima — nao ha logica de decisao de estado no renderer,
  só orquestração das transições momentâneas (poke/celebrate).
- `config.json` — unico lugar de configuração do usuário (limites diario/
  semanal/mensal/sessao, `activityThresholdsMs`, thresholds de notificação,
  preços). Nao hardcode numero de limite/preço em outro lugar.
- `scripts/generate-icon.js` — gera `assets/icon.png` (faisca de 4 pontas,
  gradiente creme->laranja) sem dependencia externa (PNG feito na mao com
  zlib). Rode de novo se mudar o desenho do icone do tray.

## Por que a forma é uma "faisca" e nao o logo do Claude

Decisao explicita do usuario: usar o simbolo oficial da Anthropic num app
de terceiros redistribuido é risco de marca, e nao ha asset oficial
licenciado disponivel aqui. A faisca de 4 pontas (`clip-path` em
`.spark-shape`) usa a paleta de cor do Claude mas é uma forma geometrica
original. Nao trocar de volta pro logo oficial sem essa decisao ser
revisitada explicitamente com o usuario.

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

`message.content` (array) tambem pode conter itens `{type: "tool_use",
name: "Read"}` etc. — é o que `getLastToolUse()` em `usage.js` varre pra
saber qual ferramenta acabou de rodar. Vem de graça no mesmo JSONL local,
nenhuma leitura extra.

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
