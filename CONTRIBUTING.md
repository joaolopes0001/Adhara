# Contribuir

Este guia é a fonte única de desenvolvimento, testes e política de evidências do Agent Architecture Explorer. Requisitos e contratos ficam em [SPECS.md](SPECS.md); regras do leitor em [docs/modelo-e-leitura.md](docs/modelo-e-leitura.md); decisões em [docs/architecture.md](docs/architecture.md). O projeto é distribuído sob a licença MIT ([LICENSE](LICENSE)).

## Ambiente

Linux, Python 3.10+ e Node 22.12+ (só para build e testes). Chromium para a janela do aplicativo (o launcher tenta o navegador padrão se faltar) e para os testes de interface. O backend usa apenas a biblioteca padrão do Python; a UI usa React, TypeScript e React Flow empacotados localmente. Na raiz do projeto:

```sh
npm ci                 # instala/sincroniza dependências (só quando necessário)
npm run format         # prettier --write (src, tests/ui e configs; não formata *.md)
npm run format:check   # o que a CI roda antes do build
npm run build          # build de produção; verifica TypeScript
npm test               # unittest do Python
npm run test:ui        # Playwright; exige build prévio (npm run build), pois o backend de teste serve dist/
npm run test:audit     # build + Python + interface, sem o cenário opcional
```

Os testes Python cobrem scanner, evidências, caminhos, limites, persistência, criação exclusiva, API e CLI; os de interface (Playwright) cobrem fluxos com arquivos temporários, canvas, navegação, temas e projetos salvos. `npm test` inclui um servidor HTTP temporário: em ambientes com sandbox, sockets locais podem exigir permissão. Não remova verificações para contornar essa restrição.

## Desenvolver

Duas sessões, com estado temporário:

```sh
AAE_DEV=1 python3 server/main.py --port 47831 --state-dir /tmp/aae-dev-state
npm run dev
```

`AAE_DEV=1` faz o backend aceitar também o Host do servidor de desenvolvimento do Vite (`127.0.0.1:5173` e `localhost:5173`); sem ele, esses pedidos são recusados. O backend recusa programas de outros usuários do sistema, mas o Vite repassa `/api` como processo seu: enquanto ele estiver no ar, outro usuário da máquina alcança a API por ele. Desenvolva com estado e pastas sintéticos.

O proxy de desenvolvimento em `vite.config.ts` aponta para a porta 47831, padrão também da instalação. Se ela estiver ocupada, use outra porta livre no backend e ajuste o proxy localmente; não encerre um processo desconhecido e não versione a troca incidental de porta.

## Testes de interface

