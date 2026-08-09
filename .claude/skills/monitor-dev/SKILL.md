---
name: monitor-dev
description: Use ao trabalhar no projeto capy-usage-monitor (adicionar features, mexer no calculo de uso, mudar o mascote, ajustar config). Explica arquitetura, onde cada coisa fica e como testar sem quebrar o parser de tokens.
---

# Spark Monitor — guia de manutenção

Widget Electron que le os transcripts locais do Claude Code
(`~/.claude/projects/**/*.jsonl`) e mostra consumo de tokens com uma
criatura pixel coral (cabeça arredondada em grade de pixels, olhos
losango, boca, 4 pernas em duas cores), num cenario escuro com nuvens
pixeladas, estrelas e lua com crateras — visual atual **redesenhado a
partir de um mockup HTML feito pelo proprio usuario no claude.ai**
(paleta `oklch`, tipografia mono pra numeros, cards com badge
"real"/"teto pessoal"), substituindo o desenho anterior (inspirado nos
gifs do claude-usage-monitor e no icone "Clawd"). Tudo em CSS puro,
nenhum frame/asset de terceiro copiado. Login OAuth2 é **opcional**: sem
ele, tudo funciona só com dados locais; com ele, Sessao/Semana passam a
mostrar o percentual real da conta (veja README.md).

**Se o usuario mandar um export "Standalone HTML" de um artifact do
claude.ai como referencia de novo**: esse formato guarda o HTML/CSS real
como string JSON-escapada dentro de uma linha `<script type="__bundler/
template">` (tipicamente uma das ultimas linhas do arquivo, a mais longa
depois do bundle JS comprimido) — nao dá pra ler direto, precisa de um
script Node que leia a linha certa e faça `JSON.parse()` nela pra
extrair o HTML de verdade.

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
- `scripts/signal-attention.js` + hook `Notification` do Claude Code —
  decisao explicita do usuario: os `.jsonl` locais so registram o que ja
  aconteceu, entao nao da pra saber "esperando aprovacao AGORA" so lendo
  eles. A solucao e um hook `Notification` (configurado no
  `~/.claude/settings.json` **global** do usuario, fora deste repo — ver
  `hooks.Notification` la) que roda esse script toda vez que o Claude Code
  precisa de atencao/permissao, gravando `~/.capy-usage-monitor/attention.json`
  (`{kind, ts}`). `main.js::isAttentionActive(lastActivityMs)` le esse
  arquivo e decide se ainda vale: fica ativo por ate 5 minutos
  (`ATTENTION_MAX_AGE_MS`) OU ate aparecer uma mensagem assistant nova
  depois do `ts` do sinal (`lastActivityMs > signal.ts` = usuario ja
  respondeu, Claude Code seguiu — sinal resolvido). **Cuidado ao testar
  isso dentro de uma sessao do proprio Claude Code**: `lastActivityMs`
  vem dos mesmos `.jsonl` que essa conversa atual gera, entao qualquer
  sinal escrito manualmente ja nasce "resolvido" por causa da atividade
  da propria sessao de teste — pra validar a logica isolada, chame
  `isAttentionActive` com um `lastActivityMs` mockado, ou force
  `snap.attention = true` temporariamente em `buildSnapshot` so pra
  conferir o CSS, sem esquecer de reverter.
- `main.js` — processo principal: janela, tray, polling local
  (`config.json -> pollIntervalMs`), poll separado do OAuth (5min, com
  backoff ate 30min em 429), calculo dos 4 ratios (session/daily/weekly/
  monthly) — session/weekly viram o percentual REAL quando
  `auth.isConnected()` e ha `realUsage` em cache — `activityState` final
  (`working|idle|light|asleep|hot|alert`), `toolCategory`, `dailyAlert`
  (ver `settings.json` abaixo), `attention` (ver bullet do
  `scripts/signal-attention.js` acima), notificações de threshold, export de
  Excel por sessao (`exportHistorySessions`, usa `exceljs`), handlers IPC
  `auth-start`/`auth-code`/`auth-logout`, `window:setCompact` (redimensiona
  e reposiciona a janela num canto — ver `FULL_SIZE`/`COMPACT_SIZE`),
  `settings:get`/`settings:save`, `autostart:get`/`autostart:set`
  (`getAutoStart()`/`setAutoStart()` — toggle "Abrir com o Windows" no
  settings, usa `app.setLoginItemSettings()` direto, **nao** guarda esse
  estado em `settings.json` porque a fonte de verdade e o proprio SO
  (registro do Windows) e duplicar criaria risco de desincronizar; em dev
  precisa passar `path: process.execPath, args: [...]` explicitamente
  porque `process.execPath` em `electron .` aponta pro binario generico
  do Electron, nao pro projeto — sem isso o atalho de inicializacao abriria
  o Electron vazio).
