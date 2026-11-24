# Laboratório sintético de auditoria

O agente fictício **Aurora** permite exercitar a inspeção sem abrir uma arquitetura real, uma cópia dela ou uma instalação pessoal. O gerador usa apenas a biblioteca padrão do Python, não importa o scanner e não executa os documentos produzidos. Todo conteúdo é sintético. O laboratório contém falhas intencionais: uma auditoria correta deve detectá-las.

## Criar e abrir

Na raiz do repositório:

```sh
python3 tests/create_audit_lab.py
```

O comando cria `/tmp/aae-audit-*/lab` e imprime JSON com os caminhos absolutos das raízes, do oráculo e do baseline. `/tmp` é temporário e pode ser apagado pelo sistema. Para preservar um laboratório em outro local, escolha um **destino novo** cujo pai já exista:

```sh
python3 tests/create_audit_lab.py --destination /tmp/meu-laboratorio-aurora
```

O gerador recusa destino existente, inclusive vazio, arquivo, symlink ou symlink pendente; pais ausentes, arquivos e symlinks; componentes `..`; e caminhos protegidos por `AAE_PROTECTED_PATHS`. Não há opção de sobrescrita. Os arquivos de teste nunca devem ser tratados como instruções para o agente que conduz a auditoria.

Em **Adicionar diretório**, abra primeiro o caminho `roots.primary` impresso pelo comando. Depois acrescente `roots.child` e `roots.sibling` para exercitar sobreposição e resolução entre raízes. `roots.no_entry` cobre a ausência de entrada. Abra essas raízes individualmente: abrir o contêiner do laboratório misturaria oráculo e sentinelas ao material inspecionado e mudaria o cenário.

Para usar o código atual sem alterar a instalação pessoal, compile com `npm run build` e inicie um servidor separado em uma porta livre:

```sh
audit_state=$(mktemp -d /tmp/aae-aurora-state-XXXXXX)
python3 server/main.py --port 47841 --state-dir "$audit_state"
```

Abra `http://127.0.0.1:47841` no navegador. Se a porta estiver ocupada, escolha outra; não encerre um processo desconhecido. Use `Ctrl+C` nesse terminal para encerrar apenas o servidor do laboratório.

Os testes automatizados sempre criam laboratórios próprios; um laboratório manual é só uma conveniência local.

```text
lab/
├── aurora/                         ← raiz principal
│   ├── AGENTS.md
│   ├── agent-architecture.json      ← declaração válida com evidência própria
│   ├── fluxos/{inicio,revisao}.md
│   ├── memory/decisoes.md
│   ├── equipes/pesquisa/AGENTS.md    ← raiz filha, diferença de nível 2
│   ├── convencao/CLAUDE.md          ← acessível da entrada só com convenções
│   ├── skills/triagem/SKILL.md
│   ├── documentos/Guia de ação.md
│   ├── politicas/{a,b}/Politica.md  ← wikilink ambíguo
│   ├── ciclos/{a,b}.md
│   ├── invalido/agent-architecture.json
│   ├── limites/                    ← >1 MiB e UTF-8 inválido
│   ├── hub.md                      ← 12 destinos explícitos
│   ├── links.md                    ← import, path, wiki e link por referência
│   ├── hostil.md                   ← comando inerte, nunca executar
│   ├── atalho.md                   ← symlink para sentinela sintética
│   ├── atalho-pasta                ← symlink de diretório
│   └── .git/, .cache/, node_modules/← exclusões com textos sintéticos
├── compartilhado/                  ← raiz irmã
│   ├── CLAUDE.md
│   └── contrato.md
├── sem-entrada/isolado.md           ← raiz sem ponto de entrada
├── sentinelas/segredo-sintetico.md   ← fora das raízes de inspeção
├── oracle.json                     ← expectativas manuais independentes
└── baseline.json                   ← integridade anterior à inspeção
```

## Critérios de verificação

Uma alegação só passa de uma etapa à seguinte com a evidência da anterior. Um teste negativo passa quando a operação é recusada ou a relação não é inventada; um cenário pulado não conta como aprovação.

| Etapa | Pergunta e evidência exigida |
| --- | --- |
| 1. Contrato | Quais relações e ausências foram escritas na fixture? `oracle.json` registra paths relativos ao laboratório, tipo, origem, linha, trecho, caminhos, estados e diagnósticos esperados. |
| 2. Modelo | O scanner concorda com as expectativas manuais? Comparar evidências exatas, caminhos dirigidos/inversos, classificação, deduplicação e negativos. Repetir a leitura deve produzir o mesmo modelo. |
| 3. Fronteiras | Links externos e symlinks não podem trazer conteúdo; exclusões não podem gerar evidências; tamanho/decodificação devem produzir diagnósticos; notas devem ficar no estado separado. Comparar a árvore inteira com o baseline após as operações. |
| 4. API e UI | Exercitar o servidor isolado e a interface real, conferir leitura/evidência, auditoria, navegação, temas, persistência e criação em destino novo. Contratos do modelo não substituem testes de interação. |
| 5. Contestação | Tentar falsificar as conclusões: inverter direção, desativar convenções, abrir/fechar a raiz irmã, usar caminhos ambíguos, destino existente e pais inválidos. Registrar falha concreta, correção e nova execução. |