- O Playwright sobe um backend separado na porta **47839**, com estado temporário; a porta precisa estar livre. `AAE_UI_PORT` troca a porta, para rodar a suíte em dois checkouts ao mesmo tempo. Não use uma instalação pessoal como fixture.
- A suíte inteira leva cerca de 12 minutos numa máquina de mesa, com um teste por vez. Rode-a em segundo plano, com a saída gravada em arquivo (`npm run test:ui > saida.log 2>&1`): uma rodada interrompida pode deixar o backend de teste ocupando a porta.
- Na CI (variável `CI` definida), um teste que falha roda de novo até duas vezes; na sua máquina, uma falha continua sendo uma falha. Um teste que depende da velocidade da máquina para montar o cenário repete a sequência e, se a máquina não der conta, registra a anotação `not exercised` em vez de falhar.
- Cada rodada cria um diretório temporário próprio (`aae-ui-run-*`), com o estado desse backend, o HOME dele (os diálogos de pastas começam ali, nunca nas pastas pessoais de quem roda; a lista `protected-paths.txt` do estado padrão da máquina é copiada para o estado da rodada, com o `~` resolvido, e a proteção continua valendo) e as fixtures sintéticas: o `playwright.config.ts` aponta `TMPDIR` para ele, e `tests/ui/global-teardown.ts` o apaga no fim, falhando a rodada se não conseguir. Um spec novo cria as suas fixtures com `mkdtempSync(join(tmpdir(), …))`, nunca num `/tmp` fixo, que escaparia do diretório da rodada.
- O navegador vem de `AAE_CHROMIUM` (caminho do executável), do Chromium do sistema (`/usr/bin/chromium` ou `/usr/bin/chromium-browser`) ou da instalação do Playwright: `npx playwright install chromium` (sem bibliotecas do navegador: `npx playwright install --with-deps chromium`).
- Fluxo dirigido após o build: `npm run test:ui -- --grep 'open, inspect'`. Ele cobre fixtures temporárias, listagem lenta de diretórios e janela compacta.
- Cenário opcional de **cópia real** (“Optional run on a real directory copy”): lê uma cópia de um projeto real indicada por `AAE_REAL_COPY`; não há caminho padrão. Sem a variável, é ignorado com motivo explícito; um caminho configurado inexistente falha, em vez de esconder um erro de configuração. A cópia não pode estar dentro de `AAE_PROTECTED_PATHS`. O teste descobre a entrada (`AGENTS.md`/`CLAUDE.md`) e uma referência dela, e compara um inventário limitado da cópia antes e depois (tipo, tamanho, mtime e SHA-256 dentro de um orçamento; `.git` e `node_modules` sem descer), sem afirmar que todos os arquivos foram auditados: o JSON em `test-results/` registra entradas, bytes com hash e truncamento.
- `AAE_PROTECTED_PATHS` (caminhos absolutos separados por `:`) e `protected-paths.txt` no diretório de estado (padrão e `--state-dir`) protegem diretórios contra criação, estado do aplicativo, snapshot de documentos da CLI (`freeze` e `audit --suite`) e edição; os testes configuram as duas fontes só com temporários. A suíte Python roda por `discover -s tests -t .` para que `tests/__init__.py` aponte `HOME` para um temporário e nunca leia o estado real do usuário; rode a suíte sempre por `npm test`; um módulo isolado exige o mesmo `discover -s tests -t .` (por exemplo, com `-p test_x.py`), senão perde o isolamento.
- Idioma: parte dos specs afirma o texto da tela em português e roda com `aae-lang=pt`, fixado no `storageState` do `playwright.config.ts`. É transitório: sai quando essas asserções passarem para o inglês. Até lá, elas conferem também o pacote português. O `storageState` só alcança a origem do servidor da suíte; um spec com servidor próprio fixa o idioma com `page.addInitScript`, como `tests/ui/expected-observations.spec.ts`. Um spec que precisa de um perfil novo, em inglês, usa `test.use({ storageState: { cookies: [], origins: [] } })`, como `tests/ui/language.spec.ts`.
- A [CI](.github/workflows/ci.yml) executa `format:check`, build, Python e interface com fixtures temporárias, excluindo o cenário opcional. Uma configuração versionada não comprova uma execução remota.

## Propor uma mudança

1. Confira o estado Git, preserve alterações que não são suas e separe a mudança numa branch (`git switch -c trabalho/descricao`) ou worktree.
2. Altere o código-fonte, não `dist/` nem uma cópia instalada. Mudanças de modelo atualizam backend, tipos (`src/types.ts`), consumidores e testes juntos.
3. Atualize a fonte única do assunto: requisito em SPECS, regra do leitor em `docs/modelo-e-leitura.md`, CLI em `docs/cli.md`, uso em `docs/guia-de-uso.md`, entrega em [CHANGELOG.md](CHANGELOG.md).
4. Alteração de baixo impacto em documentação: revisão de links e diff basta. Alteração de comportamento: exercite o cenário real afetado. Não amplie a tarefa com refatorações ou testes sem relação.
5. Comente só o que o código, os nomes e os tipos não dizem: o porquê de uma decisão que não é óbvia, um invariante que uma mudança pode quebrar, a referência a um formato externo, a razão de uma verificação de segurança. Não narre o que a linha faz nem conte o histórico (o que era antes, quando mudou, quem pediu): isso fica no CHANGELOG e no Git. Ao mudar o código, atualize ou apague o comentário que a mudança invalida; sem comentário é melhor do que um comentário desatualizado.