- `settings.json` (em `~/.capy-usage-monitor/`, fora do repo) — unica
  preferencia editavel pelo usuario via UI (engrenagem): `dailyAlertEnabled`
  + `dailyAlertPercent` (0-100, **decisao explicita do usuario**: so
  percentual, sem campo de tokens/meta separado — ja tentamos isso e foi
  rejeitado, ver historico). `snap.dailyAlert` em `buildSnapshot()` é
  `true` quando `dailyAlertEnabled` e `ratios.session >= dailyAlertPercent/100`
  — **compara contra `ratios.session` (a mesma % real de "Sessao (5h)"
  que ja aparece na tela), NAO contra `ratios.daily`** (esse ultimo pode
  passar de 1000% numa sessao de trabalho longa, ja que "Hoje" nao tem
  teto oficial — usar ele como base do alerta foi tentado antes, gerou
  confusao repetida, foi corrigido; nao reverta essa comparacao pra
  `ratios.daily`). O painel de settings **nao mostra mais** o "uso atual
  do dia: X%" que existia antes (`#dailyCurrentHint`, removido a pedido
  do usuario por mostrar numeros como "1098%" sem contexto e ser
  redundante com o card "Hoje" na tela principal) — nao reintroduza esse
  hint.
- `preload.js` — unica ponte entre renderer e main (`contextBridge`). Se
  adicionar uma nova acao que o renderer precisa pedir ao main, exponha
  aqui, nao habilite `nodeIntegration`.
