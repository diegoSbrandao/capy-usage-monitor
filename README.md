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
- **Hoje e Mês estimados localmente** — a API oficial não expõe essas
  janelas, então continuam calculadas a partir dos logs locais do Claude
  Code (`~/.claude/projects/**/*.jsonl`), contra um teto configurável.
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
- Estimativa de custo em USD, notificações de threshold configuráveis.

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
  "dailyLimitTokens": 8000000,
  "weeklyLimitTokens": 40000000,
  "monthlyLimitTokens": 150000000,
  "activityThresholdsMs": { "working": 90000, "coffeeAfter": 300000, "sleepAfter": 600000 },
  "pollIntervalMs": 15000,
  "notifyThresholds": [0.75, 0.9, 1.0],
  "startInTray": false,
  "pricingPerMillionTokens": { "...": "..." }
}
```

O aviso de meta diária (engrenagem no topo do widget) é salvo à parte, em
`~/.capy-usage-monitor/settings.json` — não precisa editar esse arquivo à
mão, use a UI.

## Como funciona por baixo dos panos

`usage.js` varre `~/.claude/projects/**/*.jsonl` (os transcripts que o
Claude Code já salva localmente), soma os tokens de cada entrada
`assistant` e também lê `message.content` em busca de `tool_use` (pra
saber se você está lendo, editando ou rodando algo agora). `auth.js`
implementa o login OAuth2 PKCE contra `api.anthropic.com/api/oauth/usage`
só quando você conecta a conta — sem isso, zero rede é usada.

## Licença

MIT — veja [LICENSE](LICENSE).