Antes de abrir um pull request:

- correção de defeito vem com um teste que falha sem ela;
- `npm run format:check`, `npm run build`, `npm test` e `npm run test:ui` passam;
- os comentários que a mudança tocou continuam verdadeiros;
- uma mudança visível tem uma linha curta no [CHANGELOG.md](CHANGELOG.md), em **Não lançado**, e o documento dono do assunto está atualizado.

Contribuições entram sob a mesma licença do projeto (MIT); não há CLA nem DCO.

### O que conferir por tipo de mudança

- **Tema:** fallback escuro sem preferência salva, alternância para claro, persistência após reload, canvas e diálogos.
- **Scanner:** evidências preservadas, caminhos dirigidos/inversos, limites, múltiplas raízes e ausência de escrita nas raízes.
- **Criação:** a prévia não grava; um diretório existente (mesmo vazio) é recusado; o diretório criado sai da leitura sem observações, nos dois idiomas, e os dois conjuntos de texto têm a mesma estrutura.
- **Interface (composição):** a tela pelo [critério de posicionamento visual](docs/posicionamento-visual.md): a pergunta de cada princípio respondida olhando a tela, em 1536×960 e 749×396, nenhuma das formas que não entram e, para um controle novo, o lugar dado por “Onde entra um controle novo”.
- **Texto de interface:** a frase em inglês, com `t()`; `npm run i18n:check` sem item em (c); a tela nos dois idiomas (menu **Mais** › Português/English), sem `{parâmetro}` cru nem texto cortado.
- **Edição:** sem a edição ligada no projeto aberto mais específico que contém o arquivo, nada grava, nem por outra janela nem com o estado adulterado; cada recusa termina conferindo que a árvore ficou idêntica (bytes, inode, modo, dono, grupo e horário de cada arquivo) e que não sobrou `.aae-edit-*`; o conflito por hash recusa; `unconfirmed` nunca vira “nada foi gravado”, e um sucesso descreve os bytes que estão no disco; uma gravação que espera a trava da pasta não segura as outras rotas; toda recusa da rota traz `code`; a CLI continua sem comando que grava. Os testes de edição (`tests/test_editing.py`, `tests/test_editing_http.py`) usam só temporários, com `HOME` falso: o caso do diretório pessoal nunca usa o real. Na interface, `tests/ui/editing-logic.spec.ts` cobre as regras puras e `tests/ui/edit-*.spec.ts` a tela, conferindo os bytes no disco; o que não dá para provocar (resposta perdida, erro do servidor, leitura lenta, nó sem hash) é simulado por interceptação e dito no teste, e `tests/ui/edit-server.spec.ts` para e reinicia de verdade um servidor próprio.

## Evidências e dados

- Use diretórios temporários com conteúdo sintético. Não inclua credenciais, `.env`, estado pessoal, `workspace.json`, documentos privados, perfis de navegador, logs ou dependências.
- **Evidência nova só em `test-results/`**, ignorado pelo Git. Screenshots e traces podem conter os arquivos exibidos. Não grave capturas, logs ou JSON de verificação em `docs/`.
- Ao citar um resultado (no pull request ou na documentação), registre data, revisão, comando, aprovados/falhos/ignorados e os limites do que foi observado. Resultados e capturas antigos não são validação atual; um cenário ignorado não conta como aprovado.
- A captura do README se regenera com `npm run build && node scripts/capture-readme.mjs` (fixture sintética; grava as seis imagens em `test-results/readme/`, confira-as antes de copiar uma para `docs/imagens/`).

## Instalação local

```sh
npm run build
python3 scripts/install.py
```

