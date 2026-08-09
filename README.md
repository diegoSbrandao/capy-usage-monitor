# Spark Monitor

Widget de desktop (Windows) que mostra o consumo de tokens do **Claude
Code** em tempo real, com uma criatura pixel simples num cenário escuro
com nuvens e estrelas — visual inspirado nos gifs de demonstração do
claude-usage-monitor, mas desenhado do zero em CSS (nenhum frame/imagem
de terceiro usado).

Inspirado em [claude-usage-monitor](https://github.com/renatoaug/claude-usage-monitor)
(Clauddy) e [Claude-Glass](https://github.com/vitoriahellen/Claude-Glass).

## O que tem

- **Sessão (5h) e Semana com percentual real** — login OAuth2 opcional
  (mesmo fluxo do próprio Claude Code) que busca o percentual autoritativo
  direto da conta Anthropic, igual ao painel oficial Settings → Usage.
- **Hoje e Mês contra um teto pessoal (não oficial)** — a Anthropic não
  tem limite diário nem mensal (só sessão de 5h e janela de 7 dias, [ver
  aqui](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)),
  então essas duas barras comparam seus tokens reais (somados dos seus
  próprios logs locais) contra um número que **você** configura em
  `config.json` — a etiqueta "teto pessoal" deixa isso explícito na tela.
- **Cards contextuais por ferramenta**: um cartão de arquivo aparece
  enquanto você lê, um terminal enquanto roda comando, um "laptop" com
  linhas de código + planta enquanto edita — tudo troca sozinho conforme
  a ação detectada nos seus logs locais.
- **Estados de humor**: fica parado, toma café após uns minutos sem uso,
  dorme depois de mais tempo ocioso, esquenta perto do limite, fica em
  alerta no limite, e comemora quando a janela de 5h renova.
- **Poke**: clique no personagem por uma reação.
- **Relógio e cenário dia/tarde/noite**: hora local real no canto, com
  céu, sol e nuvens mudando de cor conforme o horário (noite tem
  estrelas e lua).
- **Aviso de meta diária (engrenagem)**: ative e defina um percentual —
  ao bater a meta, o personagem levanta uma bandeirinha vermelha e o
  status vira uma mensagem de aviso.
- **Modo compacto**: minimize pra um widget pequeno num canto da tela,
  só com o personagem, o status e o percentual da sessão.
- **Exportação em Excel por sessão** (`.xlsx` formatado, uma linha por
  sessão do Claude Code — não por dia).
- **Mediana real de tokens/dia (7d)** — calculada a partir do seu próprio
  histórico local; fica "coletando dados" até você acumular 7 dias de
  uso, nunca mostra um número chutado antes disso.
- Notificações de threshold configuráveis.

## Por que o login é opcional (e não obrigatório)

O percentual real via OAuth depende de um endpoint da Anthropic que não é
uma API pública documentada pra terceiros — funciona porque usa o mesmo
client OAuth que o próprio Claude Code usa, mas pode mudar sem aviso.
Por isso o app funciona **sem** login (com estimativas locais, sempre
disponíveis) e melhora **com** login (percentual exato de sessão/semana).

## Como rodar

```bash
npm install
npm start
```

## Conectando sua conta (opcional)

1. Clique em **Conectar conta** no topo do widget — abre o navegador.
2. Faça login normalmente e copie o código retornado.
3. Cole no campo do widget e confirme.

O token fica em `~/.capy-usage-monitor/auth.json`, só na sua máquina.
Clique em **Desconectar** a qualquer momento pra apagá-lo.

## Configuração

Edite `config.json`:

```json
{
  "softSessionLimitTokens": 3000000,
  "dailyLimitTokens": 100000000,
  "weeklyLimitTokens": 40000000,
  "monthlyLimitTokens": 150000000,
  "activityThresholdsMs": { "working": 90000, "coffeeAfter": 300000, "sleepAfter": 600000 },
  "pollIntervalMs": 15000,
  "notifyThresholds": [0.75, 0.9, 1.0],
  "startInTray": false
}
```

`softSessionLimitTokens`/`dailyLimitTokens`/`weeklyLimitTokens`/
`monthlyLimitTokens` são **tetos pessoais seus, não limites da Anthropic**
— ajuste pro seu ritmo de uso real (se sua sessão de trabalho passa
disso o dia inteiro, o número está baixo demais pra você, não é bug).

O aviso de meta diária (engrenagem no topo do widget) é salvo à parte, em
`~/.capy-usage-monitor/settings.json` — não precisa editar esse arquivo à
mão, use a UI. Esse percentual compara contra o mesmo número real de
"Sessão (5h)" que já aparece na tela.

## De onde vem cada número (sem chute)

| Na tela | Fonte | É real? |
|---|---|---|
| Sessão (5h), Semana | `api.anthropic.com/api/oauth/usage` (só se conectado) | Sim — autoritativo, igual ao site |
| Hoje, Mês (tokens) | Soma dos seus `~/.claude/projects/**/*.jsonl` | Sim — tokens reais |
| Hoje, Mês (teto) | `config.json`, editado por você | Não é da Anthropic — é seu |
| Por modelo (7 dias) | Mesma soma local, por `model` | Sim |
| Token estimado (7d) | Mediana real dos últimos 7 dias locais | Sim (só aparece após 7 dias de histórico) |
| Sessão/Semana sem login | `tokens locais / teto de config.json` | Tokens reais, teto é seu |

Não existe estimativa de custo em dólares — a Anthropic não expõe preço
por token pra quem usa plano por assinatura (Pro/Max), e uma tabela de
preço digitada à mão seria só um chute. Se você usa a API paga direto e
quer custo, calcule por fora com a tabela oficial da Anthropic.

## Como funciona por baixo dos panos

`usage.js` varre `~/.claude/projects/**/*.jsonl` (os transcripts que o
Claude Code já salva localmente), soma os tokens de cada entrada
`assistant` e também lê `message.content` em busca de `tool_use` (pra
saber se você está lendo, editando ou rodando algo agora). `auth.js`
implementa o login OAuth2 PKCE contra `api.anthropic.com/api/oauth/usage`
só quando você conecta a conta — sem isso, zero rede é usada.

## Licença

MIT — veja [LICENSE](LICENSE).