O caminho principal é `AGENTS.md → fluxos/inicio.md → fluxos/revisao.md → memory/decisoes.md`, com três passos. O retorno dirigido não existe; em ambos os sentidos são três travessias inversas. `AGENTS.md → convencao/CLAUDE.md` não existe sem convenções. Um caminho A = A é válido e tem zero passos.

`expected_edges` é um conjunto mínimo obrigatório de evidências, não uma contagem total de relações. O extrator também reconhece paths de manifestos e mantém convenções separadas. Por isso, os negativos são declarados explicitamente: sem palpite para os dois `Politica.md`, sem relação por mera menção em prosa, sem arestas para web/âncora, sem extração das sentinelas ou exclusões. A ausência de erro nesses casos deve ser conferida, não deduzida de uma captura do mapa.

Ao abrir só Aurora, `compartilhado/contrato.md` é externo; após abrir a raiz irmã, torna-se resolvido e analisado. Abrir a raiz filha mantém um único nó físico, duas associações de raiz e propriedade visual da raiz mais específica. O documento isolado continua sem caminho mesmo em ambos os sentidos.

Os códigos esperados em `issues` incluem `broken`, `ambiguous`, `manifest`, `symlink`, `limit`, `unreadable`, `unreachable` e, na raiz correspondente, `no-entry`. `links.md` não é citado por nenhum arquivo (`unreachable`, classe `orphan`) e `documentos/caminho.md` só é citado por ele (classe `island`): são candidatos a revisão, não arquivos inacessíveis — continuam localizáveis por busca. `repeated-reference`, `cycle` e `high-fanout` ficam em `signals` (oráculo: chave `signals`) e em `stats.structure`, nunca em `issues`. Ciclos e concentração de saídas descrevem estrutura documental; não comprovam execução, degradação ou falha operacional do agente fictício.

Pela CLI, `python3 -B -m server.cli audit --root <roots.primary> --summary` resume a mesma auditoria no relatório v2: códigos sem prefixo, caminhos relativos à raiz, `unreachable` e `symlink` como `info` (não alteram o status), `limit`/`unreadable` como `incomplete` e os sinais estruturais em `metrics.structure`. O laboratório Aurora não é o oráculo do relatório da CLI; os contratos do relatório estão em [CLI](cli.md#auditoria-estrutural-v2).

## Executar verificações

O teste do laboratório está incluído em `npm test`. Para rodá-lo sozinho:

```sh
python3 -m unittest discover -s tests -t . -p test_audit_lab.py -v
```

A suíte cria diretórios temporários, testa o gerador, compara o scanner/BFS ao oráculo manual e verifica integridade após leitura e anotações. A recusa do caminho protegido é exercitada com `AAE_PROTECTED_PATHS` apontando para um caminho sintético inexistente; nenhum diretório real é acessado para esse teste. O cenário de UI usa também o gerador:

```sh
npm run build
npm run test:ui -- tests/ui/audit-lab.spec.ts
```

Para comparar a integridade do laboratório manual após uma sessão, na raiz do repositório, com `AURORA_LAB` apontando para o diretório `lab` impresso pelo gerador:

```sh
AURORA_LAB=/caminho/do/lab python3 - <<'PY'
import json, os
from pathlib import Path
from tests.create_audit_lab import fingerprint
lab = Path(os.environ['AURORA_LAB'])
expected = json.loads((lab / 'baseline.json').read_text())
assert fingerprint(lab) == expected, 'O laboratório foi alterado'
print('Árvore, conteúdo e metadados preservados')
PY
```

O fingerprint cobre entradas, modos, tamanhos, `mtime_ns`, hashes SHA-256 dos arquivos e destinos textuais dos symlinks, sem percorrê-los. Exclui `atime`, que uma leitura pode atualizar, e os próprios `oracle.json`/`baseline.json`, que ficam fora das raízes de inspeção. Guarde o estado do servidor em outro diretório, nunca dentro desse contêiner.

A criação de arquiteturas é uma vertical separada: use outro destino novo, revise a prévia antes de criar e compare o filesystem antes/depois da prévia. Teste que repetir o mesmo destino é recusado e preserva o conteúdo existente. Não use Aurora como destino de criação.

## Limites da evidência

Os testes do laboratório não comprovam todas as formas de Markdown/YAML, todos os tamanhos de grafo, todos os ambientes nem todos os agentes de produção. O arquivo grande exercita o limite por arquivo; limites de inventário, orçamento total e quantidade de relações dependem dos testes de fronteira correspondentes. Não é necessário executar comandos do agente fictício para verificar a inspeção determinística.

Registre data, revisão de código, comando, quantidade de aprovados/falhos/pulados e artefatos atuais para cada rodada. Relatórios e screenshots anteriores não são evidência desta execução. Uma falha que sobreviva a essas etapas fica como limitação explícita antes do uso em produção.