O instalador grava fora do repositório (`~/.local/share/agent-architecture-explorer`, `~/.local/bin`, `~/.local/share/applications`), não altera configurações do desktop e preserva `state/` ao reinstalar. Depois de uma mudança de frontend, recarregue ou reabra a janela. Depois de uma mudança de backend, o servidor Python já em execução continua com os módulos antigos: identifique esse servidor (launcher, `server.json` na pasta `state` da instalação, processo real) antes de reiniciá-lo e não encerre navegadores ou servidores genéricos. `agent-architecture-explorer --print-url` localiza ou **inicia** a instância instalada; não é um comando só de inspeção.

## Idioma e commits

A interface é escrita em **inglês**, direto no código. O **português** é um pacote opcional, `src/i18n/pt-BR.ts`, escolhido no menu **Mais** › Português/English e guardado por navegador em `localStorage['aae-lang']`, sem consultar o idioma do navegador; o que o pacote não tiver aparece em inglês. Todo o texto da interface e o que o servidor escreve para uma pessoa estão em inglês no código; `tests/ui/portuguese-source.spec.ts` (no código, sem navegador) e o percurso de `tests/ui/language.spec.ts` (na tela, num perfil novo) falham se o português voltar fora do pacote. A documentação continua em português nesta fase; mensagens de commit, identificadores, comentários e docstrings ficam em inglês. Antes de um commit, revise o diff e os arquivos staged, rode as verificações adequadas e use uma mensagem que descreva o resultado.

### Texto de interface

- Texto de interface (rótulo, `title`, `aria-label`, `placeholder`, aviso, contagem) é escrito em inglês, com `t()`, `plural()` ou `rich()` de `src/i18n/`, no lugar onde aparece: não há chave nem dicionário de inglês.
- Ninguém é obrigado a tocar no pacote português. Uma frase nova sem tradução aparece em inglês, sem erro de build nem de teste; quem mantém o português roda `npm run i18n:check` e completa o pacote.
- A frase vai inteira e literal, com parâmetros nomeados. Texto montado por concatenação, ou passado numa variável, não se traduz, e o `i18n:check` aponta a chamada.

```tsx
const { t, plural, rich } = useI18n(); // no componente: renderiza de novo ao trocar o idioma
t('Open project');
t('Open {name}', { name }); // parâmetro faltando ou com outro nome é erro de tipo
plural(count, '{count} file', '{count} files'); // 1000 → "1,000 files" / "1.000 arquivos"
rich('Press <kbd>Ctrl+K</kbd> to search', { kbd: (chunks) => <kbd>{chunks}</kbd> });

import { t } from './i18n'; // fora de componente (funções puras): o idioma ativo na hora da chamada
```

- **Plural:** `plural(count, forma1, formaN, parâmetros?)`. `{count}` recebe o número, e a forma sai de `Intl.PluralRules`. Em português só 1 é singular (“0 arquivos”), como a interface sempre escreveu.
- **Números:** um número passado como parâmetro sai no formato do idioma escolhido. Para um número sem separador de milhar (linha, ano), passe texto: `String(line)`.
- **Datas e horas:** `formatDate(valor, estilo)` (de `useI18n()` ou de `src/i18n`) escreve um momento no fuso deste computador e no formato do idioma: `'date'` (11/07/2026; 07/11/2026), `'day-time'` (11/18 1:56 PM; 18/11 13:56) e `'time'` (9:05 AM; 09:05). Nenhuma tela monta data à mão.
- **Texto rico:** `<tag>…</tag>` na frase e uma função por tag em `rich()`; um parâmetro de `rich()` também aceita um elemento. `t()` mantém só o conteúdo da tag, e a mesma frase serve a um `aria-label`.
- **Contexto:** só quando a mesma frase inglesa pede duas traduções: `t('Open', { context: 'state' })`, que no pacote é `'[state] Open'`.
- **Re-renderização:** um componente que mostra texto chama `useI18n()` ou recebe o texto de quem chama. `t`, `plural` e `rich` mudam de identidade com o idioma: inclua-os nas dependências de `useMemo` e `useCallback`.
- **Fora de `t()`:** o que não muda com o idioma, como caminhos, nomes de arquivo, códigos do contrato (`broken`, `outside-root`), atalhos (`Ctrl+B`) e o nome de cada idioma no seletor, que aparece sempre no próprio idioma.
- **Testes:** `tests/ui/i18n.spec.ts` (núcleo, pacote e `i18n:check`), `tests/ui/language.spec.ts` (o idioma na tela, e nenhum português na interface padrão), `tests/ui/portuguese-source.spec.ts` (nenhum português nos textos de `src/` fora do pacote, sem navegador); o detector dos dois, `tests/ui/portuguese.ts`, usa o próprio pacote como inventário do português; `src/i18n/typecheck.ts` faz o build falhar se os tipos de `t()` afrouxarem.

