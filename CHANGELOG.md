# Changelog

As mudanças visíveis do Agent Architecture Explorer, uma entrada por versão, com a data. O que ainda não foi lançado entra numa seção **Não lançado**, no topo, que vira a entrada da próxima versão.

## Não lançado

- **Edição:** fechar o editor depois de um conflito, de abri-lo num arquivo que outro programa tinha mudado ou de uma gravação recusada porque o arquivo foi apagado mostrava na aba Arquivo um texto que não estava mais no disco, até outro arquivo ser selecionado. A aba agora mostra a versão do disco que a janela leu por último, ou que o arquivo não existe mais.
- **CI:** um push ou pull request que só muda o `README.md` ou o `CHANGELOG.md` não roda mais as verificações, que levam uns 20 minutos por causa da suíte de interface.
- **README em inglês:** o README passou a ser todo em inglês, com uma seção sobre a rotina de higiene com a CLI (auditoria, gate, comparação, `freeze` e inventário). A instalação agora cita o `git` e o clone. A remoção encerra antes o servidor em segundo plano, conferindo o processo. A atualização e o aviso sobre `protected-paths.txt` também entraram. Os documentos de `docs/` continuam em português.
- **Edição:** num sistema de arquivos que reaproveita na hora o número de um inode liberado, como o ext4, um temporário da edição apagado por outro programa e recriado com o mesmo nome antes da troca passava pelo temporário da gravação. A resposta dizia que nada tinha sido salvo, e a limpeza apagava o arquivo do outro programa. A gravação agora mantém o temporário aberto até o fim: a resposta é que o resultado não pôde ser confirmado, e o arquivo do outro programa fica.

## 1.0.0 — primeira versão pública

2026-11-24

Aplicativo local que lê os agent context files de um projeto (`AGENTS.md`, `CLAUDE.md`, memória, skills, subagentes e os documentos que eles apontam) e mostra como eles se referenciam, com o arquivo, a linha e o trecho de cada referência explícita. Tem duas verticais, a inspeção e a criação, e as ferramentas em volta delas:

- **Inspeção:** árvore, busca, a Estrutura de cada pasta e o mapa de um arquivo, com as referências de entrada e de saída e a evidência de cada uma; até 12 projetos abertos juntos, com pai, filho e nível; o menor caminho entre dois arquivos (Caminho), no sentido das referências ou nos dois. A leitura é determinística, somente leitura e funciona offline.
- **Mapa de uma pasta:** os itens da pasta em colunas, com as referências somadas entre eles, o que sai da pasta e o que chega de fora.
- **Auditoria:** referências ausentes, ambíguas ou que só existem acima do diretório aberto, ausências que não dá para afirmar, manifestos inválidos ou que divergem dos links, limites de leitura e documentos sem caminho a partir das entradas; sinais estruturais (ciclos, repetições, muitas saídas) à parte. Uma observação pode ser marcada como esperada, e a declaração de escopo no `agent-architecture.json` diz o que é do runtime.
- **Alterações:** o que mudou no disco desde uma leitura de referência, por arquivo, relação e observação, com a referência salva entre reinícios.
- **Edição de documentos:** desligada por padrão e ligada por projeto, corrige no inspetor um documento Markdown existente, com conflito conferido pelo hash do disco e desfazer da última gravação.
- **Criação (Nova arquitetura):** um diretório novo, só em Markdown, com `AGENTS.md`, `CLAUDE.md` e um arquivo por primitivo ligado por links, revisado antes de gravar e sem sobrescrever nada.
- **CLI `aae`,** contrato v3 (relatórios `audit` e `schema` v2, os demais v1), em JSON e com códigos de saída estáveis: `schema`, `audit`, `compare-audit`, `freeze`, `inventory` e `protected`. Nenhum comando grava nas raízes lidas.
- **Caminhos protegidos** (`AAE_PROTECTED_PATHS` e `protected-paths.txt` no diretório de estado) barram, dentro deles, a criação, o estado do aplicativo, a edição e o snapshot de documentos da CLI.
- **Servidor local:** escuta só `127.0.0.1`, atende só programas do mesmo usuário do sistema, conferidos na tabela de sockets do kernel a cada conexão, e exige um token de sessão nas rotas de API; o lançador só reutiliza um servidor do próprio usuário. O que isso cobre e o que não cobre está no [SECURITY.md](SECURITY.md).
- **Interface** em inglês, com o pacote português no menu **More**; tema escuro por padrão e claro como opção.
- **Instalação** por usuário, só em Linux, com o Python 3.10+ do sistema; Node 22.12+ só para o build. A janela abre no Chromium em modo aplicativo (ou no navegador padrão, se ele faltar).
