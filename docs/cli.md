# CLI `aae`

O projeto pode avaliar arquiteturas documentais porque o scanner é independente da interface. A CLI transforma essa leitura em relatórios reproduzíveis: a auditoria estrutural, o delta entre duas auditorias e o inventário de arquivos. Numa suíte, quem escreve o cenário declara quais trechos são necessários e quais dependem de gatilhos; o relatório informa se cada um é alcançável por referências explícitas a partir da entrada, por qual caminho e a que custo em bytes sempre carregados, com caminhos e evidências verificáveis.

Isso permite comparar revisões e detectar regressões sem atribuir compreensão, memória ou raciocínio interno ao modelo. Uma conexão estática não prova que um agente a percorreu. Bytes são uma medida de volume, não uma estimativa exata de tokens. Regras de relevância são fornecidas pelo autor do cenário; a ferramenta não consegue validar sozinha se esse oráculo representa a tarefa real.

## Entrada e saída

Na raiz do checkout, use `python3 -B -m server.cli --help`. De outro diretório, use `python3 /caminho/do/projeto/scripts/aae.py --help`. O instalador também fornece `aae` em `~/.local/bin`, que preserva o diretório de trabalho do chamador para caminhos relativos; não é necessário instalar para usar a CLI. Nenhum desses comandos abre a interface, inicia servidor HTTP ou carrega o estado pessoal (dele, só a lista de caminhos protegidos é lida; ver `protected`).

Para descobrir o contrato sem consultar esta documentação, execute `python3 -B -m server.cli schema` (ou `aae schema`). O objeto `kind: "schema"` (JSON v2, sem leitura da arquitetura) contém as versões de cada relatório (`reportVersions`), contratos de auditoria, escopo, suíte e `freeze`, opções dos comandos, códigos de saída, o que mudou entre versões, campos aceitos, exemplos válidos de suíte com arquivos fictícios para reproduzi-los e os roteiros `workflow.audit` e `workflow.overhaul`.

Saída normal: um objeto JSON em stdout. Os relatórios `audit` e `schema` usam `version: 2`; os demais, `version: 1` (`aae --version` informa `aae 3 (CLI contract v3: audit v2, schema v2; other reports v1)` e `schema.reportVersions` diz o mesmo). Ajuda e versão são texto. Os relatórios trazem `kind` (`schema`, `audit`, `audit-comparison`, `freeze`, `inventory`, `protected` e `error`). Relatórios podem ser redirecionados para arquivos **fora das raízes inspecionadas**. O programa não oferece escrita de relatórios nas fontes nem executa scripts encontrados nelas.

| Código de saída | Significado |
| --- | --- |
| `0` | Contrato satisfeito, comparação sem regressão ou metadados produzidos. Avisos estruturais ainda devem ser examinados, mas não são automaticamente violações operacionais. |
| `1` | Violação demonstrada do contrato ou regressão. |
| `2` | Erro, `kind: "error"`, com um achado: `invalid-input` (entrada inválida, versão incompatível ou caminho inacessível; corrija o pedido) ou `internal-error` (defeito da ferramenta, inclusive do leitor; ver abaixo). |
| `3` | Evidência insuficiente, leitura parcial, execução interrompida ou limite atingido. Nunca tratar como aprovação. |

`invalid-input` vem só da validação do que foi pedido: argumentos, arquivos JSON de controle, raízes e escopo. Qualquer outra falha é `internal-error`: a mensagem e uma única linha no stderr (`aae: internal-error: TIPO in arquivo.py:LINHA`) dizem o tipo da exceção e onde ela ocorreu, nunca conteúdo de documento, e o stdout continua sendo o JSON documentado. Não é reprovação nem entrada errada: relate o erro com essa linha.

Não use `set -e` sem tratar os códigos esperados dos controles negativos. Um cenário propositalmente ruim deve produzir `1`, e isso é sucesso do teste negativo.

## Laboratório reproduzível

Os exemplos abaixo criam uma árvore nova; não utilizam uma arquitetura pessoal preexistente:

```sh
lab_parent=$(mktemp -d /tmp/aae-cli-example-XXXXXX)
python3 tests/create_builder_lab.py --destination "$lab_parent/lab"
python3 -B -m server.cli audit --root "$lab_parent/lab/atlas" --summary
python3 -B -m server.cli audit --root "$lab_parent/lab/atlas" --suite "$lab_parent/lab/suite.json"
```

O laboratório Atlas contém referência quebrada e referência repetida propositais, dois arquivos de ruído, contrato obrigatório, procedimento de incidente e honeypot neutro. A suíte (`suite.json`) fica fora da raiz `atlas`. O gerador recusa destinos existentes, ancestrais com symlinks e caminhos protegidos por `AAE_PROTECTED_PATHS`.

Resultados esperados: a auditoria estrutural mostra os problemas plantados: `broken` para `obsoleto/ausente.md` (warning, sem alterar o status), a repetição em `metrics.structure.repeatedReferences` e os arquivos de ruído e o honeypot como `unreachable` (info, candidatos sem caminho por referência explícita). Com `--summary`, o relatório tem cerca de 5,4 KB (o caminho absoluto da raiz entra no tamanho). A suíte do laboratório não tem `contentHash`; por isso `audit --suite` traz um aviso `requirement-unbound` por cenário. Congelada com `freeze` (abaixo), ela produz os mesmos resultados sem esse aviso.