### Pacote português

`src/i18n/pt-BR.ts` é um mapa plano, editável à mão: a frase inglesa exatamente como o código a escreve → a frase portuguesa, agrupado por área com comentários.

```ts
'Open project': 'Abrir projeto',
'Open {name}': 'Abrir {name}',
'{count} file | {count} files': '{count} arquivo | {count} arquivos', // plural: cada par unido por ' | '
'[state] Open': 'Aberto', // contexto
```

- Mantenha cada `{parâmetro}` e `<tag>` da frase inglesa: `tests/ui/i18n.spec.ts` falha se a tradução tiver outros, porque a tela mostraria texto quebrado.
- `npm run i18n:check` (só leitura) lista (a) frases do código sem entrada, que aparecem em inglês; (b) entradas que o código não usa mais, ignoradas; (c) traduções com parâmetros ou tags diferentes, ou malformadas; (d) chamadas com frase ou contexto que não é literal. Sai com 0; `npm run i18n:check -- --strict` sai com 1 se alguma lista não estiver vazia.
- Mudar uma frase inglesa no código deixa a entrada antiga órfã e a nova sem tradução; o `i18n:check` mostra as duas.

### Texto do servidor

O servidor escreve só em inglês; não há opção de idioma no servidor nem na CLI. Uma frase que pode chegar à interface (mensagem de observação, de sinal ou de achado, aviso de Alterações, recusa da API, erro de restauração) é escrita com `say` de `server/texts.py`, com a frase literal e parâmetros nomeados:

```python
from texts import of, plural, say  # nos módulos importados também como pacote: try `from .texts import …`

raise ValueError(say('Not a folder: {path}', path=path))
issue('manifest', say('Invalid manifest: {reason}', reason=of(exc)), source)  # of(exc): a frase com que a exceção foi levantada
plural(count, 'An invalid mark … was ignored.', '{count} invalid marks … were ignored.')  # duas formas, duas frases
```

- O valor é um `str` com a frase inglesa pronta, que a CLI, o relatório `audit` e o log escrevem como está. A API manda ao lado a frase-modelo e os parâmetros (`messagePhrase`, `errorPhrase`), e a interface procura a frase-modelo no bloco `ptBRServer`, no fim de `src/i18n/pt-BR.ts`, e depois no pacote da interface (`ptBR`).
- Ao escrever ou mudar uma frase do servidor, acrescente ou atualize a entrada dela nesse bloco, com os mesmos `{parâmetros}`; uma frase que `ptBR` já tem com o mesmo português (as recusas da edição, que a tela também diz) não se repete no bloco, porque `tests/ui/language.spec.ts` procura cada entrada de `ptBR` uma vez só no bundle. `tests/test_server_texts.py` (em `npm test`) falha se uma frase ficar sem entrada, se o bloco tiver uma entrada que o servidor não diz, se os parâmetros diferirem ou se sobrar um literal em português em `server/`. Uma frase sem entrada apareceria em inglês na tela, sem erro.
- Um parâmetro que a frase nomeia não pode ser `None` nem outro objeto: a interface mostraria a frase inglesa. O nome `context` não serve de parâmetro (o `t()` o lê como contexto).
- O português do bloco é o que as versões anteriores à 1.0, não publicadas, escreviam: `tests/findings_before_english.py` e `tests/server_phrases_before_english.json` registram o que ela escrevia, e os testes que os leem mostram o que mudou. A interface nunca lê uma frase que essa versão guardou no estado (um achado de referência salva, o motivo de uma atualização recusada): em português ela aparece como veio.
- Não monte frase por concatenação nem com f-string: o `str` resultante perde a frase-modelo e aparece em inglês. Uma frase dentro de outra vai como parâmetro (`reason=say(…)`), e a interface a traduz por si.
- Um número vai como está (`20000`); `number(5000)` escreve `5,000`, que a interface escreve de novo no idioma dela (`5.000`).
- O que a interface precisa ler de uma observação vai como parâmetro da frase (mesmo sem aparecer nela) ou, num sinal, como campo: nenhuma tela procura um dado dentro de uma frase.
- Texto que só a CLI escreve (ajuda, `schema`, validação de suíte e de snapshot) é um literal inglês comum, sem entrada no pacote.
- Um teste que afirma uma frase afirma a inglesa; `tests/server_pack.py` (`portuguese`) dá o que a interface em português mostra para ela, quando o teste quer afirmar isso também.

