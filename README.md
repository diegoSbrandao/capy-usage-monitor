# Capy Usage Monitor

Widget de desktop (Windows) que mostra o consumo de tokens do **Claude Code**
em tempo real, com uma capivara pixel/CSS original como mascote.

Inspirado em [claude-usage-monitor](https://github.com/renatoaug/claude-usage-monitor)
e [Claude-Glass](https://github.com/vitoriahellen/Claude-Glass), mas com uma
diferença de arquitetura de propósito:

## Por que é diferente

- **Mascote e visual proprios**: capivara desenhada em CSS puro (nada copiado
  dos outros dois projetos).
- **Sem OAuth / sem endpoint privado**: os dois projetos de referência também
  fazem login OAuth2 PKCE para replicar o percentual exato que aparece no
  painel oficial Settings → Usage. Isso funciona, mas depende de um endpoint
  interno não documentado da Anthropic, que pode mudar a qualquer momento.
  Este projeto usa **só os logs locais que o próprio Claude Code já grava**
  em `~/.claude/projects/**/*.jsonl` — mais simples e não quebra se a
  Anthropic mudar algo do lado do servidor. O "limite" mostrado é um teto
  configurável por você (`softSessionLimitTokens`), não o limite real do
  plano.
- **Extras que os outros não tem**:
  - Exportação de histórico em CSV (30 dias).
  - Estimativa de custo em USD por semana, com tabela de preço editável em
    `config.json`.
  - Limites e thresholds de notificação totalmente configuráveis.

## Como rodar

```bash
npm install
npm start
```

## Configuração

Edite `config.json`:

```json
{
  "softSessionLimitTokens": 3000000,
  "pollIntervalMs": 15000,
  "notifyThresholds": [0.75, 0.9, 1.0],
  "startInTray": false,
  "pricingPerMillionTokens": { "...": "..." }
}
```

## Como funciona por baixo dos panos

`usage.js` varre `~/.claude/projects/**/*.jsonl` (os transcripts que o
Claude Code já salva localmente para cada sessão), filtra as entradas do
tipo `assistant` e soma os campos `usage.input_tokens`,
`usage.output_tokens`, `usage.cache_creation_input_tokens` e
`usage.cache_read_input_tokens` de cada uma. A partir disso calcula:

- tokens da janela atual de 5 horas;
- consumo por modelo nos últimos 7 dias;
- mapa diário dos últimos 30 dias.

Nenhuma rede é usada — tudo é lido do disco local.

## Licença

MIT — veja [LICENSE](LICENSE).