- `renderer/` — UI. O personagem (`#spark > .mascot-grid`) é uma grade
  CSS Grid de 11x10 (`.mp` de 6x6px cada, posicionado por
  `grid-row`/`grid-column` inline no HTML) com classes `.mp-body`
  (cor principal), `.mp-eye` (pisca sozinho via `mpBlink`), `.mp-mouth`
  (só "fala"/`mpTalk` quando `activityState === working`), `.mp-leg-a`/
  `.mp-leg-b` (só balançam/`mpLegA`/`mpLegB` quando working). Os estados
  (`.working`, `.idle`, `.light`, `.asleep`, `.hot`, `.alert` — mesmos
  nomes de `activityState`) ficam na classe do `#spark` (container) e
  tocam animação de corpo inteiro (bob/sway/breathe/shake) — a grade de
  pixels em si não muda de layout entre estados, só cor (`.hot`/`.alert`
  recolorem `.mp-body`) e as sub-animações de boca/pernas. `idle` **nao
  tem prop nenhum** (so o personagem parado). `asleep` "fecha" os olhos
  (`.mp-eye{transform:scaleY(0.2)}`) e mostra `.spark-zzz`. Em `working`,
  um `.card` contextual aparece do lado do personagem conforme
  `[data-tool]`: `.card-read`, `.card-run`, `.card-edit`. Ao ler
  (`[data-tool="read"]`), `.spark-glasses` cobre os `.mp-eye` — se mexer
  na grade do mascote, reajuste a posição/tamanho de `.spark-glasses`
  junto (ela é posicionada em px absolutos, não segue a grade
  automaticamente). `.mug` aparece só em `light` (cafe) — e alterna com
  `.prop.tv` a cada 30s (`sparkEl.dataset.light = 'coffee'|'tv'`,
  calculado em `render()` via `Date.now()`) só pra dar variedade na mesma
  fase, nao muda a logica de estado. `.flag` (bandeirinha vermelha) é uma
  classe `.flagged` **independente do activityState** — soma-se a
  qualquer estado quando `snapshot.dailyAlert` é `true`, e nesse caso o
  texto de status é substituido pela mensagem de `FLAG_MESSAGE` em
  `renderer.js`. `.attention-badge` (badge amarelo ">_") funciona igual,
  ligado por `.attention` quando `snapshot.attention` é `true` — **tem
  prioridade sobre `.flagged`** na hora de decidir o texto/cor do status
  (`ATTENTION_MESSAGE` vence `FLAG_MESSAGE`), porque "precisa de voce
  agora no terminal" é mais urgente que o aviso de meta diaria. Duas
  classes efemeras controladas só no renderer (`.poked`, `.celebrating`
  — essa ultima com um burst de 12 particulas coloridas + pulso de brilho
  no `.mascot-grid`, ver `@keyframes celebratePulse`).
  `#settingsPanel` (atras da engrenagem) agrupa tudo que nao precisa
  estar sempre visivel, em blocos `.settings-card` separados (conta,
  toggle do aviso, percentual+dica), seguido de `.btn-primary` (Salvar) e
  `.btn-outline` (export) — cada bloco é um cartão proprio, sem
  `.settings-divider` (removido, os cards já se separam visualmente).
  `.clock-chip` + `#scene[data-period]` (`night`/`morning`/`day`/
  `evening`, calculado em `periodForHour()` a partir da hora local real,
  atualizado a cada 15s) trocam o fundo/sol/lua/nuvens/estrelas — 4
  faixas (não 3) pra bater com o mockup de referência. `body.compact`
  esconde tudo exceto titlebar+personagem+status+`.compact-pct-row` — a
  janela em si é redimensionada e reposicionada num canto pelo `main.js`
  (ver `minimizeBtn` -> `window.capyApi.setCompact`). O modo compacto tem
  visual proprio (referencia: imagem `minimizada.png` fornecida pelo
  usuario) diferente da janela cheia: **titlebar continua com o
  `.brand-icon` visivel** (so o texto "Spark Monitor" some, via
  `body.compact .titlebar-brand span:last-child`), gear/minus/close ficam
  com o MESMO estilo da janela cheia (nao tem botao especial); o mascote
  ganha um brilho radial colorido atras (`.spark::before`, cor via
  variavel CSS `--glow-color` setada em `renderCompactPct()`); embaixo,
  `.compact-pct-row` mostra um pontinho colorido (`.compact-dot`) e a
  porcentagem (`.compact-pct`, texto limpo, sem o glow neon pesado que
  tinha antes) lado a lado — nao mais um numero gigante sozinho. As 3
  faixas de cor (verde 0-40/amarelo 41-79/vermelho 80-100) sao
  compartilhadas entre dot/texto/glow, todas setadas juntas em
  `renderCompactPct()`. **Cuidado com
  especificidade CSS aqui**: `body.compact .moon { display:none }` tem
  menos classes (2) que `.scene[data-period="night"] .moon { display:
  block }` (3, o atributo conta como classe) — sem `!important` nas
  regras de `body.compact`, a regra do período noturno ganha mesmo vindo
  antes no arquivo, porque especificidade é comparada antes de ordem de
  origem. Por isso `body.compact .clock-chip/.sun/.moon/.cloud/.star`
  usam `!important`.
  `renderer.js::render()` troca `className` do `#spark`, seta
  `dataset.tool`, atualiza os badges "real"/"teto pessoal" via
  `setBadge()` (com `title` explicando a diferenca — ver secao
  "honestidade dos dados" abaixo), atualiza a cor de `#statusDot` via
  `STATUS_DOT_COLOR[activityState]`, chama
  `updateAccountUI(snapshot.real.connected)` — nao ha logica de decisao
  de estado no renderer, só orquestração. Cada card de métrica visível
  (Sessão/Hoje/Semana — **"Mês" foi removido da UI por pedido explícito
  do usuário**, ver bullet abaixo) tem 4 elementos próprios (`*Badge`/
  `*Subtext`/`*Bar`/`*Value`). Sessão e Semana usam `renderMetric()`:
  `subtext` é "reinicia em Xh" quando há dado real, ou "N% do teto"
  quando não; `value` é a porcentagem real ou "usado / teto" em tokens —
  nunca os dois juntos no mesmo texto. **Hoje usa `renderSpentOnly()`,
  não `renderMetric()`** — decisão explícita do usuário de não mostrar
  nenhum percentual/comparação (não existe teto diário oficial da
  Anthropic, então nem "% do teto" nem "usado / limite" viram texto):
  `subtext` fica vazio e `value` é só `${tokens} tokens` gastos na
  janela. A barra continua colorida pela cor de marca via `.bar-fill.accent`
  (nao mais tier verde->vermelho, ver bullet de honestidade dos dados) e
  a largura usa o teto pessoal de `config.json` (só sinal visual, nunca
  em texto). "Hoje" é uma janela real de 24h corridas
  (`usage.js::getLast24hTokens()`, não dia de calendário). **"Mês"
  (`usage.js::getCurrentMonthTokens()`, `snap.monthlyTokens`,
  `ratios.monthly`) continua calculado no snapshot mas não aparece mais
  em lugar nenhum da UI** — o usuário pediu pra tirar o card inteiro
  (`metric-card` de "Mes" em `index.html`, entrada `monthly` no objeto
  `metrics` e a chamada `renderSpentOnly` em `renderer.js`); nao remova o
  calculo do backend sem confirmar, so a UI foi removida. `.model-list`
  e `.heatmap`
  seguem o estilo do `overview.gif` de referência e do mockup do usuário:
  `renderModelBreakdown()` desenha uma barra proporcional ao maior valor
  entre os modelos (não é % de um teto, é relativo ao maior), e
  `renderHeatmap()` desenha um gráfico de barras verticais (30 barras,
  `display:flex;align-items:flex-end`) com altura proporcional ao dia
  mais cheio da janela e cor de calor
  (`data-level` 1-4, verde→amarelo→vermelho da paleta de status) — a
  primeira versão do redesign manteve o grid de células (todas do mesmo
  tamanho, só cor variava) por decisão explícita do usuário; ele depois
  pediu pra trocar por barras de altura variável igual ao mockup, então
  a versão atual combina os dois: altura do mockup + cores de calor do
  design anterior. O scroll do `body` é funcional mas
  sem barra visível de propósito (`::-webkit-scrollbar { display: none
  }`) — janela pequena por decisão explícita do usuário, então parte do
  conteúdo só aparece rolando com o mouse. `renderer.js::tierFor(ratio)`
  decide a cor das 4 barras de uso em 6 faixas (`l1`..`l6`, verde claro →
  verde escuro → amarelo → amarelo forte → vermelho → vermelho máximo com
  glow) em vez de só warn/danger — `.compact-pct` continua com seu
  próprio esquema simples de 3 cores (0-40 verde, 41-79 amarelo, 80-100
  vermelho — faixas exatas pedidas pelo usuário, diferentes dos cortes
  das barras), estilo "LED" (monospace, glow). `#spark` e `.spark-footer`
  (mascote + status/`.compact-pct`) são filhos normais de `.scene` num
  flex column (`justify-content:center;gap:8px`) — **nao volte a usar
  `position:absolute` no `.spark-footer`**: já foi feito assim antes e
  causava a mensagem de status ficando em cima do mascote (o texto e o
  personagem disputavam o mesmo espaço reservado por `align-items:flex-end`
  no eixo antigo); com os dois no fluxo normal e `gap`, nao tem como
  sobrepor, e o modo compacto tambem nao precisa de override nenhum
  porque o `height:auto` mede o conteudo real do flex column sozinho.
