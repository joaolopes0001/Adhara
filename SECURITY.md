# Segurança

## Como relatar uma vulnerabilidade

Use o relato privado do GitHub: na aba **Security** deste repositório, **Report a vulnerability**. Não abra uma issue pública para uma vulnerabilidade. Descreva o que foi possível fazer, os passos para reproduzir, a versão do aplicativo (`git describe --tags --always` no clone de onde instalou, ou o commit) e a saída de `aae --version` e o sistema; use diretórios sintéticos e não envie conteúdo de documentos privados.

Não há prazo de resposta prometido nem programa de recompensa.

## O que o aplicativo é, do ponto de vista de segurança

Um servidor local, que escuta só em `127.0.0.1` e exige um token de sessão em todas as rotas de API, menos a que entrega o token. Ele lê arquivos do usuário que o executa e grava em dois casos: cria diretórios novos, depois da revisão na interface, e, com a edição ligada num projeto, altera documentos Markdown existentes. O comportamento completo está em [SPECS, seção 7](SPECS.md#7-componentes-api-e-persistência), no parágrafo “O que a guarda fecha, e o que não”; os caminhos protegidos, na [seção 8](SPECS.md#8-cli-instalação-e-invariantes).

- **Coberto:** o servidor local só atende processos do mesmo usuário do sistema que o executa, conferidos pela tabela de sockets do kernel a cada conexão, e recusa pedidos de outros sites pelo navegador (Host, origem e token de sessão); outros usuários da máquina e páginas web não obtêm o token nem leem ou gravam arquivos por ele, e o que outro usuário manda não vai para o log. O lançador só abre a janela num servidor do próprio usuário.
- **Não coberto:** qualquer programa do mesmo usuário, inclusive um agente ou processo numa caixa de areia que alcance a interface de loopback, recebe o token e pode ler texto de arquivos que o usuário lê, criar diretórios novos e editar Markdown fora dos caminhos protegidos; programas do mesmo usuário são tratados como confiáveis. Também ficam de fora root e qualquer intermediário do usuário que outros alcancem, como o servidor de desenvolvimento do Vite, que repassa `/api` como processo do dono, ou um encaminhamento de porta. Outro usuário da máquina ainda pode atrasar o aplicativo abrindo muitas conexões, que são recusadas.

## Escopo de um relato

Está no escopo, por exemplo:

- outro usuário do sistema ou uma página web obter o token, ler arquivos ou gravar pela API, ou fazer um pedido seu ser atendido como se fosse do dono;
- o lançador abrir a janela num servidor de outro usuário;
- a inspeção gravar num diretório aberto, ou a criação sobrescrever um diretório existente;
- a edição gravar sem a permissão do projeto, fora dos documentos editáveis ou dentro de um caminho protegido, fora dos limites declarados na especificação;
- o log do servidor registrar corpo, query, cabeçalhos ou o conteúdo de um documento, ou qualquer parte do pedido de outro usuário.

Não está no escopo:

- o que exige um programa do mesmo usuário, root ou um intermediário como o servidor de desenvolvimento do Vite (ver acima);
- lentidão ou indisponibilidade causada por outro usuário da máquina com muitas conexões;
- os limites declarados em SPECS: “Limites declarados da edição” (seção 7) e os limites conhecidos dos caminhos protegidos (seção 8);
- instruções encontradas nos arquivos inspecionados: o aplicativo não as executa.

## Versões suportadas

Só a versão mais recente do ramo principal recebe correções.
