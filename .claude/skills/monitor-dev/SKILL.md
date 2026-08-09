---
name: monitor-dev
description: Use ao trabalhar no projeto capy-usage-monitor (adicionar features, mexer no calculo de uso, mudar o mascote, ajustar config). Explica arquitetura, onde cada coisa fica e como testar sem quebrar o parser de tokens.
---

# Spark Monitor — guia de manutenção

Widget Electron que le os transcripts locais do Claude Code
(`~/.claude/projects/**/*.jsonl`) e mostra consumo de tokens com uma
criatura pixel coral (corpo largo, 4 pernas finas, braços laterais,
olhos quadrados), num cenario escuro com nuvens pixeladas, estrelas "+" e
lua com crateras — visual **inspirado nos gifs de demonstracao do
claude-usage-monitor** (`docs/media/{overview,idle,reading,running,editing}.gif`)
e no icone open-source "Clawd" (`homarr-labs/dashboard-icons`), mas
redesenhado do zero em CSS (nenhum frame/asset copiado). Login OAuth2 é
**opcional**: sem ele, tudo funciona só com dados locais; com ele,
Sessao/Semana passam a mostrar o percentual real da conta (veja README.md).

## Onde fica cada coisa

- `usage.js` — toda a logica de leitura/agregação de tokens, incluindo
  `getLastActivityMs()` (timestamp da ultima mensagem assistant nas
  ultimas 24h, usado pra decidir se o personagem esta ativo). Zero
  dependencia do Electron, roda isolado com `node usage.js` (imprime um
  snapshot JSON). Sempre valide mudanças aqui rodando esse comando antes de
  integrar no app.
- `activity.js` — duas funcoes puras. `computeState({lastActivityMs, now,
  workingMs, coffeeAfterMs, sleepAfterMs})` decide, em ordem crescente de
  inatividade, `working -> idle (parado, sem prop) -> light (cafe) ->
  asleep (dormindo)`. `categorizeTool(name)` mapeia o nome de uma
  tool_use (`Read`, `Edit`, `Bash`, etc.) pra uma categoria de animação
  (`read | edit | run | other`). Ambas testaveis isolado com
  `node activity.js` (bateria de casos de borda embutida, incluindo os 3
  thresholds). Os estados `hot` (>=90%) e `alert` (>=100%, sessao
  estourou o limite) sao decididos separadamente em
  `main.js::buildSnapshot`, com prioridade sobre o resultado de
  `computeState`.
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
  (`working|idle|light|asleep|hot|alert`), `toolCategory`, `dailyAlert`
  (ver `settings.json` abaixo), notificações de threshold, export de
  Excel por sessao (`exportHistorySessions`, usa `exceljs`), handlers IPC
  `auth-start`/`auth-code`/`auth-logout`, `window:setCompact` (redimensiona
  e reposiciona a janela num canto — ver `FULL_SIZE`/`COMPACT_SIZE`),
  `settings:get`/`settings:save`.
- `settings.json` (em `~/.capy-usage-monitor/`, fora do repo) — unica
  preferencia editavel pelo usuario via UI (engrenagem): `dailyAlertEnabled`
  + `dailyAlertPercent` (0-100, **decisao explicita do usuario**: so
  percentual, sem campo de tokens/meta separado — ja tentamos isso e foi
  rejeitado, ver historico). `snap.dailyAlert` em `buildSnapshot()` é
  `true` quando `dailyAlertEnabled` e `ratios.daily >= dailyAlertPercent/100`,
  onde `ratios.daily = todayTokens / config.dailyLimitTokens`
  (`effectiveDailyLimit()`). **Isso significa que se o uso real do dia
  passar de `dailyLimitTokens`, QUALQUER percentual ate 100 dispara — é
  matematicamente correto, nao um bug.** `#dailyCurrentHint` no painel
  mostra "uso atual do dia: X%" pra deixar isso visivel. Se o uso normal
  do usuario for consistentemente mais pesado que o padrao de
  `dailyLimitTokens`, a correcao é subir esse valor em `config.json`
  (nao adicionar outro campo na UI — ja foi pedido pra manter simples).
- `preload.js` — unica ponte entre renderer e main (`contextBridge`). Se
  adicionar uma nova acao que o renderer precisa pedir ao main, exponha
  aqui, nao habilite `nodeIntegration`.