- `config.json` (na raiz do repo) — **so o template default**, empacotado
  junto com o app. `main.js::loadConfig()` copia esse template pra
  `~/.capy-usage-monitor/config.json` na primeira execução (se ainda nao
  existir la) e le/edita sempre a partir dessa copia — necessario porque
  depois de empacotado (`electron-builder`) a pasta de instalação nao e
  gravavel, so `DATA_DIR` (home do usuário) e. **Nunca volte a ler
  `config.json` direto de `__dirname` sem essa copia primeiro** — quebra
  em qualquer maquina que nao seja a de desenvolvimento. `*LimitTokens`
  sao tetos PESSOAIS, nunca chame de "limite da Anthropic" em nenhum
  texto de UI — a Anthropic so tem sessao de 5h e janela de 7 dias, nada
  diario/mensal/semanal fixo — `activityThresholdsMs`, thresholds de
  notificação. Nao ha mais tabela de preço aqui — foi removida (ver secao
  "honestidade dos dados" abaixo).

## Empacotamento e distribuicao (electron-builder)

`npm run dist` gera um instalador NSIS Windows (`dist/Spark Monitor Setup
<versao>.exe`) via `electron-builder` (config no campo `build` de
`package.json`). Pontos importantes:
- `assets/icon.ico` (16/32/48/256px, PNG-in-ICO moderno) e
  `assets/icon.png` (32x32, bandeja) sao gerados por
  `scripts/generate-icon.js` a partir do MESMO desenho pixel-art do
  mascote (`ROWS`/`COLOR` no script espelham `index.html`/`style.css` —
  se mudar o mascote, atualize os dois lugares e rode `npm run icons`
  de novo antes de gerar um instalador novo).