### Glossário

Os mesmos termos nos dois idiomas, em rótulos, mensagens e documentação. Ficam iguais em inglês e português: Skill, AGENTS.md, CLAUDE.md, SKILL.md, wikilink, frontmatter, symlink, snapshot.

| Português | English | Nota |
| --- | --- | --- |
| projeto (o que foi aberto) | project | “root” só na CLI, no JSON e em texto técnico |
| pasta | folder | `directory` no contrato |
| projeto salvo; excluir × fechar | saved project; forget × close | fechar (Remover da tela) só tira da tela; excluir tira do aplicativo |
| projeto pai / projeto interno; nível | parent project / nested project; level | |
| Instruções (classe) / ponto de entrada (papel) | Instructions / entry point | os dois são `entry` no contrato |
| vista; Mapa, Estrutura; Início | view; Map, Structure; Home | o Início é a lista de projetos |
| barra de vistas | Views strip | onde a vista minimizada fica |
| explorador, inspetor, painel inferior | explorer, inspector, bottom panel | |
| Memória, Skill, Manifesto, Outros | Memory, Skill, Manifest, Other | classes de arquivo |
| referência (o que está escrito) / relação (o que o app conta e desenha) | reference / relation | sem “citação” nem “conexão” |
| cita / citado por | references / referenced by | |
| aponta para (a direção de uma referência: de quem a escreve para o destino) | points to | no mapa de uma pasta, os cartões “Apontam para esta pasta” (o que chega de fora) e “Esta pasta aponta para” (o que sai); a coluna da Estrutura “aponta para” |
| origem / destino | source / target | |
| evidência | evidence | |
| observação (achado na CLI) | observation (finding) | `Issue` no código |
| Problema / Aviso / Informativo | Problem / Warning / Info | |
| Auditoria | Audit | |
| esperada; Marcar como esperada | expected; Mark as expected | |
| referência ausente | broken reference | código `broken` |
| Caminho (ferramenta A→B); Definir como A | Trace; Set as A | “path” fica para o caminho de um arquivo |
| passo (uma seta do Caminho); etapa (coluna do mapa do Caminho) | step; File 1, File 2… | |
| Alterações; referência de comparação | Changes; baseline | `delta` no código |
| Reler; leitura parcial; lido em parte | Rescan; partial scan; partly read | a leitura do app é *scan*; o que o modelo abre são *reads* |
| citados não encontrados | targets not found | destinos que o leitor não achou, com os nomes sem arquivo |
| Ver (detalhe, evidência, limites) | View | |
| Somente leitura | Read-only | |
| Nova arquitetura; prévia | New architecture; preview | |
| Localizado / Ausente / Fora dos projetos abertos / Em pasta não lida / Não seguido / Não verificado | Found / Missing / Outside open projects / In unread folder / Not followed / Unverified | estado de um destino |
