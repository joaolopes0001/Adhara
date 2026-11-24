@AGENTS.md

## Claude Code

O `AGENTS.md`, importado acima, é a fonte das instruções deste repositório para qualquer agente. Aqui fica só o que é específico do Claude Code; não copie regras de lá para cá.

- **Permissões:** `.claude/settings.json` libera as verificações do projeto, bloqueia a edição de `dist/` e pede confirmação para push, remotes e o instalador. Restrições pessoais ficam no `settings.local.json` da mesma pasta, não versionado.
- **Ver o app funcionando:** a skill `run-isolated` sobe o servidor numa porta livre, com estado e HOME temporários, sem tocar na instalação pessoal.