- `System.Drawing.Icon` do .NET (usado so em teste manual via
  PowerShell) as vezes nao renderiza a entrada de 256px de um ICO
  PNG-in-ICO (limitacao antiga do GDI+) — isso NAO significa que o
  arquivo esta corrompido; valide inspecionando os bytes (assinatura PNG
  no offset de cada entrada do diretorio ICO) em vez de confiar nessa
  API pra validar.
- `dist/` fica de fora do git (`.gitignore`) — e so o build local, ~100MB
  (inclui o Chromium/Electron embutido), nunca commitar.
- `config.json` do usuario final vem de `~/.capy-usage-monitor/config.json`
  (ver bullet acima) — **nao** do arquivo dentro da instalacao, que fica
  read-only dentro do `app.asar`.
- Ainda nao ha auto-update nem assinatura de codigo configurados —
  distribuicao e manual (compartilhar o `.exe` do instalador). Se pedir
  auto-update, a rota natural e `electron-updater` + GitHub Releases.

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
  `null` se o historico local tiver menos de 6 dias. **Decisao explicita
  do usuario: nesse caso o card inteiro (`#estCostSection`) fica com a
  classe `.hidden` e some da tela** — antes mostrava um texto "coletando
  dados (precisa de 7 dias)", mas o usuario preferiu nao ver o card
  nenhum antes de ter o dado de verdade, entao nao reintroduza esse texto
  de placeholder.
- A tag da barra de Hoje diz "teto pessoal" (nao "estimado"), com `title`
  explicando que o numero de comparação vem de `config.json`, editado
  pelo proprio usuario — nunca da Anthropic. A cor da barra em si
  (`.bar-fill.accent`) e a cor de marca (laranja, mesma do
  `.brand-icon`/mascote), nao o gradiente verde->vermelho de urgencia
  (`tierFor()`) usado em Sessao/Semana — decisao do usuario, porque Hoje
  nao e mais indicador de "quao perto de um limite", entao a cor de
  alerta nao fazia sentido ali.
  Mesma logica pra Sessao/Semana quando NAO conectado (fallback local).
- `scripts/generate-icon.js` — gera `assets/icon.png` (mesmo desenho do
  mascote, versao pixel) sem dependencia externa (PNG feito na mao com
  zlib). Rode de novo se mudar o desenho do icone do tray.

## Por que o mascote é um desenho original e nao uma imagem real

Varias decisoes explicitas do usuario, sempre a mesma logica: nao
redistribuir imagem de terceiros (foto de fã-arte, foto de banco de
imagem, gif de outro projeto, logo oficial da Anthropic) — só recriar o
*estilo* em CSS/forma geometrica original. A versao atual (`.mascot-grid`,
`.mp-body`, `.mp-eye`, `.mp-mouth`, `.mp-leg-a/b`, `.spark-glasses`,
`.cloud`, `.star`) foi redesenhada a partir de um mockup HTML que o
proprio usuario montou no claude.ai (export "Standalone HTML" de um
artifact, extraido com um script Node — ver nota no topo deste arquivo)
— cores/paleta/tipografia seguem esse mockup de perto, mas a arte de
pixel do personagem é geometria original (grade 11x10 declarada em
`index.html`, gerada uma vez por um script descartável, não copiada de
nenhuma imagem). O design anterior (corpo largo + braços + pernas
avulsas) foi inspirado em `docs/media/*.gif` do claude-usage-monitor e no
icone "Clawd" — ambos também recriados do zero, nunca traçados. Nao
trocar por asset/imagem real sem essa decisao ser revisitada
explicitamente com o usuario.

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
- Nao embutir um `.gif`/imagem real de terceiro pros efeitos de "precisa
  de atenção" ou "sessão terminou" — decisão explícita do usuário (mesma
  lógica do mascote): tudo animado em CSS puro (`.attention-badge`,
  `.spark-burst`/`celebratePulse`), nada baixado da internet.
- Nao adicionar hooks no `~/.claude/settings.json` **global** do usuário
  sem confirmar antes — é configuração fora deste repo, vale pra todos os
  projetos dele, e já existe um hook (`UserPromptSubmit`, modo caveman)
  que precisa ser preservado ao editar esse arquivo (merge, nunca
  sobrescrever `hooks`).