## Contrato de cenário

```json
{
  "version": 1,
  "entry": "AGENTS.md",
  "scenarios": [{
    "id": "normal",
    "triggers": [],
    "required": [{"path": "core/contrato.md", "startLine": 2, "endLine": 3}],
    "conditional": [{"path": "conditional/incidente.md", "startLine": 2, "endLine": 3, "trigger": "incidente"}],
    "forbidden": ["honeypot/irrelevante.md"],
    "maxReads": 3,
    "maxBytes": 2048,
    "maxHops": 2
  }]
}
```

Paths são relativos POSIX exatos, sem `..`, symlinks como fonte de leitura ou normalizações ambíguas. Linhas são inclusivas e começam em 1. Gatilhos são rótulos explícitos do cenário, não detectados automaticamente na prosa. Para testar incidente, crie outro cenário com `triggers: ["incidente"]`. Um trecho condicional ativo passa a ser obrigatório. `forbidden` (arquivos neutros declarados pelo autor, como um honeypot), `maxReads` e `maxBytes` são validados e entram em `suiteHash` e `contractHash`, mas nenhum comando os mede: declaram, para uma avaliação de agente feita fora da CLI com a mesma suíte, o que ele não deveria ler e quanto pode ler.

Campos desconhecidos, IDs duplicados, caminhos inválidos e requisitos contraditórios são recusados. Limites: 100 cenários, 1.000 requisitos/caminhos proibidos no total, linhas até 1.000.000. Arquivos JSON de controle têm limite de 8 MiB; chaves duplicadas e números não finitos são recusados. O caminho de um deles (`--before`, `--after`, `--suite`, `--scope`) pode ter `..`, resolvido pelo texto (`sub/../x.json` é `x.json`); como a leitura não segue links em nenhum componente, um `..` logo depois de um link simbólico é recusado, assim como pasta, FIFO ou dispositivo no lugar do arquivo, sempre com `invalid-input`.

Campos opcionais, todos compatíveis com suítes anteriores (uma suíte sem eles conserva o mesmo `suiteHash`):

| Campo | Onde | Efeito |
| --- | --- | --- |
| `contentHash` | requisito (`required` e `conditional`) | SHA-256 dos bytes UTF-8 das linhas `startLine..endLine`, com seus terminadores, segundo `str.splitlines(keepends=True)`. Não calcule à mão: use `freeze`. |
| `maxAlwaysLoadedBytes` | cenário | Orçamento de custo do sempre-carregado: o arquivo `entry` **inteiro** no snapshot (`wc -c`), leia o agente quanto ler. São bytes entregues em todo turno por runtimes que injetam a entrada, e loaders de runtime podem truncar acima de um teto. Excedido: `always-loaded-budget-exceeded` (`actual`, `maximum`, `path`; saída 1). |
| `entryInjected` | suíte (nível superior) | Booleano, padrão `false`: `true` declara que o runtime entrega a entrada inteira antes da primeira ação. É validado e entra em `suiteHash` e `contractHash`, mas nenhum comando o usa: serve à mesma avaliação feita fora da CLI. |

### Identidade de conteúdo e `freeze`

Um intervalo de linhas envelhece em silêncio quando os arquivos auditados são editados: uma linha inserida no topo desloca o trecho exigido, e o requisito passaria a designar outras linhas. `contentHash` amarra o requisito ao conteúdo. Para vinculá-lo sem calcular hashes, congele a suíte contra a revisão em que o oráculo foi escrito:

```sh
python3 -B -m server.cli freeze --root "$lab_parent/lab/atlas" --suite "$lab_parent/lab/suite.json" > "$lab_parent/frozen.json"
python3 -B -m server.cli audit --root "$lab_parent/lab/atlas" --suite "$lab_parent/frozen.json"
```

`freeze` imprime `{kind: "freeze", status, suite, suiteHash, contractHash, entry, snapshotHash, snapshotPartial, changes, findings}` e não grava arquivos. Requisitos sem `contentHash` são vinculados, inclusive condicionais inativos (`action: "bound"`). Requisitos com `contentHash` são verificados: conteúdo divergente fica obsoleto. `--relocate` move um requisito obsoleto somente se a mesma sequência de linhas existir em **exatamente um** lugar de um snapshot completo (`relocated`, com `from`/`to`); vários lugares, nenhum lugar, snapshot parcial ou um destino que tornaria o contrato contraditório mantêm o requisito obsoleto. `--rebind` aceita o conteúdo atual do intervalo e recalcula o hash (`rebound`); com as duas opções, a realocação vem primeiro. `pass` exige todos os requisitos vinculados e válidos; obsoletos ou intervalos indisponíveis resultam em `inconclusive` (saída 3) com achados. `--rebind` não revisa o trecho: confira o intervalo antes de usar a suíte resultante.

Todo `--suite` (`audit` e `freeze`) aceita a suíte nua ou o relatório `freeze` inteiro, desde que `status` seja `pass` e os hashes correspondam à suíte; outro status é erro de entrada (saída 2).