- `renderer/` — UI. `style.css` tem os estados do personagem (`.working`,
  `.idle`, `.light`, `.asleep`, `.hot`, `.alert` — mesmos nomes de
  `activityState`). `idle` **nao tem prop nenhum** (so o personagem
  parado). `asleep` fecha os olhos e mostra `.spark-zzz`. Em `working`,
  um `.card` contextual aparece do lado do personagem conforme
  `[data-tool]`: `.card-read`, `.card-run`, `.card-edit`. `.mug` aparece
  só em `light` (cafe) — e alterna com `.prop.tv` a cada 30s
  (`sparkEl.dataset.light = 'coffee'|'tv'`, calculado em `render()` via
  `Date.now()`) só pra dar variedade na mesma fase, nao muda a logica de
  estado. `.flag` (bandeirinha vermelha) é uma classe `.flagged`
  **independente do activityState** — soma-se a qualquer estado quando
  `snapshot.dailyAlert` é `true`, e nesse caso o texto de status é
  substituido pela mensagem de `FLAG_MESSAGE` em `renderer.js`. Duas
  classes efemeras controladas só no renderer (`.poked`, `.celebrating`).
  `#settingsPanel` (atras da engrenagem) agrupa tudo que nao precisa
  estar sempre visivel: a secao `.account` (conectar/colar codigo/
  desconectar, decisao explicita do usuario de tirar da tela principal),
  o toggle do aviso de limite diario, e o botao de export — nessa ordem.
  `.clock` +
  `#scene[data-period]` (`day`/`afternoon`/`night`, calculado em
  `periodForHour()` a partir da hora local real, atualizado a cada 15s)
  trocam o fundo/sol/lua/nuvens/estrelas. `body.compact` esconde tudo
  exceto titlebar+personagem+status+`.compact-pct` — a janela em si é
  redimensionada e reposicionada num canto pelo `main.js` (ver
  `minimizeBtn` -> `window.capyApi.setCompact`). `renderer.js::render()`
  troca `className` do `#spark`, seta `dataset.tool`, atualiza as tags
  "real"/"teto pessoal" (com `title` explicando a diferenca — ver secao
  "honestidade dos dados" abaixo), chama `updateAccountUI(snapshot.real.connected)` —
  nao ha logica de decisao de estado no renderer, só orquestração.
  `.model-list` e `.heatmap` seguem o estilo do `overview.gif` de
  referência: `renderModelBreakdown()` desenha uma barra proporcional ao
  maior valor entre os modelos (não é % de um teto, é relativo ao maior),
  e `renderHeatmap()` é uma faixa única de 30 células (`grid-template-columns:
  repeat(30, 1fr)`) com cores de calor (`data-level` 1-4, verde→amarelo→
  vermelho da paleta de status) em vez do grid quadriculado antigo. O
  scroll do `body` é funcional mas sem barra visível de propósito
  (`::-webkit-scrollbar { display: none }`) — janela pequena por decisão
  explícita do usuário, então parte do conteúdo só aparece rolando com o
  mouse. `renderer.js::tierFor(ratio)` decide a cor das 4 barras de uso
  em 6 faixas (`l1`..`l6`, verde claro → verde escuro → amarelo → amarelo
  forte → vermelho → vermelho máximo com glow) em vez de só warn/danger —
  `.compact-pct` continua com seu próprio esquema simples de 3 cores
  (0-40 verde, 41-79 amarelo, 80-100 vermelho — faixas exatas pedidas
  pelo usuário, diferentes dos cortes das barras), estilo "LED" (monospace,
  glow). **Cuidado com `.spark-footer`**: em tela cheia é
  `position: absolute; bottom: 6px` (a `.scene` tem altura fixa, entao da
  certo); no modo compacto a `.scene` vira `height: auto`, entao
  `body.compact .spark-footer` precisa forcar `position: static` — sem
  isso o rodape (numero da porcentagem) fica posicionado por cima do
  personagem em vez de abaixo, porque o absolute-positioning nao reserva
  espaço no fluxo normal que o `height:auto` possa medir.
- `config.json` — unico lugar de configuração do usuário (`*LimitTokens`
  sao tetos PESSOAIS, nunca chame de "limite da Anthropic" em nenhum
  texto de UI — a Anthropic so tem sessao de 5h e janela de 7 dias,
  nada diario/mensal/semanal fixo — `activityThresholdsMs`, thresholds
  de notificação). Nao ha mais tabela de preço aqui — foi removida (ver
  secao "honestidade dos dados" abaixo).

## Honestidade dos dados — NAO reintroduzir numero inventado

Decisao explicita do usuario apos ele conferir contra a documentacao
oficial (`support.claude.com/.../usage-limit-best-practices`): zero
numero na tela pode parecer oficial sem ser. Por isso:
- `pricingPerMillionTokens` e `estimateCostUsd()` (em `main.js`) foram
  **removidos** — era uma tabela de preco digitada a mao por mim, sem
  fonte oficial, e nao fazia sentido pra quem usa plano Pro/Max (nao
  paga por token). Nao trazer essa ideia de volta.
- No lugar, `usage.js::getSevenDayMedian()` calcula a mediana REAL de
  tokens/dia dos ultimos 7 dias a partir do historico local, e retorna
  `null` se o historico local tiver menos de 6 dias — o renderer mostra
  "coletando dados (precisa de 7 dias)" nesse caso, nunca um numero
  chutado antes da hora.
- As tags das barras de Hoje/Mes dizem "teto pessoal" (nao "estimado"),
  com `title` explicando que o numero de comparação vem de
  `config.json`, editado pelo proprio usuario — nunca da Anthropic.
  Mesma logica pra Sessao/Semana quando NAO conectado (fallback local).
- `scripts/generate-icon.js` — gera `assets/icon.png` (mesmo desenho do
  mascote, versao pixel) sem dependencia externa (PNG feito na mao com
  zlib). Rode de novo se mudar o desenho do icone do tray.

## Por que o mascote é um desenho original e nao uma imagem real

Varias decisoes explicitas do usuario, sempre a mesma logica: nao
redistribuir imagem de terceiros (foto de fã-arte, foto de banco de
imagem, gif de outro projeto, logo oficial da Anthropic) — só recriar o
*estilo* em CSS/forma geometrica original. A versao atual (`.spark-shape`,
`.spark-eye`, `.spark-glasses`, `.spark-leg`, `.cloud`, `.star`) foi
desenhada olhando pra `docs/media/*.gif` do claude-usage-monitor
(baixados e analisados com o Read tool nesta sessao) — mesma pose geral
(corpo+pernas simples, olhos de ponto, oculos redondos ao ler, nuvens
pixeladas, estrelas "+", cards contextuais por ferramenta) mas nenhum
frame foi tracado ou copiado. Nao trocar por asset/imagem real sem essa
decisao ser revisitada explicitamente com o usuario.

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
