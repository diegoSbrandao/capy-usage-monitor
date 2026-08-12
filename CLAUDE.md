# Fluxo de branches deste repo

A partir do commit que introduziu este arquivo, `master` fica protegida:
nada vai direto pra `master` (nem pra `develop`) sem passar por PR revisado
pelo usuario. Isso vale pra qualquer sessao do Claude Code trabalhando
neste projeto.

## Branches

- `master` — producao. So recebe merge via PR vindo de `develop`.
- `develop` — integracao. So recebe merge via PR vindo de `feature/*`.
- `feature/<nome-curto>` — uma branch por tarefa/pedido, criada a partir de
  `develop`.

## Fluxo obrigatorio pra qualquer mudanca

1. Criar `feature/<nome-curto>` a partir de `develop` (atualizada).
2. Commitar o trabalho nessa feature branch.
3. Abrir PR `feature/<nome-curto>` -> `develop` (`gh pr create`) e mandar o
   link pro usuario. Nao mergear sozinho — esperar o usuario revisar/mergear
   (ou pedir explicitamente pra mergear).
4. Depois que a PR pra `develop` for mergeada, abrir PR `develop` -> `master`
   e mandar o link pro usuario tambem. De novo, nao mergear sem autorizacao
   explicita.

Nunca commitar direto em `master` ou `develop`, e nunca dar push --force
nelas.
