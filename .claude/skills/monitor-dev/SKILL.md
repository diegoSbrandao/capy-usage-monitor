---
name: monitor-dev
description: Use ao trabalhar no projeto capy-usage-monitor (adicionar features, mexer no calculo de uso, mudar o mascote, ajustar config). Explica arquitetura, onde cada coisa fica e como testar sem quebrar o parser de tokens.
---

# Spark Monitor — guia de manutenção

Widget Electron que le os transcripts locais do Claude Code
(`~/.claude/projects/**/*.jsonl`) e mostra consumo de tokens com um
mascote blocado laranja com oculos pixelados (estilo meme da comunidade
Claude Code, desenho 100% original — nao traca nenhuma foto/logo), num
cenario de nebulosa tambem em CSS puro. Login OAuth2 é **opcional**: sem
ele, tudo funciona só com dados locais; com ele, Sessao/Semana passam a
mostrar o percentual real da conta (veja README.md).

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
- `auth.js` — OAuth2 PKCE contra o mesmo client publico que o Claude Code
  usa (`CLIENT_ID` fixo). `begin()` monta a URL de autorizacao,
  `complete(code)` troca por tokens, `fetchUsage()` retorna o percentual
  oficial (`session`/`week`, cada um `{pct, resetMs}`), `fetchProfile()`
  retorna email/plano. Token persistido em `~/.capy-usage-monitor/auth.json`
  (fora do repo, nunca commitar). Zero dependencia do Electron.
- `main.js` — processo principal: janela, tray, polling local
  (`config.json -> pollIntervalMs`), poll separado do OAuth (5min, com
  backoff ate 30min em 429), calculo dos 4 ratios (session/daily/weekly/
  monthly) — session/weekly viram o percentual REAL quando
  `auth.isConnected()` e ha `realUsage` em cache — `activityState` final
  (`working|light|idle|hot|alert`), `toolCategory`, notificações de
  threshold, export de Excel por sessao (`exportHistorySessions`, usa
  `exceljs`), handlers IPC `auth-start`/`auth-code`/`auth-logout`.
- `preload.js` — unica ponte entre renderer e main (`contextBridge`). Se
  adicionar uma nova acao que o renderer precisa pedir ao main, exponha
  aqui, nao habilite `nodeIntegration`.
- `renderer/` — UI. `style.css` tem os estados do personagem (`.working`,
  `.light`, `.idle`, `.hot`, `.alert` — mesmos nomes de `activityState`),
  os `.prop` que aparecem/somem por estado (`.tool` com 3 icones
  selecionados via `[data-tool]`, `.mug`, `.bed`), duas classes efemeras
  controladas só no renderer (`.poked`, `.celebrating`), e a secao
  `.account` (conectar/colar codigo/desconectar). `renderer.js::render()`
  troca `className` do `#spark`, seta `dataset.tool`, atualiza as tags
  "real"/"estimado" das barras de Sessao/Semana conforme `snapshot.real`,
  e chama `updateAccountUI(snapshot.real.connected)` — nao ha logica de
  decisao de estado no renderer, só orquestração.
- `config.json` — unico lugar de configuração do usuário (limites diario/
  semanal/mensal/sessao — usados so quando NAO conectado —
  `activityThresholdsMs`, thresholds de notificação, preços). Nao
  hardcode numero de limite/preço em outro lugar.
- `scripts/generate-icon.js` — gera `assets/icon.png` (mesmo desenho do
  mascote, versao pixel) sem dependencia externa (PNG feito na mao com
  zlib). Rode de novo se mudar o desenho do icone do tray.

## Por que o mascote é um boneco original e nao uma foto/logo

Duas decisoes explicitas do usuario, mesma logica nos dois casos: nao
redistribuir imagem de terceiros (foto de fã-arte, foto de banco de
imagem, logo oficial da Anthropic) — só recriar o *estilo* em CSS/forma
geometrica original. O boneco laranja com oculos pixelados é inspirado no
meme "You're Absolutely Right" da comunidade Claude Code, mas desenhado do
zero (`.spark-shape`, `.spark-glasses`, `.spark-arm`, `.spark-leg`). O
cenario de nebulosa (`.scene`, `.planet`) é inspirado em arte espacial
generica, tambem 100% gradientes CSS. Nao trocar por asset/imagem real
sem essa decisao ser revisitada explicitamente com o usuario.

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

- Nao remover o fallback local (funcionar sem login) — o OAuth é opcional
  de proposito, porque depende de um endpoint nao documentado pra
  terceiros que pode quebrar a qualquer momento.
- Nao commitar `~/.claude/.credentials.json`, `~/.capy-usage-monitor/auth.json`
  nem qualquer conteúdo de transcript (só os números agregados importam).
  Nenhum dos dois fica dentro da pasta do repo, mas nunca copie o conteúdo
  pra um arquivo do projeto.
- Nao trocar o mascote/cenario por uma imagem real (foto, logo oficial)
  sem decisão explícita do usuário — ver seção acima.