No `audit --suite`, um requisito **ativo** cujo `contentHash` diverge do snapshot gera `requirement-stale` (`incomplete`, saída 3) com `scenarioId`, `path`, `startLine`, `endLine` e `relocated`: até cinco lugares onde o trecho idêntico está agora (`relocatedTotal` conta todos; lista vazia indica que não há cópia idêntica; `relocationComplete: false` indica snapshot parcial ou limite de busca). O `audit` nunca segue o trecho sozinho. Requisito em arquivo ausente ou omitido é `requirement-unavailable`, com `relocated` quando tem identidade. Uma suíte com requisitos sem identidade continua aceita, com um aviso `requirement-unbound` por cenário (`scenarioId`, `count`) dizendo que deslocamento ou edição do trecho não é detectado. A busca de realocação compara janelas com o mesmo número de linhas, com um índice por comprimento e limites de 2.000.000 janelas e 256 MiB por execução.

## Medições e correções orientadas por evidência

| Comando | Evidência e utilidade |
| --- | --- |
| `schema` | Descoberta em JSON, sem leitura da arquitetura: contratos, opções e exemplos executáveis. |
| `audit --root PATH [--root OUTRO] [--suite JSON] [--scope JSON] [--summary] [--code CODE]... [--source GLOB]... [--top N] [--fail-on CODE]...` | Relatório v2 ([Auditoria estrutural v2](#auditoria-estrutural-v2)): resumo primeiro, achados com id estável e caminhos relativos, escopo declarado, massa em bytes e, com suíte, menor caminho dirigido para cada requisito ativo. `maxHops` limita esse caminho; uma aresta conserva arquivo de origem, linha e trecho. Convenções não entram no BFS. A mesma suíte aplica-se relativamente a cada raiz aberta. |
| `compare-audit --before A.json --after B.json [--fail-on CODE]...` | Delta entre duas auditorias v2 completas: achados novos, resolvidos e persistentes, casados por id; `--fail-on` vale para os novos e para `audit-context-differs` (suíte, contrato ou escopo efetivo diferentes; `any` o inclui). |
| `freeze --root PATH --suite JSON [--relocate] [--rebind]` | Vincula cada requisito ao conteúdo atual (`contentHash`) ou verifica uma suíte já congelada; imprime a suíte resultante, `suiteHash`, `contractHash`, mudanças e achados. Não grava arquivos. |
| `protected` | Lista os caminhos protegidos efetivos com a fonte (a variável `AAE_PROTECTED_PATHS` ou o `protected-paths.txt` do diretório de estado padrão, com o caminho do arquivo); código 2 se a configuração estiver quebrada. Somente leitura. |
| `inventory --root PATH [--root OUTRO]` | Captura hashes e tamanhos dos arquivos regulares sob as raízes, sem conteúdo ([inventário](#inventário)). |

`contractHash` é o SHA-256 do JSON canônico (chaves ordenadas, sem espaços) da suíte normalizada em que cada requisito é representado apenas por `contentHash` (condicionais mantêm `trigger`), com listas de requisitos e cenários ordenadas e preservando IDs, gatilhos, proibidos, orçamentos, `entry` e `entryInjected`. É `null` enquanto algum requisito não tem `contentHash`. `freeze` e `audit` trazem `contractHash` ao lado de `suiteHash`.

O snapshot de documentos que `freeze` e `audit --suite` montam usa somente a primeira raiz e aceita até 200 textos, 256 KiB por texto e 2 MiB no total; as demais raízes continuam disponíveis para a auditoria estrutural. Paths recusados por política, como `.ssh`, `.config`, `.env*` e arquivos de credenciais, geram aviso `policy-excluded`: uma aprovação cobre somente o corpus permitido. Omissões restantes por tamanho, quantidade, caminho protegido ou falha de leitura geram `snapshot-partial`. Exigir um trecho excluído continua produzindo `requirement-unavailable`, sem aprovação. Symlinks e hardlinks não entram no snapshot.

## Auditoria estrutural v2

A auditoria foi desenhada para um agente que audita os agent context files de outro projeto em poucas chamadas e com a janela limitada: resumo primeiro, detalhe sob filtro, nada repetido, caminhos relativos e ids estáveis para comparar cópias.

Saída real de `audit --root exemplo --scope escopo.json --code broken --fail-on broken` num diretório sintético, encurtada (`…` marca o que foi cortado; a raiz absoluta foi trocada):

```json
{"version": 2, "kind": "audit", "status": "fail",
 "roots": [{"path": "/caminho/do/exemplo", "name": "exemplo", "parent": null, "level": 0, "entries": ["AGENTS.md"]}],
 "summary": {"total": 4, "bySeverity": {"error": 0, "incomplete": 0, "warning": 2, "info": 2},
             "byCode": {"broken": 2, "declared-external": 1, "unreachable": 1}, "top": 10,
             "topSources": [{"path": "AGENTS.md", "count": 2, "byCode": {"broken": 2}}],
             "topTargets": [{"target": "docs/exemplos.md", "count": 1, "codes": ["broken"]}, …]},
 "gate": {"failOn": ["broken"], "matched": {"broken": 2}}, "filter": {"codes": ["broken"], "sources": [], "matched": 2},
 "metrics": {"files": 4, "unresolvedTargets": 3, "parsed": 4, "edges": 6, "entries": 1, "partial": false,
             "resolution": {…}, "structure": {…}, "reachability": {…}, "mass": {…}, "inventory": {…},
             "headers": {…}, "relations": {…}, "ignored": {…}, "probe": {…}},
 "scope": {"source": "flag", "patterns": [{"kind": "runtimeWorkspace", "pattern": "drafts/", "references": 1, "files": 0}]},
 "suiteHash": null, "contractHash": null, "scopeHash": "fe47d181…", "limitations": […], "policy": {…},
 "analyzed": [{"path": "AGENTS.md"}, …], "unanalyzed": [], "paths": [],
 "findings": [{"id": "e12a66fb242f9ef4", "code": "broken", "severity": "warning",
               "message": "Target not found: skills/_shared/style-guide.md",
               "path": "AGENTS.md", "line": 14, "target": "skills/_shared/style-guide.md",
               "evidence": "- Siga o [guia de estilo](skills/_shared/style-guide.md) ao escrever.",
               "syntax": "markdown", "form": "path"}, …]}
```

- **Caminhos.** A raiz absoluta aparece só em `roots[].path`; `parent` é o índice da raiz pai. `entries`, `metrics`, achados, candidatos e passos de caminho usam o caminho relativo à raiz dona. Com mais de uma raiz, cada item que aponta arquivo traz `root` (índice em `roots`); com uma raiz só, não traz. Mensagens não repetem a raiz absoluta.
- **Achado.** `{id, code, severity, message, root?, path?, line?, target?, ...}`, ordenados por severidade (`error`, `incomplete`, `warning`, `info`), `path` e `line`. `message` é uma frase em inglês para quem lê o relatório: não entra no `id`, a redação pode mudar entre versões sem mudança de contrato, e a CLI não tem opção de idioma; um script decide por `code` e pelos campos, nunca pelo texto de `message`. Códigos do scanner vêm sem o prefixo `scanner-`. `info` nunca altera o status.
- **`summary`** é sempre do conjunto inteiro, também com filtro: `total`, `bySeverity`, `byCode` (inclusive `info`), `topSources` e `topTargets` (só `error`/`incomplete`/`warning`; `--top N`, de 1 a 100, padrão 10).
- **`--summary`** omite `findings`, `unanalyzed` e `paths` e acrescenta `findingsOmitted`. Também corta em `--top` itens (padrão 10) as listas que crescem com a árvore e põe o total ao lado, com o nome da lista seguido de `Total`: `roots[].entries` → `entriesTotal`, `scope.patterns` → `patternsTotal` e `metrics.reachability.starts` → `startsTotal` (primeiros em ordem estável); `metrics.mass.entries` → `entriesTotal` e `metrics.mass.alwaysLoaded.files` → `filesTotal` (maiores em bytes; `alwaysLoaded.bytes` continua somando todos); `metrics.mass.reachableByHops` → `reachableByHopsTotal` (primeiros níveis; `reachability.hops.max` dá o último); `metrics.inventory.byTopLevel` → `byTopLevelTotal` (as pastas com mais elementos fora primeiro). O modo de detalhe não corta nada.
- **Filtro.** `--code` (repetível, aceita vírgulas) e `--source GLOB` (repetível, mesma sintaxe do escopo, aplicado ao `path`) filtram só `findings`; o relatório traz `filter: {codes, sources, matched}`. `summary`, `metrics`, `status` e `gate` continuam do conjunto inteiro. Código desconhecido é erro de entrada (saída 2) com a lista válida.
- **Gate.** `--fail-on CODE` (repetível, aceita vírgulas) torna o status `fail` (saída 1) quando há achado desse código no conjunto inteiro; `any` cobre qualquer `warning` ou `error`. `gate: {failOn, matched}` mostra as contagens. Precedência: `fail` > `inconclusive` > `pass`. Um código `info` como `unreachable` pode ser usado explicitamente.
- **Identidade.** `id` = 16 hex de SHA-256 sobre (código, índice da raiz quando há várias, caminho relativo, discriminador, ordinal). Discriminador: `target`; senão `scenarioId` + `path` nos achados de suíte; senão `pattern`. Ordinal: posição entre achados de mesma chave, por linha. Sem caminho absoluto, número de linha nem mensagem: cópias da mesma árvore têm os mesmos ids, e inserir linhas não muda nenhum. A ordem das raízes faz parte da identidade.

| Severidade | Códigos |
| --- | --- |
| `error` (saída 1) | `required-unreachable`, `hop-budget-exceeded`, `always-loaded-budget-exceeded`, `entry-unavailable` (`required-unreachable` e `entry-unavailable` viram `incomplete` quando a análise é parcial) |
| `incomplete` (saída 3) | `limit`, `unreadable`, `analysis-partial`, `path-evidence-limit`, `requirement-stale`, `requirement-unavailable`, `snapshot-partial`, `suite-snapshot-unavailable` |
| `warning` | `broken`, `ambiguous` (com `candidates`, até 20, e `candidatesTotal`; `info` quando escrita como nome nu, `form` `name` ou `word`), `outside-root` (`target`, `ancestor` relativo à raiz, como `..`, `levels`, `legacyId`; só dentro de um repositório: ver a [sonda](modelo-e-leitura.md#resolução-em-cascata)), `invalid-reference`, `manifest`, `manifest-mismatch` (`target`, `absent`, `from`, `to`, `manifest`, `evidence`, `syntax` no link; ver abaixo), `no-entry`, `scope-unused-pattern`, `requirement-unbound`, `policy-excluded` |
| `info` | `manifest-unchecked` (`target`, `reason`, `manifest`, `from` e `to` quando resolvidos; ver abaixo), `unreachable` (`class`: `orphan` ou `island`, `inbound`, `referencedAncestor`; `conclusive: false` quando a leitura de alguma raiz aberta é parcial: inventário cortado, texto não analisado ou relações cortadas), `basename-resolved`, `suffix-resolved` e `root-dot-resolved` (`target`, `resolvedTo`, `resolvedBy`), `declared-external` (`target`, `scopeKind`, `pattern`), `unresolved-name` (`target`), `unverified` (`target`, `reason`: `lookup` ou `frontmatter`, `legacyId`), `symlink` |

`manifest-mismatch` é um aviso como os outros: não altera o status, entra em `--fail-on any` e em `--fail-on manifest-mismatch`, no `audit` e, quando novo, no `compare-audit`. Só existe num `agent-architecture.json` com `"linkedRelationships": true` ([regras](modelo-e-leitura.md#manifesto-e-links-linkedrelationships)): `absent: link` é uma relação sem link do arquivo de origem (`path` é o manifesto, a linha é a da relação e `target` é `origem → destino` como escritos); `absent: relation` é um link entre dois objetos sem relação (`path` é o arquivo do link, na linha dele, e `target` é o link como escrito). `from`, `to` e `manifest` são relativos à raiz do achado (`fromRoot`, `toRoot` ou `manifestRoot` quando o arquivo é de outra raiz aberta; fora de todas, com `..`). Uma relação que o leitor não pôde conferir (origem não lida, ponta ou link não resolvido, link numa forma que o extrator não lê) é `manifest-unchecked` (`info`), na linha da relação, com `reason`: não altera o status nem entra em `--fail-on any`; `--fail-on manifest-unchecked` a cobra, para quem quer conferência completa.

`--fail-on broken` casa também `outside-root` (`gate.matched.broken` soma os dois), no `audit` e no `compare-audit`: a referência que só resolve acima da raiz está quebrada para o diretório usado sozinho, e um gate por `broken` a cobre; `--fail-on outside-root` casa só ele. A ambígua escrita como nome nu é `info` porque um nome comum a várias pastas costuma ser menção, não ponteiro: não altera o status nem entra em `--fail-on any` do `audit`, mas entra em `--fail-on ambiguous`. No `compare-audit`, ao contrário, uma `ambiguous` **nova** reprova `--fail-on any` qualquer que seja a forma: ela nasce de um homônimo criado depois da mudança. Com `any`, `gate.matched` conta só os achados que o qualificam; com um código explícito, todos os desse código.

`limit` vem de cinco fontes: o inventário de uma raiz cortado (a mensagem diz quantas pastas ficaram lidas em parte ou não lidas e quantos elementos ficaram fora), o orçamento de texto da leitura (um por raiz, com `count`, `bytes` e `byTopLevel`; a lista completa, com `reason` `budget`, `size` ou `unreadable`, está em `unanalyzed`, só no modo de detalhe, e a soma dos `budget` de uma raiz é o `count`), um arquivo acima de 1 MiB (um por arquivo), um JSON aninhado além da profundidade do interpretador (um por arquivo, manifesto inclusive, com análise `partial`) e o teto de 100.000 relações. Com relações cortadas, `metrics.relations` (`{complete, omitted, max}`) diz quantas ficaram fora e o status fica `inconclusive`; os achados de referência continuam completos. `metrics.headers` (`{files, bytes, max, complete}`) mede os cabeçalhos de Markdown não analisados, lidos para wikilinks nus dentro de um orçamento de 8 MiB. O relatório completo traz também `analyzed` (`[{root?, path}]`, os textos analisados, em ordem), ao lado de `unanalyzed`.

Achados de referência (`broken`, `unresolved-name`, `ambiguous`, `unverified`, `outside-root`, `invalid-reference`) trazem `evidence` (o trecho da linha; numa linha de mais de 500 caracteres, uma janela de até 500 em volta do destino escrito, com `…` nas pontas cortadas; ver [regras](modelo-e-leitura.md#observações-e-sinais-estruturais)), `syntax` (`markdown`, `markdown-reference`, `wiki`, `path`, `import`, `manifest`) e `form` (`path`, `name`, `word`). `unverified` e `outside-root` trazem `legacyId`: o `id` que o achado tem quando outra leitura afirma a ausência (`broken` ou `unresolved-name`), como numa cópia do diretório sem o repositório acima ou numa leitura completa, calculado com o ordinal entre os achados que continuam com esse código. No modelo do leitor, o mesmo campo guarda o `id` do leitor (com linha).

`unreachable` é candidato a revisão: documento (`.md`, `.markdown`, `.txt`) sem caminho por referência explícita a partir das entradas consideradas. Continua localizável por busca, e o runtime pode carregá-lo por convenção; declare entradas e cargas implícitas no escopo. `cycle`, `repeated-reference` e `high-fanout` não são achados: ficam em `metrics.structure` (componentes cíclicos com 2+ arquivos, autorreferências, repetições, maior fan-out e onde). As relações de um manifesto não contam como repetição ([regra](modelo-e-leitura.md#observações-e-sinais-estruturais)).

**Forma da referência, nome entre skills e identidade declarada.** As regras estão em [modelo e leitura](modelo-e-leitura.md): a [forma da referência](modelo-e-leitura.md#forma-da-referência-broken--unresolved-name) decide entre `broken` (warning) e `unresolved-name` (info) quando o destino continua ausente depois da cascata e da absorção pelo escopo; a [cascata](modelo-e-leitura.md#resolução-em-cascata) prefere o candidato único sob a skill da origem; o [wikilink sem diretório](modelo-e-leitura.md#wikilinks-e-identidade-declarada) resolve primeiro pelo `name:` do frontmatter. No relatório:

- `target` é sempre a referência como escrita, e o nó do destino continua existindo com status `missing`. Uma referência absorvida pelo escopo é `declared-external`.
- `unresolved-name` continua listado, entra em `summary.byCode` e em `metrics.resolution.unresolvedNames` e vale em `--code`, `--fail-on unresolved-name` e `compare-audit`; como é `info`, não altera o status nem aparece em `topSources`/`topTargets`. Use `--code unresolved-name` ou `--fail-on unresolved-name` para revisar ou bloquear quebras reais escritas só como nome.
- Resoluções por nome ou sufixo único continuam `basename-resolved`/`suffix-resolved` (mesmo `id`) e trazem `resolvedBy` com o modo exato (`skill-basename`/`skill-suffix` quando o candidato veio de sob a skill da origem).
- A resolução pelos degraus `root`, `root-dot` (menção `./x` achada a partir da raiz) e `skill` e pela identidade declarada (`frontmatter-name`) aparece só em `metrics.resolution` e no `resolvedBy` dos passos de `paths[]`, sem achado `info`. Dois ou mais arquivos com o `name:` citado por um wikilink dão `ambiguous` com `candidates`.
- Um destino achado além do limite de inventário é `unscanned`, nunca `broken`, e conta em `metrics.resolution.unscanned`. O que não é referência (variável, marcador de modelo, wikilink de código, chave de manifesto num JSON comum, crase ou prosa num `.txt`, o que não resolve num bloco cercado) não vira achado e conta em `metrics.ignored`. Ausência não afirmável é `unverified`; destino que só existe acima da raiz aberta é `outside-root` ([regras](modelo-e-leitura.md#resolução-em-cascata)).

`metrics` traz `files` (arquivos inventariados que existem, o mesmo número de `find RAIZ -type f` descontadas as pastas excluídas pela política: sem diretórios, links simbólicos nem destinos não resolvidos), `unresolvedTargets` (marcadores de destino não resolvido: ausentes, declarados, externos, não analisados e não verificados), `resolution` (arestas por modo de resolução: `file`, `frontmatter-name`, `skill`, `root`, `root-dot`, `skill-basename`, `skill-suffix`, `basename`, `suffix`, `unresolved`; e, atravessando os modos, `unresolvedNames`, a parte de `unresolved` que caiu em `unresolved-name`, e `unscanned`, as relações para um destino que existe mas não foi lido), `structure`, `relations` (`complete`, `omitted`, `max`), `headers`, `reachability` (`starts` com origem `convention`, `declared-entry` ou `implicit-load`; documentos alcançáveis/inalcançáveis, órfãos, ilhas, isentos e saltos máximo/mediana), `mass` (abaixo), `inventory` (`complete`, `lookupComplete`, `omitted`, `omittedFiles`, `byTopLevel` `[{root?, name, inventoried, onDisk}]` e `entriesOmitted` `{count, paths: [{root?, path}]}`, as entradas e skills que ficaram só no índice, todas, em ordem de caminho (com `--summary`, `paths` fica com as `--top` primeiras e `count` continua o total); ver [inventário](modelo-e-leitura.md#inventário-e-índice-de-existência)), `ignored` (o que não é referência, por motivo) e `probe` (`maxLevels` e, por raiz externa, `levels`, os ancestrais que a sonda testa, `stop`, `git`, ou `none` quando não há repositório acima, ou `home` quando o `.git` é da pasta pessoal ou de uma pasta acima dela, e nos dois últimos a sonda não roda, `repository`, o ancestral com `.git` relativo à raiz, e `probes`, quantos destinos ela conferiu). `mass`:

- `entries`: cada entrada (`AGENTS.md`/`CLAUDE.md` e entradas declaradas) com `bytes`;
- `alwaysLoaded`: `{bytes, basis, files}`, a soma do que o runtime carrega sempre. Sem suíte, `AGENTS.md`/`CLAUDE.md` diretamente na raiz (sem somar entradas aninhadas por convenção); com suíte, a `entry` da suíte em cada raiz. Nos dois casos, somam-se os arquivos que casam com `entries` do escopo, inclusive uma entrada aninhada declarada (contada uma vez). Cada item de `files` traz `source`: `convention`, `suite-entry` ou `declared-entry`; `basis` é `root-level-entries` ou `suite-entry`, com `+declared-entries` quando há entradas declaradas. `implicitLoads` (carga por gatilho) não soma. O orçamento `maxAlwaysLoadedBytes` da suíte continua medindo **só a `entry` da suíte**, sem escopo: `alwaysLoaded.bytes` pode passar dele sem gerar `always-loaded-budget-exceeded`;
- `reachableByHops`: arquivos e bytes alcançados em cada nível de salto (não cumulativo);
- `documentsBytes`: soma dos documentos `.md`/`.markdown`/`.txt`.

Bytes são iguais a `wc -c`. Massa é custo entregue e risco de corte pelo teto do loader do runtime; não é contagem de tokens.

Com `--suite`, o relatório traz `paths[]` (por requisito ativo e raiz: `found`, `hops`, `steps` com origem, linha, trecho e `resolvedBy`, e `contentHash` quando houver), `required-unreachable` e `hop-budget-exceeded`. No snapshot da primeira raiz, acrescenta `requirement-stale` (com `relocated`), `requirement-unavailable`, `requirement-unbound`, `always-loaded-budget-exceeded`, `policy-excluded` e `snapshot-partial`. Requisito em arquivo inexistente gera um único `required-unreachable` com `available: false`. Se o snapshot não puder ser montado (por exemplo, entrada acima de 256 KiB), a auditoria estrutural continua e um achado `suite-snapshot-unavailable` (incomplete) diz o motivo; `contentHash` não é verificado, mas `maxAlwaysLoadedBytes` é: com o tamanho da entrada conhecido pelo inventário, o excesso gera também `always-loaded-budget-exceeded` (error, saída 1, mesmo `id` da versão medida no snapshot). Com várias raízes, os achados de conteúdo valem só para a primeira.

### Escopo declarado

O escopo diz o que é do projeto auditado, o que é do runtime e o que entra sem link. Pode vir por `--scope JSON` (substitui o embutido em todas as raízes; o arquivo é aceito em qualquer lugar, inclusive dentro da raiz analisada, mas o recomendado, como diz o `schema`, é deixá-lo fora dela, para não misturar a declaração com o material analisado) ou embutido na chave `scope` do `agent-architecture.json` na raiz aberta. Formato, exemplo, sintaxe dos padrões, absorção e pontos de partida: [declaração de escopo](modelo-e-leitura.md#declaração-de-escopo). Na CLI, campos desconhecidos são recusados com saída 2.

No relatório, a referência absorvida por `runtimeWorkspace` ou `localFiles` vira `declared-external` (info), contada em `scope.patterns[].references`; arquivos que casam ficam isentos de `unreachable` (`files`); só `entries` soma em `metrics.mass.alwaysLoaded`. Referência ambígua nunca é absorvida. Padrão sem referência nem arquivo gera `scope-unused-pattern`. O escopo é uma afirmação do autor: é contado, não verificado. `scopeHash` é o hash do escopo **efetivo**: fonte (`flag` ou `manifest`) e declaração validada, a da flag ou a embutida de cada raiz (identificada pelo índice, não pelo caminho absoluto). É `null` só quando nenhuma raiz tem declaração; uma declaração embutida vazia (`{"version": 1}`) já conta.

### Delta de auditoria

```sh
copia="$lab_parent/copia"            # cópia de trabalho da raiz, fora do laboratório
cp -R "$lab_parent/lab/atlas" "$copia"
frozen="$lab_parent/frozen.json"     # a suíte congelada em "Identidade de conteúdo e freeze"
python3 -B -m server.cli audit --root "$copia" --suite "$frozen" > "$lab_parent/antes.json"
# ... edite a cópia ...
python3 -B -m server.cli audit --root "$copia" --suite "$frozen" > "$lab_parent/depois.json"
python3 -B -m server.cli compare-audit --before "$lab_parent/antes.json" --after "$lab_parent/depois.json" --fail-on any
```

`compare-audit` exige dois relatórios `audit` v2 com `findings` (relatório `--summary` é recusado com saída 2), o mesmo número de raízes e, se filtrados, o mesmo filtro. Saída: `{version: 1, kind: "audit-comparison", status, beforeStatus, afterStatus, gate?, findings, byCode: {code: {new, resolved, persisting}}, persisting, new, resolved, reclassified, hops?, limitations}`. `new` traz os achados do depois e `resolved` os do antes. Os meta-achados são `audit-context-differs` (warning, quando `suiteHash`, `contractHash` ou `scopeHash` diferem; `differs` diz qual) e `comparison-incomplete` (saída 3, quando um dos lados é parcial ou inconclusivo). Com escopo efetivo diferente, `audit-context-differs` traz `scopeSource: {before, after}` e avisa que parte do delta pode ser artefato da declaração: um `agent-architecture.json` com `{"scope": {"version": 1, "runtimeWorkspace": ["**"], "entries": ["**"]}}` "resolve" todo `broken` e `unreachable` sem mudar a arquitetura. Sem `--fail-on`, o status é `pass`, salvo incompletude; com a flag, um achado novo do código marcado reprova (saída 1), e `any` inclui toda `ambiguous` nova, inclusive a escrita como nome nu. Um achado do depois cujo `legacyId` é o `id` de um achado do antes (a mesma referência, que a leitura do antes dava como ausente) não é novo nem o antigo é resolvido: os dois entram em `reclassified` (`previousId`, `previousCode`), contam como persistentes e não reprovam o gate. O par só vale com o mesmo `path`, a mesma linha e o mesmo `target` escrito, e numa transição que o leitor produz (`broken` ou `unresolved-name` antes, `unverified` ou `outside-root` depois); um `legacyId` que não casa assim é ignorado, e os dois achados seguem como novo e resolvido. Assim, comparar o relatório de uma cópia solta (`broken`) com o do checkout (`outside-root`), ou de uma leitura completa com o de uma parcial (`unverified`), não reprova sem mudança na árvore. `--fail-on` do delta aceita também `audit-context-differs` (e `any` o inclui), para que mudança de escopo, suíte ou contrato reprove; `--fail-on any` também reprova, portanto, quando os dois lados usam suítes diferentes. O mesmo escopo embutido dos dois lados não gera aviso. Quando os dois relatórios trazem `paths`, `hops` lista os requisitos cujo menor caminho mudou, identificados por `contentHash` (ou path e linhas). Uma árvore contra a sua cópia em outro diretório dá delta vazio e saída 0. Renomear um arquivo resolve os achados do nome antigo e cria os do novo.

### Limites conhecidos do audit e do delta

- O ordinal do `id` conta achados de mesma chave por linha: inserir acima uma nova referência ao mesmo alvo no mesmo arquivo pode trocar a **atribuição** dos ids entre as ocorrências (a contagem do delta continua correta).
- Arquivo renomeado resolve os achados do nome antigo e recria os do novo.
- Uma mudança nas regras do leitor entre duas versões da ferramenta aparece no `compare-audit` como achados resolvidos e novos sem mudança nos arquivos; compare relatórios gerados pela mesma versão.
- Relatório de `audit` acima de 8 MiB (limite dos JSON de controle) não pode ser comparado: use filtros iguais nos dois lados.
- `contractHash` identifica requisitos só pelo conteúdo: trechos idênticos em lugares diferentes são equivalentes.
- Os limites do leitor valem também aqui: numeração por `str.splitlines`, leitor mínimo do frontmatter, só referências explícitas (menção em crase a diretório sem âncora nem extensão não é extraída), referência que passa por pasta não lida (excluída, link simbólico ou sem permissão de busca e não listada) fica `unscanned` sem achado, e a existência do arquivo não é conferida, e o homônimo sob a skill da origem é preferido sem ambiguidade. Ver [limites e exclusões](modelo-e-leitura.md#limites-e-exclusões).
- `legacyId` usa o ordinal entre os achados que continuam com o código antigo: quando uma de duas referências iguais no mesmo arquivo muda de código, a outra pode herdar o `id` que era da primeira (a mesma limitação do ordinal acima).

### Roteiros

Auditoria dos agent context files de outro projeto:

1. `audit --root R --summary`: status, `summary.byCode` (inclusive `unreachable` e `unresolved-name`), `topSources`, `topTargets`, `metrics.mass` e `metrics.inventory` (com `complete` falso, as pastas de `byTopLevel` com mais elementos fora dizem qual subdiretório abrir como raiz).
2. Se `broken` se concentra em pastas de trabalho do runtime ou em arquivos locais (veja `topTargets`), escreva um escopo fora da raiz e repita com `--scope`; confira `scope.patterns`.
3. `audit ... --code broken --code ambiguous` (e `--source GLOB` para uma pasta): detalhe com `path`, `line`, `target` e `candidates`.
4. `audit ... --code unreachable`: candidatos sem caminho por referência explícita, para revisão.
5. `audit ... --code unresolved-name`: nomes citados sem diretório que não correspondem a arquivo; separe exemplos e artefatos de execução de quebras reais escritas só como nome.

Reforma: `freeze` contra a revisão original → `audit --suite` antes → editar → `audit --suite` depois + `compare-audit`. O mesmo roteiro está em `schema.workflow`.

## Inventário

```sh
python3 -B -m server.cli inventory --root "$lab_parent/lab/atlas"
```

O inventário considera arquivos regulares, inclusive tipos não documentais, até 20.000 elementos, 16 MiB por arquivo e 128 MiB totais. Omissões e erros resultam em `partial` e status `inconclusive` (saída 3). Não segue symlinks, não lê FIFOs nem aceita hardlinks. É observação limitada, não snapshot atômico contra um processo hostil concorrente. Múltiplas raízes preservam índices e ordem.

## Verificação

`npm test` inclui os testes de CLI, contrato de suíte, inventário e laboratório; `npm run test:audit` também compila e cobre os cenários sintéticos de interface (ver [CONTRIBUTING.md](../CONTRIBUTING.md)). Os testes exercitam controles positivos e negativos, retesta bugs corrigidos e mantém fixtures em diretórios temporários.
