// Portuguese pack: each English phrase, exactly as the code writes it, and its Portuguese.
//
// - The code is written in English; nobody has to add a phrase here. What is missing shows in
//   English, and an entry the code does not use is ignored. `npm run i18n:check` lists both.
// - Keep each `{parameter}` and `<tag>` of the English phrase (a test checks it).
// - A plural is one entry, each pair joined by ' | '. For plural(n, '{count} file', '{count} files'):
//     '{count} file | {count} files': '{count} arquivo | {count} arquivos',
// - A phrase with a context, t('Open', { context: 'state' }), is written '[state] Open'.
// - Use the glossary in CONTRIBUTING.md. Group the entries by area, as the code is.
import type { Pack } from './translate';

export const ptBR: Pack = {
  // Top bar › More menu (src/App.tsx)
  'More': 'Mais',
  'Panels, theme, language and help': 'Painéis, tema, idioma e ajuda',
  'Show inspector': 'Mostrar inspetor',
  'Hide inspector': 'Recolher inspetor',
  'Show explorer': 'Mostrar explorador',
  'Hide explorer': 'Recolher explorador',
  'Show panels': 'Mostrar painéis',
  'Hide panels': 'Recolher painéis',
  'Reset layout': 'Restaurar disposição',
  'Switch to light theme': 'Ativar tema claro',
  'Switch to dark theme': 'Ativar tema escuro',
  'Show the interface in Portuguese': 'Mostrar a interface em português',
  'Show the interface in English': 'Mostrar a interface em inglês',
  'Help': 'Ajuda',
  // Top bar › explorer button (src/App.tsx)
  'Explorer': 'Explorador',
  'Explorer shown · Ctrl+B hides it': 'Explorador aberto · Ctrl+B recolhe',
  'Explorer hidden · Ctrl+B shows it': 'Explorador recolhido · Ctrl+B mostra',

  // Labels of the model: file classes, relations, statuses, resolution steps, scope kinds (src/types.ts)
  'Instructions': 'Instruções',
  'Skill': 'Skill',
  'Manifest': 'Manifesto',
  'Memory': 'Memória',
  'File': 'Arquivo',
  '[kind] Folder': 'Diretório',
  'Reference': 'Referência',
  'Symlink': 'Link simbólico',
  'Markdown link': 'Link Markdown',
  'Reference link': 'Link por referência',
  'Written path': 'Caminho escrito',
  '@ import': 'Importação @',
  'Manifest metadata': 'Metadado de manifesto',
  'Declared relation': 'Relação declarada',
  'Scope by convention': 'Escopo por convenção',
  'Found': 'Localizado',
  'Missing': 'Ausente',
  'Outside open projects': 'Fora dos diretórios abertos',
  'In unread folder': 'Em pasta não lida',
  'Not followed': 'Não seguido',
  'Declared outside the package': 'Declarado fora do pacote',
  'Unverified': 'Não verificado',
  'by the name declared in the frontmatter': 'pelo nome declarado no frontmatter',
  "by the Skill's root": 'pela raiz da skill',
  'by the open project': 'pela raiz aberta',
  'by the open project (./ read from the root)': 'pela raiz aberta (./ lido a partir da raiz)',
  'by unique name': 'por nome único',
  'by unique suffix': 'por sufixo único',
  'by unique name in the Skill itself': 'por nome único na própria skill',
  'by unique suffix in the Skill itself': 'por sufixo único na própria skill',
  'Wikilink without a folder resolved by the only Markdown file that declares that name (name:) in its own frontmatter, before any search by file name: it is the identity declared by the target, not a guess by name.':
    'Wikilink sem pasta resolvido pelo único arquivo Markdown que declara esse nome (name:) no próprio frontmatter, antes de qualquer busca pelo nome de arquivo: é a identidade declarada pelo destino, não um palpite por nome.',
  "The path does not exist from the source file's folder; it was resolved from the folder of the nearest SKILL.md.":
    'O caminho não existe a partir da pasta do arquivo de origem; foi resolvido a partir da pasta do SKILL.md mais próximo.',
  "The path does not exist from the source file's folder; it was resolved from the open project that contains the source.":
    'O caminho não existe a partir da pasta do arquivo de origem; foi resolvido a partir da raiz aberta que contém a origem.',
  "A ./ mention (in backticks or in the text) that does not exist from the source file's folder; it was resolved from the open project, like a working directory. A ./ Markdown link has no such fallback.":
    'Menção ./ (em crase ou no texto) que não existe a partir da pasta do arquivo de origem; foi resolvida a partir da raiz aberta, como um diretório de trabalho. Um link Markdown ./ não tem esse recuo.',
  'The path does not exist from the source nor from the open projects; a single file listed in the root of the source has that name. Check that it is the intended target.':
    'O caminho não existe a partir da origem nem das raízes abertas; um único arquivo listado na raiz da origem tem esse nome. Confira se é o destino pretendido.',
  'The path does not exist from the source nor from the open projects; a single file listed in the root of the source ends with that path. Check that it is the intended target.':
    'O caminho não existe a partir da origem nem das raízes abertas; um único arquivo listado na raiz da origem termina com esse caminho. Confira se é o destino pretendido.',
  'The path does not exist from the source nor from the open projects; a single file with that name exists inside the source Skill itself, even though there are namesakes in other Skills. Check that it is the intended target.':
    'O caminho não existe a partir da origem nem das raízes abertas; um único arquivo com esse nome existe dentro da própria skill de origem, mesmo havendo homônimos em outras skills. Confira se é o destino pretendido.',
  'The path does not exist from the source nor from the open projects; a single file inside the source Skill itself ends with that path, even though there are others in other Skills. Check that it is the intended target.':
    'O caminho não existe a partir da origem nem das raízes abertas; um único arquivo dentro da própria skill de origem termina com esse caminho, mesmo havendo outros em outras skills. Confira se é o destino pretendido.',
  'by an unrecognized mode ({mode})': 'por um modo não reconhecido ({mode})',
  "Resolution mode not recognized by this version of the interface; the target did not come from the source file's folder. Check that it is the intended target.":
    'Modo de resolução não reconhecido por esta versão da interface; o destino não veio da pasta do arquivo de origem. Confira se é o destino pretendido.',
  'Generated at runtime': 'Gerado na execução',
  'Local file': 'Arquivo local',
  'Entry': 'Entrada',
  'Implicit load': 'Carga implícita',
  'does not exist': 'não existe',
  'declared outside the package': 'declarado fora do pacote',
  'outside open projects': 'fora dos diretórios abertos',
  'in unread folder': 'em pasta não lida',
  'unverified': 'não verificado',

  // Observation dictionary, diagnosis sentences, inventory limit and signals (src/observations.ts)
  'Broken reference': 'Referência ausente',
  'The referenced file does not exist at the written path or in the other places the reader looks.':
    'O arquivo citado não existe no caminho escrito nem nos outros lugares onde o leitor procura.',
  'Ambiguous reference': 'Referência ambígua',
  'What is written matches more than one file of the project, and the reader picks none.':
    'O que está escrito corresponde a mais de um arquivo do projeto, e o leitor não escolhe nenhum.',
  'Target above the open project': 'Destino acima do diretório aberto',
  'The referenced file is not in the open project, but exists in a folder above it.':
    'O arquivo citado não está no diretório aberto, mas existe numa pasta acima dele.',
  'Unverified absence': 'Ausência não verificada',
  'The reader did not find the target, but did not read everything that could contain it; the absence is not certain.':
    'O leitor não achou o destino, mas não leu tudo o que poderia contê-lo; a ausência não é certa.',
  'Invalid reference': 'Referência inválida',
  'The reference is not a valid path, so no file can be found by it.':
    'A referência não tem forma de caminho válido, e nenhum arquivo pode ser achado por ela.',
  'Invalid manifest': 'Manifesto inválido',
  'agent-architecture.json has a part outside the expected format, which the scan ignored.':
    'O agent-architecture.json tem uma parte fora do formato esperado, que a leitura ignorou.',
  'Manifest does not match the links': 'Manifesto diverge dos links',
  'A relation of agent-architecture.json has no link in the source file, or a link between its objects is missing from the relations.':
    'Uma relação do agent-architecture.json não tem link no arquivo de origem, ou um link entre objetos dele falta nas relações.',
  'Unchecked relation': 'Relação não conferida',
  'The reader did not compare this relation of agent-architecture.json with the links: something in it or in its source was not read or resolved.':
    'O leitor não comparou esta relação do agent-architecture.json com os links: algo dela ou da origem não foi lido ou resolvido.',
  'No entry point': 'Sem ponto de entrada',
  'There is no AGENTS.md or CLAUDE.md in this open project.':
    'Não há AGENTS.md nem CLAUDE.md neste diretório aberto.',
  'Scope pattern with no effect': 'Padrão de escopo sem efeito',
  'A pattern of the scope declaration absorbed no reference and matched no file.':
    'Um padrão da declaração de escopo não absorveu nenhuma referência nem casou com algum arquivo.',
  'Scan limit': 'Limite de leitura',
  'Part of the material was not read because of a limit on items, text size or relations.':
    'Parte do material não foi lida por um limite de itens, de tamanho de texto ou de relações.',
  'Read failure': 'Falha de leitura',
  'The item was listed but could not be read (permission, encoding or special type).':
    'O item foi listado, mas não pôde ser lido (permissão, codificação ou tipo especial).',
  'Partial scan': 'Leitura parcial',
  'A limit or a read failure occurred, and the absence of an observation is not conclusive.':
    'Houve limite ou falha de leitura, e a falta de uma observação não é conclusiva.',
  'Referenced name with no file': 'Nome citado sem arquivo',
  'A name written without a folder matches no file of the project; it may be intentional.':
    'Um nome escrito sem pasta não corresponde a nenhum arquivo do projeto; pode ser intencional.',
  'No path by explicit reference': 'Sem caminho por referência explícita',
  'No sequence of explicit references leads from the project instructions to this file.':
    'Nenhuma sequência de referências explícitas leva das instruções do projeto até este arquivo.',
  'Symlink listed; the scan does not follow its target or read its content.':
    'Link simbólico listado; o leitor não segue o destino nem lê o conteúdo dele.',
  'Resolved by unique name': 'Resolvida por nome único',
  'The reference was resolved by the only file of the project with that name, not by the written path.':
    'A referência foi resolvida pelo único arquivo do projeto com esse nome, não pelo caminho escrito.',
  'Resolved by unique suffix': 'Resolvida por sufixo único',
  'The reference was resolved by the only file of the project that ends with the written path.':
    'A referência foi resolvida pelo único arquivo do projeto que termina com o caminho escrito.',
  './ mention resolved from the root': 'Menção ./ resolvida pela raiz',
  'A ./ mention that does not exist from the folder of the file was found from the open project.':
    'Uma menção ./ que não existe a partir da pasta do arquivo foi achada a partir do diretório aberto.',
  'Absorbed by the declared scope': 'Absorvida pelo escopo declarado',
  'The target does not exist in the project, and a pattern of the scope declaration absorbed it.':
    'O destino não existe no projeto, e um padrão da declaração de escopo o absorveu.',
  'Observation': 'Observação',
  'Observation code that this version of the interface does not recognize.':
    'Código de observação que esta versão da interface não reconhece.',
  'Name with several possible files': 'Nome com vários arquivos possíveis',
  'A name written without a folder matches several files of the project, and the reader picks none.':
    'Um nome escrito sem pasta corresponde a vários arquivos do projeto, e o leitor não escolhe nenhum.',
  'Problem': 'Problema',
  'Warning': 'Aviso',
  'Info': 'Informativo',
  '{count} problem | {count} problems': '{count} problema | {count} problemas',
  '{count} warning | {count} warnings': '{count} aviso | {count} avisos',
  '{count} info | {count} info': '{count} informativo | {count} informativos',
  '{items} and {last}': '{items} e {last}',
  '{counts}: {list}': '{counts}: {list}',
  '{counts} in the files of this project: {list}': '{counts} nos arquivos deste projeto: {list}',
  '{alerts} · {info}': '{alerts} · {info}',
  '[citation] Markdown link': 'link Markdown',
  'Markdown reference link': 'link Markdown por referência',
  'path mention (in backticks or in the text)': 'menção a caminho (em crase ou no texto)',
  '[citation] @ import': 'importação @',
  'manifest field': 'campo de manifesto',
  'relation declared in the manifest': 'relação declarada no manifesto',
  'inconclusive: partial scan': 'não conclusivo: leitura parcial',
  '{meaning} Inconclusive: partial scan.': '{meaning} Não conclusivo: leitura parcial.',
  '{meaning} Inconclusive in {n} of {total}: partial scan.':
    '{meaning} Não conclusivo em {n} de {total}: leitura parcial.',
  '{count} folder partly read | {count} folders partly read':
    '{count} pasta lida em parte | {count} pastas lidas em parte',
  '{count} unread | {count} unread': '{count} não lida | {count} não lidas',
  '{count} unread folder | {count} unread folders':
    '{count} pasta não lida | {count} pastas não lidas',
  'at least {count} item left out | at least {count} items left out':
    'pelo menos {count} item fora | pelo menos {count} itens fora',
  '{count} item left out | {count} items left out': '{count} item fora | {count} itens fora',
  'Limit of {budget} items per project: {parts}': 'Limite de {budget} itens por projeto: {parts}',
  '{count} entry or Skill file was left out, such as {example}. | {count} entry or Skill files were left out, such as {example}.':
    '{count} arquivo de entrada ou de skill ficou fora, como {example}. | {count} arquivos de entrada ou de skill ficaram fora, como {example}.',
  '{count} times → {target}': '{count} vezes → {target}',
  '{count} targets (threshold {threshold})': '{count} destinos (limiar {threshold})',
  '{count} targets': '{count} destinos',
  '{count} file: {files} | {count} files: {files}':
    '{count} arquivo: {files} | {count} arquivos: {files}',
  'May be intentional; does not prove runtime noise.':
    'Pode ser intencional; não comprova ruído de execução.',
  'A count does not prove inefficiency.': 'Quantidade não comprova ineficiência.',
  'Does not prove repetition when an agent runs.':
    'Não comprova repetição na execução de um agente.',
  'island · {count} file with no path references it | island · {count} files with no path reference it':
    'ilha · {count} arquivo sem caminho o cita | ilha · {count} arquivos sem caminho o citam',
  'orphan · no file references it': 'órfão · nenhum arquivo o cita',
  '{first} and {second}': '{first} e {second}',
  "Looked only in {at} (with .md), the path from this file's folder.":
    'Procurou só em {at} (com .md), o caminho a partir da pasta deste arquivo.',
  "Looked only in {at}, the path from this file's folder.":
    'Procurou só em {at}, o caminho a partir da pasta deste arquivo.',
  'Looked for a project file that declares {declared}, then {at} (with .md) and, last, a single project Markdown file with that name.':
    'Procurou um arquivo do projeto que declare {declared}, depois {at} (com .md) e, por fim, um único Markdown do projeto com esse nome.',
  'Looked for a project file that declares {declared}, then {at}.':
    'Procurou um arquivo do projeto que declare {declared}, depois {at}.',
  'Looked only in {at}: the folder {first}/ exists next to this file.':
    'Procurou só em {at}: a pasta {first}/ existe ao lado deste arquivo.',
  "Looked in {at} (from this file's folder).":
    'Procurou em {at} (a partir da pasta deste arquivo).',
  'Looked in {at}.': 'Procurou em {at}.',
  "Looked in {at} (from this file's folder) and in {roots} (from the open project).":
    'Procurou em {at} (a partir da pasta deste arquivo) e em {roots} (a partir do diretório aberto).',
  'Looked only in {at} (anchored path).': 'Procurou só em {at} (caminho ancorado).',
  "Looked in {at} from this file's folder, then from the Skill's folder and from the open project.":
    'Procurou em {at} a partir da pasta deste arquivo, depois a partir da pasta da skill e do diretório aberto.',
  "Looked in {at} from this file's folder, then from the open project.":
    'Procurou em {at} a partir da pasta deste arquivo, depois a partir do diretório aberto.',
  "Looked in {at} from this file's folder, then by the Skill's folder, by the open project and by a unique name or suffix in the project.":
    'Procurou em {at} a partir da pasta deste arquivo, depois pela pasta da skill, pelo diretório aberto e por nome ou sufixo único no projeto.',
  "Looked in {at} from this file's folder, then by the open project and by a unique name or suffix in the project.":
    'Procurou em {at} a partir da pasta deste arquivo, depois pelo diretório aberto e por nome ou sufixo único no projeto.',
  '{count} project file declares {declared} in the frontmatter.':
    '{count} arquivo do projeto declara {declared} no frontmatter.',
  '{count} project files declare {declared} in the frontmatter.':
    '{count} arquivos do projeto declaram {declared} no frontmatter.',
  '{total} project files match this name; the {listed} listed ones declare {declared} in the frontmatter.':
    '{total} arquivos do projeto correspondem a esse nome; os {listed} listados declaram {declared} no frontmatter.',
  '{count} project file matches this name. | {count} project files match this name.':
    '{count} arquivo do projeto corresponde a esse nome. | {count} arquivos do projeto correspondem a esse nome.',
  "Does not exist at {at} (from this file's folder); {count} project file matches what is written.":
    'Não existe em {at} (a partir da pasta deste arquivo); {count} arquivo do projeto corresponde ao que está escrito.',
  "Does not exist at {at} (from this file's folder); {count} project files match what is written.":
    'Não existe em {at} (a partir da pasta deste arquivo); {count} arquivos do projeto correspondem ao que está escrito.',
  '{count} of them was not listed, not read. | {count} of them were not listed, not read.':
    '{count} deles não foi listado, sem leitura. | {count} deles não foram listados, sem leitura.',
  'Exists {count} level above the open project, at {at}, in the repository {repository} (with .git); the scan only checked that it exists.':
    'Existe {count} nível acima do diretório aberto, em {at}, no repositório {repository} (com .git); o leitor só conferiu a existência.',
  'Exists {count} levels above the open project, at {at}, in the repository {repository} (with .git); the scan only checked that it exists.':
    'Existe {count} níveis acima do diretório aberto, em {at}, no repositório {repository} (com .git); o leitor só conferiu a existência.',
  'The manifest declares {from} → {to}, but the reader found no explicit link to the target in {from} (a code block does not count).':
    'O manifesto declara {from} → {to}, mas o leitor não achou em {from} um link explícito para o destino (bloco de código não conta).',
  '{from} has an explicit link to {to}, both are objects of {manifest}, and none of its relations goes from one to the other.':
    '{from} tem um link explícito para {to}, os dois são objetos de {manifest}, e nenhuma relação dele vai de um para o outro.',
  '{from} has an explicit link to {to}, both are objects of a manifest, and none of its relations goes from one to the other.':
    '{from} tem um link explícito para {to}, os dois são objetos de um manifesto, e nenhuma relação dele vai de um para o outro.',
  'The reader did not read the whole source file (size, inventory limit, unread folder or type not parsed).':
    'O leitor não leu o arquivo de origem inteiro (tamanho, limite de inventário, pasta não lida ou tipo não analisado).',
  'One end of the relation does not resolve to a definite file (symlink, unverifiable absence or several candidates); no link with its other end is reported as missing from the manifest.':
    'Uma ponta da relação não se resolve num arquivo certo (link simbólico, ausência não verificável ou vários candidatos); nenhum link com a outra ponta dela é dado como fora do manifesto.',
  'Neither end of the relation resolves to a definite file; no link it could be is reported as missing from the manifest.':
    'As duas pontas da relação não se resolvem num arquivo certo; nenhum link que ela possa ser é dado como fora do manifesto.',
  'One end of the relation is not a file path (address, anchor, placeholder, variable, wildcard or a path too long).':
    'Uma ponta da relação não é caminho de arquivo (endereço, âncora, marcador, variável, curinga ou caminho longo demais).',
  'One end of the relation is an agent-architecture.json, which is not a node of another manifest.':
    'Uma ponta da relação é um agent-architecture.json, que não é nó de outro manifesto.',
  'The source file has a link the reader did not resolve (symlink, unverifiable absence or candidates beyond those listed), and it may be the one of this relation.':
    'O arquivo de origem tem um link que o leitor não resolveu (link simbólico, ausência não verificável ou candidatos além dos listados), e ele pode ser o desta relação.',
  'The source file has an ambiguous reference, and the target is among the candidates.':
    'O arquivo de origem tem uma referência ambígua, e o destino está entre os candidatos.',
  'The source file has a link to a folder the reader does not read, and the target is in it.':
    'O arquivo de origem tem um link para uma pasta que o leitor não lê, e o destino está nela.',
  'The source file writes the path of the target as a link target in a form the reader does not extract (link text over several lines, target or title on another line).':
    'O arquivo de origem escreve o caminho do destino como destino de link numa forma que o leitor não extrai (texto do link em várias linhas, destino ou título em outra linha).',
  'Some unread Markdown file of this project may declare that name in the frontmatter.':
    'Algum Markdown não lido deste projeto pode declarar esse nome no frontmatter.',
  'The listing and the existence index reached the limit; the target may be in the unlisted part.':
    'A listagem e o índice de existência atingiram o limite; o destino pode estar na parte não listada.',
  'Followed the references from {count} starting point of the project and did not get here. | Followed the references from {count} starting points of the project and did not get here.':
    'Seguiu as referências a partir de {count} ponto de partida do projeto e não chegou aqui. | Seguiu as referências a partir de {count} pontos de partida do projeto e não chegou aqui.',
  'Inconclusive: the scan of another open project is partial, and a file in it may reference this one.':
    'Não conclusivo: a leitura de outro diretório aberto é parcial, e um arquivo dele pode citá-lo.',
  'Inconclusive: the scan of this project is partial (items not listed, text not read or relations cut).':
    'Não conclusivo: a leitura deste diretório é parcial (itens não listados, texto não lido ou relações cortadas).',

  // Partial scan (src/partialReading.ts)
  'item limit': 'limite de itens',
  'text limit': 'limite de texto',
  'unreadable file': 'arquivo ilegível',
  'JSON beyond the depth read': 'JSON além da profundidade lida',
  'relation cap': 'teto de relações',
  'Partial scan ({causes}): an observation may be missing.':
    'Leitura parcial ({causes}): pode faltar observação.',
  'Partial scan: an observation may be missing.': 'Leitura parcial: pode faltar observação.',
  '{count} item not listed | {count} items not listed':
    '{count} item não listado | {count} itens não listados',
  '{count} file not read | {count} files not read':
    '{count} arquivo não lido | {count} arquivos não lidos',
  '{count} read failure | {count} read failures':
    '{count} falha de leitura | {count} falhas de leitura',
  '{count} file partly read | {count} files partly read':
    '{count} arquivo lido em parte | {count} arquivos lidos em parte',
  'relations cut': 'relações cortadas',
  '+{count} other cause | +{count} other causes': '+{count} outra causa | +{count} outras causas',
  'at least': 'pelo menos',
  'Partial scan: {count} item not listed. | Partial scan: {count} items not listed.':
    'Leitura parcial: {count} item não listado. | Leitura parcial: {count} itens não listados.',
  'Partial scan: at least {count} item not listed. | Partial scan: at least {count} items not listed.':
    'Leitura parcial: pelo menos {count} item não listado. | Leitura parcial: pelo menos {count} itens não listados.',

  // Marking observations as expected (src/ExpectedMark.tsx)
  'Mark as expected: {subject}': 'Marcar como esperada: {subject}',
  'Mark as expected': 'Marcar como esperada',
  'Reason (optional)': 'Motivo (opcional)',
  'For example: file created by the agent while running':
    'Por exemplo: arquivo criado pelo agente durante a execução',
  'Only in this app; the CLI keeps reporting it.': 'Só neste aplicativo; a CLI continua relatando.',
  'Marking…': 'Marcando…',
  'Cancel': 'Cancelar',
  'Unmark': 'Desmarcar',
  'Marked as expected on {date}: <quote>{reason}</quote>':
    'Marcada como esperada em {date}: <quote>{reason}</quote>',
  'Marked as expected on {date} (no reason)': 'Marcada como esperada em {date} (sem motivo)',
  '{action}: {subject}': '{action}: {subject}',

  // Diagnosis and the observations of a file (src/Diagnosis.tsx)
  '{words}. View diagnosis': '{words}. Ver diagnóstico',
  '{words}. Open in the Audit': '{words}. Abrir na Auditoria',
  '{listed} of {total} candidates:': '{listed} de {total} candidatos:',
  'to reference this one, write <code>{suggestion}</code>':
    'para citar este, escreva <code>{suggestion}</code>',
  'is referenced by a reachable file; referencing the folder does not reach its files.':
    'é citada por um arquivo alcançado; citar a pasta não alcança os arquivos dela.',
  'Declare in project…': 'Declarar no projeto…',
  'Create <code>agent-architecture.json</code> in the root of {name} with this content:':
    'Crie <code>agent-architecture.json</code> na raiz de {name} com este conteúdo:',
  'The <code>agent-architecture.json</code> of {name} already exists, without the <code>scope</code> key: add this snippet to the top-level object, separated by a comma.':
    'O <code>agent-architecture.json</code> de {name} já existe, sem a chave <code>scope</code>: acrescente este trecho ao objeto de nível superior, separado por vírgula.',
  'The <code>scope</code> key of the <code>agent-architecture.json</code> of {name} is invalid and is being ignored (see the manifest observation): replace its value with this object, or fix it and add the pattern, without creating another <code>scope</code> key.':
    'A chave <code>scope</code> do <code>agent-architecture.json</code> de {name} é inválida e está sendo ignorada (veja a observação de manifesto): substitua o valor dela por este objeto, ou corrija-a e acrescente o padrão, sem criar outra chave <code>scope</code>.',
  'The <code>scope</code> key of the <code>agent-architecture.json</code> of {name} is invalid and is being ignored: replace its value with this object, or fix it and add the pattern, without creating another <code>scope</code> key.':
    'A chave <code>scope</code> do <code>agent-architecture.json</code> de {name} é inválida e está sendo ignorada: substitua o valor dela por este objeto, ou corrija-a e acrescente o padrão, sem criar outra chave <code>scope</code>.',
  'The <code>agent-architecture.json</code> of {name} already has the <code>scope</code> key, with no patterns: replace its value with this object, without creating another <code>scope</code> key.':
    'O <code>agent-architecture.json</code> de {name} já tem a chave <code>scope</code>, sem padrões: substitua o valor dela por este objeto, sem criar outra chave <code>scope</code>.',
  'Add this pattern to the <code>{kind}</code> list of the <code>scope</code> key of the <code>agent-architecture.json</code> of {name}.':
    'Acrescente este padrão à lista <code>{kind}</code> da chave <code>scope</code> do <code>agent-architecture.json</code> de {name}.',
  'The <code>scope</code> key of the <code>agent-architecture.json</code> of {name} exists, without the <code>{kind}</code> list: add this snippet inside it, separated by a comma.':
    'A chave <code>scope</code> do <code>agent-architecture.json</code> de {name} existe, sem a lista <code>{kind}</code>: acrescente este trecho dentro dela, separado por vírgula.',
  'The <code>agent-architecture.json</code> of {name} is not valid JSON and is being ignored: fix the file first and click Rescan; then the diagnosis shows the snippet to add.':
    'O <code>agent-architecture.json</code> de {name} não é um JSON válido e está sendo ignorado: corrija o arquivo antes e clique em Reler; depois o diagnóstico mostra o trecho a acrescentar.',
  'Could not read the <code>agent-architecture.json</code> of {name} (symlink, permission or size): check the file and click Rescan.':
    'Não foi possível ler o <code>agent-architecture.json</code> de {name} (link simbólico, permissão ou tamanho): confira o arquivo e clique em Reler.',
  'Alternative, in project {name}:': 'Alternativa, no projeto {name}:',
  'In project {name}:': 'No projeto {name}:',
  'Open agent-architecture.json of {name}': 'Abrir agent-architecture.json de {name}',
  'Copy the scope declaration snippet for {name}':
    'Copiar o trecho da declaração de escopo para {name}',
  'Copied': 'Copiado',
  'Copy': 'Copiar',
  'Snippet copied.': 'Trecho copiado.',
  'Could not copy; select the snippet.': 'Não foi possível copiar; selecione o trecho.',
  'Declare in project': 'Declarar no projeto',
  'The path has * or ?, which the v1 scope declaration treats as a wildcard; use Mark as expected.':
    'O caminho tem * ou ?, que a declaração de escopo v1 trata como curinga; use Marcar como esperada.',
  'The v1 scope declaration cannot say that a file is not meant for the agent; use Mark as expected.':
    'A declaração de escopo v1 não tem como dizer que um arquivo não é para o agente; use Marcar como esperada.',
  'The target is:': 'O destino é:',
  '<strong>No alternative in project {name}:</strong> the path from it has * or ?.':
    '<strong>Sem alternativa no projeto {name}:</strong> o caminho a partir dele tem * ou ?.',
  'Code in aae audit: {code}': 'Código no aae audit: {code}',
  'File observations': 'Observações do arquivo',
  '{count} marked as expected | {count} marked as expected':
    '{count} marcada como esperada | {count} marcadas como esperadas',
  'Show file observations': 'Mostrar observações do arquivo',
  'Hide file observations': 'Ocultar observações do arquivo',
  'show': 'mostrar',
  'hide': 'ocultar',
  'Marked as expected': 'Marcadas como esperadas',
  'Highlight the line in the file': 'Destacar a linha no arquivo',
  'Go to line {line}': 'Ir para a linha {line}',
  'Close detail: {subject}': 'Fechar detalhe: {subject}',
  'View detail: {subject}': 'Ver detalhe: {subject}',
  '{text} · {note}': '{text} · {note}',
  'Show {count} more<span> · {left} left</span>':
    'Mostrar mais {count}<span> · faltam {left}</span>',

  // Audit tool (src/AuditPanel.tsx)
  'Problems': 'Problemas',
  'Warnings': 'Avisos',
  '[tab] Info': 'Informativos',
  'All': 'Todas',
  'Signals': 'Sinais',
  'Reference cycle': 'Ciclo de referências',
  'Repeated reference': 'Referência repetida',
  'High fan-out': 'Muitas saídas',
  '{count} does not exist | {count} do not exist': '{count} não existe | {count} não existem',
  '{count} outside open projects': '{count} fora dos diretórios abertos',
  '{count} declared outside the package | {count} declared outside the package':
    '{count} declarado fora do pacote | {count} declarados fora do pacote',
  '{count} in unread folder': '{count} em pasta não lida',
  '{count} unverified | {count} unverified': '{count} não verificado | {count} não verificados',
  '{count} missing | {count} missing': '{count} ausente | {count} ausentes',
  '{count} name without a file | {count} names without a file':
    '{count} nome sem arquivo | {count} nomes sem arquivo',
  '{count} above the open project': '{count} acima do diretório aberto',
  '[reference] {count} unverified | {count} unverified':
    '{count} não verificada | {count} não verificadas',
  '{count} ambiguous | {count} ambiguous': '{count} ambígua | {count} ambíguas',
  'Footer: {count} distinct target ({statuses}). | Footer: {count} distinct targets ({statuses}).':
    'Rodapé: {count} destino distinto ({statuses}). | Rodapé: {count} destinos distintos ({statuses}).',
  'Footer: {count} distinct target. | Footer: {count} distinct targets.':
    'Rodapé: {count} destino distinto. | Rodapé: {count} destinos distintos.',
  'Audit: {count} reference ({parts}, no target chosen). | Audit: {count} references ({parts}, no target chosen).':
    'Auditoria: {count} referência ({parts}, sem destino escolhido). | Auditoria: {count} referências ({parts}, sem destino escolhido).',
  'Audit: {count} reference ({parts}). | Audit: {count} references ({parts}).':
    'Auditoria: {count} referência ({parts}). | Auditoria: {count} referências ({parts}).',
  '{count} target whose references were all marked as expected stays out of the count and the list (see Expected). | {count} targets whose references were all marked as expected stay out of the count and the list (see Expected).':
    '{count} destino cujas referências foram todas marcadas como esperadas fica fora da contagem e da lista (veja Esperadas). | {count} destinos cujas referências foram todas marcadas como esperadas ficam fora da contagem e da lista (veja Esperadas).',
  'References with no target found': 'Referências sem destino encontrado',
  '{count} resolution by unique name or suffix | {count} resolutions by unique name or suffix':
    '{count} resolução por nome ou sufixo único | {count} resoluções por nome ou sufixo único',
  '{count} reference absorbed by the declared scope | {count} references absorbed by the declared scope':
    '{count} referência absorvida pelo escopo declarado | {count} referências absorvidas pelo escopo declarado',
  'Observation level': 'Nível das observações',
  'Opens the Expected section': 'Abre a seção Esperadas',
  '{count} expected | {count} expected': '{count} esperada | {count} esperadas',
  'Marks whose observation is not in the last scan: opens the section, where they can be removed':
    'Marcações cuja observação não está na última leitura: abre a seção, onde podem ser removidas',
  '{count} without a matching observation': '{count} sem observação correspondente',
  'Signal type': 'Tipo de sinal',
  'Observation type': 'Tipo de observação',
  'All signals': 'Todos os sinais',
  'All types': 'Todos os tipos',
  'Audit project': 'Projeto da auditoria',
  'All projects': 'Todos os projetos',
  'Only {name}': 'Só {name}',
  'Outside the observation count; they do not prove repetition at runtime.':
    'Fora da contagem de observações; não comprovam repetição na execução.',
  'No observations in {name}.': 'Nenhuma observação em {name}.',
  'No observations in this scan.': 'Nenhuma observação nesta leitura.',
  'No structural signals in this selection.': 'Nenhum sinal estrutural nesta seleção.',
  'No observations of this type.': 'Nenhuma observação deste tipo.',
  'Project: {path}': 'Projeto: {path}',
  '[audit] Outside open projects': 'Fora dos projetos abertos',
  'Only this project': 'Só este projeto',
  'No source file': 'Sem arquivo de origem',
  'Marked as expected: {subject}.': 'Marcada como esperada: {subject}.',
  'Open {path} at line {line}': 'Abrir {path} na linha {line}',
  'Open {path}': 'Abrir {path}',
  'Go to line {line} of {name}': 'Ir para a linha {line} de {name}',
  'Open {name}': 'Abrir {name}',
  'Show {count} more files<span> · {left} left</span>':
    'Mostrar mais {count} arquivos<span> · faltam {left}</span>',
  'How these numbers are counted': 'Como estes números são contados',
  'The <code>aae audit</code> counts {total}: {list}.':
    'O <code>aae audit</code> conta {total}: {list}.',
  'this observation': 'esta observação',
  'these {count} observations': 'estas {count} observações',
  '{count} marked as expected in this app | {count} marked as expected in this app':
    '{count} marcada como esperada neste app | {count} marcadas como esperadas neste app',
  '1 partial scan warning': '1 aviso de leitura parcial',
  'No path: from {count} starting point ({causes}). | No path: from {count} starting points ({causes}).':
    'Sem caminho: a partir de {count} ponto de partida ({causes}). | Sem caminho: a partir de {count} pontos de partida ({causes}).',
  '{count} orphan | {count} orphans': '{count} órfão | {count} órfãos',
  '{count} in an island | {count} in islands': '{count} em ilha | {count} em ilhas',
  '{count} exempt by the declared scope | {count} exempt by the declared scope':
    '{count} isento pelo escopo declarado | {count} isentos pelo escopo declarado',
  'No entry point: reachability was not computed.':
    'Sem ponto de entrada: a alcançabilidade não foi calculada.',
  'Declared scope by --scope': 'Escopo declarado por --scope',
  'Declared scope in {count} manifests': 'Escopo declarado em {count} manifestos',
  'Declared scope in agent-architecture.json': 'Escopo declarado em agent-architecture.json',
  '{count} pattern | {count} patterns': '{count} padrão | {count} padrões',
  'absorbs {references} and {files}': 'absorve {references} e {files}',
  '{count} reference | {count} references': '{count} referência | {count} referências',
  '{count} file | {count} files': '{count} arquivo | {count} arquivos',
  '{count} file declared as a starting point (entry or implicit load) | {count} files declared as starting points (entries or implicit loads)':
    '{count} arquivo declarado como ponto de partida (entrada ou carga implícita) | {count} arquivos declarados como pontos de partida (entradas ou cargas implícitas)',
  '{count} with no effect': '{count} sem efeito',
  '{references} · {files}': '{references} · {files}',
  '{count} reference absorbed | {count} references absorbed':
    '{count} referência absorvida | {count} referências absorvidas',
  '{count} file as a starting point | {count} files as starting points':
    '{count} arquivo como ponto de partida | {count} arquivos como pontos de partida',
  'no effect': 'sem efeito',
  'Absorbed references do not produce “Broken reference”: they appear in the relations as declared scope and are counted here. The declaration does not prove that these files will exist at runtime.':
    'Referências absorvidas não geram “Referência ausente”: aparecem nas relações como escopo declarado e são contadas aqui. A declaração não comprova que esses arquivos existirão durante a execução.',
  'Expected ({count})': 'Esperadas ({count})',
  'Source file: {path}': 'Arquivo de origem: {path}',
  'expected': 'esperada',
  'Unmarked: {subject}.': 'Desmarcada: {subject}.',
  'Hide detail: {subject}': 'Ocultar detalhe: {subject}',
  'Hide': 'Ocultar',
  'View detail': 'Ver detalhe',
  'Marks without an observation ({count})': 'Marcações sem observação ({count})',
  'In the last scan, no observation has the key of these marks: the written target, the file or the observation type changed, or it was resolved. They are not deleted on their own; remove the ones that no longer make sense.':
    'Na última leitura, nenhuma observação tem a chave destas marcações: o destino escrito, o arquivo ou o tipo da observação mudou, ou ela foi resolvida. Elas não são apagadas sozinhas; remova as que não fazem mais sentido.',
  'Remove mark': 'Remover marcação',
  'Mark removed: {subject}.': 'Marcação removida: {subject}.',
  '{title} ({target})': '{title} ({target})',
  '{what} in {where}': '{what} em {where}',
  '{count} marked as expected stays below. | {count} marked as expected stay below.':
    '{count} marcada como esperada fica abaixo. | {count} marcadas como esperadas ficam abaixo.',
  '{subject}, {note}': '{subject}, {note}',

  // Changes tool (src/ChangesPanel.tsx)
  '{count} relation | {count} relations': '{count} relação | {count} relações',
  '{count} observation | {count} observations': '{count} observação | {count} observações',
  '{count} file not compared, with {others} | {count} files not compared, with {others}':
    '{count} arquivo não comparado, com {others} | {count} arquivos não comparados, com {others}',
  '{count} file not compared | {count} files not compared':
    '{count} arquivo não comparado | {count} arquivos não comparados',
  '{others} not compared | {others} not compared':
    '{others} não comparada | {others} não comparadas',
  '{what}: was left out of the inventory or the observation cap of one of the scans. | {what}: were left out of the inventory or the observation cap of one of the scans.':
    '{what}: ficou fora do inventário ou do teto de observações de uma das leituras. | {what}: ficaram fora do inventário ou do teto de observações de uma das leituras.',
  '{what}: was left out of the inventory of one of the scans. | {what}: were left out of the inventory of one of the scans.':
    '{what}: ficou fora do inventário de uma das leituras. | {what}: ficaram fora do inventário de uma das leituras.',
  '{others} not compared: its file was analysed in only one of the scans. | {others} not compared: their files were analysed in only one of the scans.':
    '{others} não comparada: o arquivo dela foi analisado em só uma das leituras. | {others} não comparadas: os arquivos delas foram analisados em só uma das leituras.',
  'Relations and observations of {projects} not compared: the open projects, or their order, changed since the baseline.':
    'Relações e observações de {projects} não comparadas: os projetos abertos, ou a ordem deles, mudaram desde a referência.',
  'Relations and observations not compared: the open projects, or their order, changed since the baseline.':
    'Relações e observações não comparadas: os projetos abertos, ou a ordem deles, mudaram desde a referência.',
  'Relations and observations of {projects} not compared: the baseline does not record which projects were open.':
    'Relações e observações de {projects} não comparadas: a referência não registra quais projetos estavam abertos.',
  'Relations and observations not compared: the baseline does not record which projects were open.':
    'Relações e observações não comparadas: a referência não registra quais projetos estavam abertos.',
  'not compared in {projects}': 'não comparadas em {projects}',
  'not compared': 'não comparadas',
  '{count} relation added | {count} relations added':
    '{count} relação adicionada | {count} relações adicionadas',
  '{count} relation removed | {count} relations removed':
    '{count} relação removida | {count} relações removidas',
  '{count} file changed | {count} files changed':
    '{count} arquivo alterado | {count} arquivos alterados',
  '{count} file added | {count} files added':
    '{count} arquivo adicionado | {count} arquivos adicionados',
  '{count} file removed | {count} files removed':
    '{count} arquivo removido | {count} arquivos removidos',
  '{count} new observation | {count} new observations':
    '{count} observação nova | {count} observações novas',
  '{count} resolved observation | {count} resolved observations':
    '{count} observação resolvida | {count} observações resolvidas',
  'saved on disk': 'salva em disco',
  'set by you in this session': 'marcada por você nesta sessão',
  'first scan of this session': 'primeira leitura desta sessão',
  '{origin}, not saved': '{origin}, não salva',
  '--scope option': 'opção --scope',
  'none': 'nenhuma',
  'The declared scope changed between scans (source in the baseline: {before}; in the current scan: {after}): some of the new or resolved observations may come from the scope declaration, not from changes in the documents.':
    'O escopo declarado mudou entre as leituras (fonte na referência: {before}; na leitura atual: {after}): parte das observações novas ou resolvidas pode vir da declaração de escopo, não de alterações nos documentos.',
  'Showing {shown} of {total}. Each list keeps up to {limit} items; the totals count all of them.':
    'Mostrando {shown} de {total}. Cada lista guarda até {limit} itens; os totais contam todos.',
  'No open project.': 'Nenhum diretório aberto.',
  'saved on disk and of this session': 'salva em disco e desta sessão',
  'of this session': 'desta sessão',
  'Loaded from the app state: set before the server restarted.':
    'Carregada do estado do aplicativo: definida antes de o servidor reiniciar.',
  'Some projects have a baseline loaded from the app state and others one set in this session; the origin of each is below.':
    'Algumas raízes têm referência carregada do estado do aplicativo e outras definida nesta sessão; a origem de cada uma está abaixo.',
  'Set in this server session.': 'Definida nesta sessão do servidor.',
  'Set in this server session and saved in the app state: it stays valid after a restart.':
    'Definida nesta sessão do servidor e salva no estado do aplicativo: continua valendo depois de reiniciar.',
  'Baseline updated: scan from {time}.': 'Referência atualizada: leitura de {time}.',
  'content (SHA-256) · {before} → {after} bytes': 'conteúdo (SHA-256) · {before} → {after} bytes',
  'size · {before} → {after} bytes': 'tamanho · {before} → {after} bytes',
  '{bytes} bytes': '{bytes} bytes',
  '[file] added': 'adicionado',
  '[file] removed': 'removido',
  'changed': 'alterado',
  '{detail} in the baseline scan': '{detail} na leitura de referência',
  '[relation] added': 'adicionada',
  '[relation] removed': 'removida',
  'was at line {line} in the baseline scan': 'estava na linha {line} da leitura de referência',
  '· written target <code>{raw}</code>': '· destino escrito <code>{raw}</code>',
  'no file': 'sem arquivo',
  'new': 'nova',
  'resolved': 'resolvida',
  'was at {where} in the baseline scan': 'estava em {where} na leitura de referência',
  'new since the baseline, marked as expected on {date}: {reason}':
    'nova desde a referência, marcada como esperada em {date}: {reason}',
  'new since the baseline, marked as expected on {date}':
    'nova desde a referência, marcada como esperada em {date}',
  '{tone} · code in aae audit: {code}': '{tone} · código no aae audit: {code}',
  '<strong>Baseline:</strong> scan from {time}': '<strong>Referência:</strong> leitura de {time}',
  '<strong>Baseline:</strong> scan from {time} (the oldest)':
    '<strong>Referência:</strong> leitura de {time} (a mais antiga)',
  'It was not saved in the app state: valid only until the server restarts.':
    'Não foi salva no estado do aplicativo: vale só até reiniciar o servidor.',
  'not saved': 'não salva',
  '<strong>Current scan:</strong> {time}': '<strong>Leitura atual:</strong> {time}',
  'Rescan now': 'Reler agora',
  'Try saving the baseline again, which is the current scan':
    'Tentar salvar de novo a referência, que é a leitura atual',
  'The baseline is already the current scan': 'A referência já é a leitura atual',
  'Future rescans will be compared with the current scan, which is saved in the app state':
    'As próximas releituras serão comparadas com a leitura atual, que fica salva no estado do aplicativo',
  'Update baseline': 'Atualizar referência',
  '{name}: baseline from {time} ({origin})': '{name}: referência de {time} ({origin})',
  '{name}: {message}': '{name}: {message}',
  'About the baseline': 'Sobre a referência',
  'Compares the baseline scan with the latest scan of the disk; it does not say who changed anything or why.':
    'Compara a leitura de referência com a última leitura do disco; não indica quem alterou nem por quê.',
  'The first scan of each project is the baseline, which only advances through “Update baseline”. It is saved in the app state, outside the open folders and without the document text (it keeps paths, hashes, targets as written and observations), and stays valid after the server restarts; forgetting the project deletes it.':
    'A primeira leitura de cada diretório é a referência, que só avança por “Atualizar referência”. Ela fica salva no estado do aplicativo, fora das pastas abertas e sem o texto dos documentos (guarda caminhos, hashes, destinos como foram escritos e observações), e continua valendo depois de reiniciar o servidor; excluir o projeto a apaga.',
  'An observation is the same in both scans when the code, the file and the written target match, without the line number: the same identity as <code>aae compare-audit</code>.':
    'Uma observação é a mesma nas duas leituras quando coincidem o código, o arquivo e o destino escrito, sem o número da linha: a mesma identidade de <code>aae compare-audit</code>.',
  'Partial scan in {projects}: a missing observation does not prove resolution.':
    'Leitura parcial em {projects}: observação ausente não prova resolução.',
  'Partial scan: a missing observation does not prove resolution.':
    'Leitura parcial: observação ausente não prova resolução.',
  'No changes.': 'Nenhuma alteração.',
  'Files': 'Arquivos',
  '{count} changed | {count} changed': '{count} alterado | {count} alterados',
  '[file] {count} added | {count} added': '{count} adicionado | {count} adicionados',
  '[file] {count} removed | {count} removed': '{count} removido | {count} removidos',
  'no changes': 'nenhuma alteração',
  '{count} file without a comparable hash or size. | {count} files without a comparable hash or size.':
    '{count} arquivo sem hash nem tamanho comparável. | {count} arquivos sem hash nem tamanho comparáveis.',
  'Relations': 'Relações',
  '[relation] {count} added | {count} added': '{count} adicionada | {count} adicionadas',
  '[relation] {count} removed | {count} removed': '{count} removida | {count} removidas',
  'No explicit relation added or removed. Changing only the line of a reference does not count as a change.':
    'Nenhuma relação explícita adicionada ou removida. Mudar só a linha de uma referência não conta como alteração.',
  'Observations': 'Observações',
  '{count} new | {count} new': '{count} nova | {count} novas',
  '{count} resolved | {count} resolved': '{count} resolvida | {count} resolvidas',
  '{count} unchanged': '{count} sem mudança',

  // Area: dialogs, explorer, structure and filters
  // Dialogs
  'Close dialog': 'Fechar diálogo',
  'Add folder': 'Adicionar diretório',
  'The folder is saved as a project and opens alongside the current ones.':
    'A pasta fica salva como projeto e abre junto dos atuais.',
  'Folder path': 'Caminho do diretório',
  'Go': 'Navegar',
  'Up': 'Subir',
  '[listing] {count} folder | {count} folders': '{count} diretório | {count} diretórios',
  'No subfolders.': 'Nenhum subdiretório.',
  '[button] Scanning…': 'Lendo…',
  'Open this folder': 'Abrir este diretório',
  // Forgetting a project (“Excluir” in Portuguese): the × of the rows and of the root views, and its dialog
  'Forget project {name}…': 'Excluir o projeto {name} do aplicativo…',
  'Forget…': 'Excluir do aplicativo…',
  'Forget {name}?': 'Excluir {name} do aplicativo?',
  'The project leaves the app. Its Changes baseline, its marks of “expected” and its editing permission are erased. The folder and the files on disk are not touched.':
    'O projeto sai do aplicativo. A referência de Alterações, as marcações de “esperada” e a permissão de edição deste projeto são apagadas. A pasta e os arquivos no disco não são tocados.',
  'Also erase the {count} note of this project | Also erase the {count} notes of this project':
    'Apagar também a {count} anotação deste projeto | Apagar também as {count} anotações deste projeto',
  'The {count} note stays saved and comes back if you add {name} again. | The {count} notes stay saved and come back if you add {name} again.':
    'A {count} anotação fica guardada e volta se você adicionar {name} de novo. | As {count} anotações ficam guardadas e voltam se você adicionar {name} de novo.',
  'The {count} note is erased now. It cannot be recovered. | The {count} notes are erased now. They cannot be recovered.':
    'A {count} anotação é apagada agora. Não há como recuperar. | As {count} anotações são apagadas agora. Não há como recuperar.',
  '{count} note draft of this project was not saved and is discarded. | {count} note drafts of this project were not saved and are discarded.':
    '{count} rascunho de anotação deste projeto não foi salvo e é descartado. | {count} rascunhos de anotação deste projeto não foram salvos e são descartados.',
  '{count} document of this project has unsaved edits. It stays in the list of unsaved documents, only to copy: with the project out of the app, it cannot be saved to the file. | {count} documents of this project have unsaved edits. They stay in the list of unsaved documents, only to copy: with the project out of the app, they cannot be saved to the files.':
    '{count} documento deste projeto tem edição não gravada. Ele continua na lista de documentos não gravados, só para copiar: com o projeto fora do aplicativo, não pode ser gravado no arquivo. | {count} documentos deste projeto têm edição não gravada. Eles continuam na lista de documentos não gravados, só para copiar: com o projeto fora do aplicativo, não podem ser gravados nos arquivos.',
  'Forget project': 'Excluir projeto',
  'Open project': 'Abrir projeto',
  'Search saved projects': 'Buscar projetos salvos',
  'Name or folder path…': 'Nome ou caminho do diretório…',
  'Saved projects': 'Projetos salvos',
  'Opened': 'Aberto',
  'Saved · closed': 'Salvo · fechado',
  'Unavailable · check that the folder exists and can be read':
    'Indisponível · verifique se a pasta existe e pode ser lida',
  'Checking projects…': 'Consultando projetos…',
  'No project matches the search.': 'Nenhum projeto corresponde à busca.',
  'No saved projects.': 'Nenhum projeto salvo.',
  'Switch closes the other projects.': 'Trocar fecha os outros projetos.',
  'Switch': 'Trocar',
  'Working…': 'Processando…',
  'Open': 'Abrir',
  'Agent': 'Agente',
  'Tool': 'Ferramenta',
  'Policy': 'Política',
  'Workflow': 'Fluxo',
  'Document': 'Documento',
  'my-architecture': 'minha-arquitetura',
  'assistant': 'assistente',
  'context': 'contexto',
  'rules': 'regras',
  'The proposal changed while reading. Review the files again.':
    'A proposta mudou durante a leitura. Revise os arquivos novamente.',
  'Review new architecture': 'Revisar nova arquitetura',
  'New architecture': 'Nova arquitetura',
  'Each file below is created on disk; each relation becomes a Markdown link.':
    'Cada nó vira um arquivo; cada relação, um link Markdown.',
  'Parent folder': 'Diretório pai',
  'New folder name': 'Nome do novo diretório',
  '[form] Files': 'Nós',
  'file-{number}': 'no-{number}',
  'Add file': 'Adicionar nó',
  'File {number} name': 'Nome do nó {number}',
  'File {number} type': 'Tipo do nó {number}',
  'File {number} description': 'Descrição do nó {number}',
  'When to open': 'Quando abrir',
  'what this agent does and hands back; open it when you take this role.':
    'o que este agente faz e o que entrega; abra ao assumir este papel.',
  'decisions in force; read before changing what was already decided.':
    'decisões em vigor; leia antes de mudar o que já foi decidido.',
  'rules the work must follow; read before you finish a task.':
    'regras que o trabalho deve seguir; leia antes de concluir uma tarefa.',
  'Remove file {number}': 'Remover nó {number}',
  '[form] Relations': 'Relações explícitas',
  'Connect files': 'Conectar nós',
  'Relation {number} source': 'Origem da relação {number}',
  'Relation {number} type': 'Tipo da relação {number}',
  'Relation {number} target': 'Destino da relação {number}',
  'Remove relation {number}': 'Remover relação {number}',
  'references →': 'referencia →',
  'reads →': 'lê →',
  'uses →': 'usa →',
  'governs →': 'orienta →',
  'Back': 'Voltar',
  'Create and open': 'Criar e abrir',
  'Review files': 'Revisar arquivos',
  // MapFilters
  'Map filters': 'Filtros do mapa',
  'Saved filters': 'Filtros salvos',
  'New filter': 'Novo filtro',
  '{count} files · paths': '{count} arquivos · caminhos',
  '{count} files · relations': '{count} arquivos · conexões',
  'Highlight': 'Destacar',
  '[view] Highlight': 'Destaque',
  'Open view': 'Abrir vista',
  'Edit filter {name}': 'Editar filtro {name}',
  'Delete filter {name}': 'Excluir filtro {name}',
  'Filter name': 'Nome do filtro',
  'E.g. CLAUDE relations': 'Ex.: Conexões do CLAUDE',
  'Show': 'Mostrar',
  'Filter type': 'Tipo de filtro',
  'File relations': 'Conexões dos arquivos',
  'Paths between files': 'Caminhos entre os arquivos',
  'Direction': 'Direção',
  'Filter direction': 'Direção do filtro',
  'Both directions': 'Ambos os sentidos',
  'Incoming and outgoing': 'Entradas e saídas',
  'Follow arrows': 'Seguir setas',
  'Outgoing only': 'Somente saídas',
  'Incoming only': 'Somente entradas',
  'Union of one shortest path per pair. Intermediate files are included; arrows keep their original direction.':
    'União de um menor caminho por par. Arquivos intermediários são incluídos; as setas mantêm a direção original.',
  'Filter files': 'Arquivos do filtro',
  'Remove {path} from the filter': 'Remover {path} do filtro',
  'Add files': 'Adicionar arquivos',
  'Search file for filter': 'Buscar arquivo para filtro',
  'Name or path, e.g. CLAUDE.md': 'Nome ou caminho, ex.: CLAUDE.md',
  'Filter search results': 'Resultados para filtro',
  'No other file matches the search.': 'Nenhum outro arquivo corresponde à busca.',
  '{count} results. Narrow the search to see other paths.':
    '{count} resultados. Refine a busca para ver outros caminhos.',
  '{count} target not found | {count} targets not found':
    '{count} citado não encontrado | {count} citados não encontrados',
  'First {limit} of {count}. Narrow the search.': 'Primeiros {limit} de {count}. Refine a busca.',
  'Include scope conventions': 'Incluir convenções de escopo',
  'Filters are saved in this browser.': 'Filtros salvos neste navegador.',
  'Select at least two files.': 'Selecione ao menos dois arquivos.',
  '{count} file selected | {count} files selected':
    '{count} arquivo selecionado | {count} arquivos selecionados',
  'Save and highlight': 'Salvar e destacar',
  'Save and open view': 'Salvar e abrir vista',
  '{count} element | {count} elements': '{count} elemento | {count} elementos',
  'partial result': 'resultado parcial',
  '{kind} · {direction} · {scope}.': '{kind} · {direction} · {scope}.',
  'One shortest path per pair': 'Um menor caminho por par',
  'Direct relations': 'Conexões diretas',
  'both directions': 'ambos os sentidos',
  'incoming': 'entradas',
  'following the arrows': 'seguindo as setas',
  'includes conventions': 'inclui convenções',
  'explicit references': 'referências explícitas',
  'No relation found.': 'Nenhuma conexão encontrada.',
  'Partial result: limit of {limit} elements, 600 relation pairs or search budget reached. {omitted} relations/paths omitted. Refine the filter; the paths shown stay complete.':
    'Resultado parcial: limite de {limit} elementos, 600 pares de conexão ou orçamento de busca atingido. {omitted} conexões/caminhos omitidos. Refine o filtro; caminhos exibidos permanecem completos.',
  '{count} relation followed in reverse. | {count} relations followed in reverse.':
    '{count} relação percorrida no sentido inverso. | {count} relações percorridas no sentido inverso.',
  'File outside the open folders: <code>{path}</code>':
    'Arquivo fora dos diretórios abertos: <code>{path}</code>',
  'No path: <code>{from}</code> {arrow} <code>{to}</code>':
    'Sem caminho: <code>{from}</code> {arrow} <code>{to}</code>',
  '{count} more pairs without a path. Refine the filter.':
    'Mais {count} pares sem caminho. Refine o filtro.',
  'Partial scan: a relation may be missing.': 'Leitura parcial: pode faltar relação.',
  'Filter files:': 'Arquivos do filtro:',
  'Filter view {name}': 'Vista do filtro {name}',
  'Filtered view': 'Vista filtrada',
  'Close view {name}': 'Fechar vista {name}',
  'Close highlight {name}': 'Fechar destaque {name}',
  // fileClasses
  'Skills': 'Skills',
  'Manifests': 'Manifestos',
  'Other': 'Outros',
  // Explorer
  'Close: closes the project; it stays saved, with its notes and the Changes baseline.':
    'Remover da tela: fecha o projeto; ele continua salvo, com anotações e a referência de Alterações.',
  'Collapse folder {name}': 'Recolher pasta {name}',
  'Expand folder {name}': 'Expandir pasta {name}',
  'Folder with its own instructions (AGENTS.md or CLAUDE.md): opens a view next to the parent view':
    'Pasta com instruções próprias (AGENTS.md ou CLAUDE.md): abre uma vista ao lado da do pai',
  'instructions': 'instruções',
  '{name} is now project {position} of {count}.':
    '{name} agora é o {position}º de {count} projetos.',
  'Could not change the project order: {message} The previous order was kept.':
    'Não foi possível mudar a ordem dos projetos: {message} A ordem anterior foi mantida.',
  'Search files': 'Buscar arquivos',
  'Search files…': 'Buscar arquivos…',
  'Clear search': 'Limpar busca',
  'Skills and objects': 'Skills e objetos',
  'Logical objects: skills (folders with SKILL.md) and objects declared in agent-architecture.json':
    'Objetos lógicos: skills (pastas com SKILL.md) e objetos declarados em agent-architecture.json',
  'Filter files by class': 'Filtrar arquivos por classe',
  'File class': 'Classe dos arquivos',
  'Filters the tree and the Structure by file class':
    'Filtra a árvore e a Estrutura pela classe do arquivo',
  '[files] All': 'Todos',
  'Only files with Audit observations (problems, warnings or info)':
    'Só arquivos com observações da Auditoria (problemas, avisos ou informativos)',
  'With observations': 'Com observações',
  'Clear class filter': 'Limpar filtro de classe',
  'first {limit}': 'primeiros {limit}',
  'No file matches the search.': 'Nenhum arquivo corresponde à busca.',
  'No logical objects.': 'Nenhum objeto lógico.',
  'Open a folder to explore its files.': 'Abra um diretório para explorar seus arquivos.',
  'Open projects': 'Projetos abertos',
  'Dismiss project order error': 'Dispensar erro da ordem dos projetos',
  'Project {name}': 'Projeto {name}',
  'Reorder {name} ({position} of {count}): drag, or use the up and down arrows':
    'Reordenar {name} ({position}º de {count}): arraste ou use as setas para cima e para baixo',
  'Drag to reorder (or ↑ and ↓)': 'Arraste para mudar a ordem (ou ↑ e ↓)',
  'Expand project {name}': 'Expandir projeto {name}',
  'Collapse project {name}': 'Recolher projeto {name}',
  'Back to project {name}': 'Voltar ao diretório {name}',
  'Actions for project {name}': 'Ações do projeto {name}',
  'Order and removal': 'Ordem e remoção',
  'Move {name} up': 'Mover {name} para cima',
  'Move {name} down': 'Mover {name} para baixo',
  'Move up': 'Mover para cima',
  'Move down': 'Mover para baixo',
  'Close': 'Remover da tela',
  'Close {name}': 'Remover {name} da tela',
  // Home: the list of projects
  'Home': 'Início',
  'Home: the list of projects': 'Início: a lista de projetos',
  'Projects': 'Projetos',
  '{count} open project | {count} open projects':
    '{count} projeto aberto | {count} projetos abertos',
  'folder': 'pasta',
  'files': 'arquivos',
  'Saved and closed · {count}': 'Salvos e fechados · {count}',
  'Show project {name}': 'Mostrar o projeto {name}',
  'Open project {name}': 'Abrir projeto {name}',
  'Show its structure': 'Mostrar a estrutura dele',
  'Open this project': 'Abrir este projeto',
  'The folder no longer exists or cannot be read': 'A pasta não existe mais ou não pode ser lida',
  'unavailable': 'indisponível',
  '{count} instruction file | {count} instruction files':
    '{count} arquivo de instruções | {count} arquivos de instruções',
  'No AGENTS.md or CLAUDE.md': 'Nenhum AGENTS.md ou CLAUDE.md',
  'Minimize: the view goes to the Views strip; the project stays open and scanned':
    'Minimizar: a vista vai para a barra de vistas; o projeto continua aberto e lido',
  '↳ {parent} · +{count} level | ↳ {parent} · +{count} levels':
    '↳ {parent} · +{count} nível | ↳ {parent} · +{count} níveis',
  'No files from this filter in this project.': 'Nenhum arquivo deste filtro neste projeto.',
  'Drop to place {name} at position {position} of {count} · Esc cancels':
    'Solte para colocar {name} na posição {position} de {count} · Esc cancela',
  'Drag {name} above or below another project · Esc cancels':
    'Arraste {name} acima ou abaixo de outro projeto · Esc cancela',
  // StructureView
  'not followed': 'não seguido',
  'Symbolic link listed without following its target.':
    'Link simbólico listado sem seguir o destino.',
  'partly read': 'lido em parte',
  'Text partly read: the limits are in the Audit.':
    'Texto lido em parte: os limites estão na Auditoria.',
  'not read': 'não lido',
  'Text listed but not read: size limit or read failure (see the Audit).':
    'Texto listado, mas não lido: limite de tamanho ou falha de leitura (consulte a Auditoria).',
  'Type not read ({extension}): the reader only looks for references in {extensions}. Other files can still be referenced.':
    'Tipo não lido ({extension}): o leitor só procura referências em {extensions}. Outros arquivos ainda podem ser citados.',
  'no extension': 'sem extensão',
  'The number is a minimum: the count beyond the limit also stopped.':
    'O número é um mínimo: a contagem fora do limite também parou.',
  'The number is a minimum: what is inside a folder with an unreadable name is not counted.':
    'O número é um mínimo: o que há dentro de uma pasta de nome ilegível não é contado.',
  'see the folder observation': 'veja a observação da pasta',
  'There may be observations missing here, and references into it are checked for existence only.':
    'Pode faltar observação aqui, e referências para dentro dela são conferidas só por existência.',
  'The item limit stopped before this folder: nothing in it was listed or read. {limitWords} Open it as a project to read it.':
    'O limite de itens parou antes desta pasta: nada dela foi listado nem lido. {limitWords} Abra-a como diretório para lê-la.',
  'Nothing in this folder entered the scan: there is a name that is not valid UTF-8 ({see}), and the item limit left the rest out. {limitWords} Open it as a project to read it.':
    'Nada desta pasta entrou na leitura: há nome que não é UTF-8 válido ({see}), e o limite de itens deixou o resto fora. {limitWords} Abra-a como diretório para lê-la.',
  'Nothing in this folder entered the scan: the reader could not read the folder or the names in it ({see}). There may be observations missing here.':
    'Nada desta pasta entrou na leitura: o leitor não conseguiu ler a pasta ou os nomes nela ({see}). Pode faltar observação aqui.',
  '[folder] not read': 'não lida',
  'not read · at least {count} item on disk | not read · at least {count} items on disk':
    'não lida · pelo menos {count} item no disco | não lida · pelo menos {count} itens no disco',
  'not read · {count} item on disk | not read · {count} items on disk':
    'não lida · {count} item no disco | não lida · {count} itens no disco',
  'The item limit stopped in the middle of this folder: part of the items was neither listed nor read. {limitWords} Open it as a project to read all of it.':
    'O limite de itens parou no meio desta pasta: parte dos itens não foi listada nem lida. {limitWords} Abra-a como diretório para lê-la inteira.',
  'Part of the items in this folder was left out of the scan: the item limit stopped in the middle of it, and there is a name that is not valid UTF-8 ({see}). {limitWords} Open it as a project to read all of it.':
    'Parte dos itens desta pasta ficou fora da leitura: o limite de itens parou no meio dela, e há nome que não é UTF-8 válido ({see}). {limitWords} Abra-a como diretório para lê-la inteira.',
  'There is a name in this folder that is not valid UTF-8: that item was left out of the scan ({see}). There may be observations missing here.':
    'Há nome nesta pasta que não é UTF-8 válido: esse item ficou fora da leitura ({see}). Pode faltar observação aqui.',
  'partly read · at least {count} item left out | partly read · at least {count} items left out':
    'lida em parte · pelo menos {count} item fora | lida em parte · pelo menos {count} itens fora',
  'partly read · {count} item left out | partly read · {count} items left out':
    'lida em parte · {count} item fora | lida em parte · {count} itens fora',
  'Hide contents of {name}': 'Ocultar conteúdo de {name}',
  'Show contents of {name}': 'Mostrar conteúdo de {name}',
  'Hide contents': 'Ocultar conteúdo',
  'Show contents here': 'Mostrar conteúdo aqui',
  "Open this folder's structure": 'Abrir a estrutura desta pasta',
  'Select and open in the inspector': 'Selecionar e abrir no inspetor',
  '{count} item | {count} items': '{count} item | {count} itens',
  'empty': 'vazia',
  'Folder with its own entry point: opening it shows a view of it next to the parent folder view':
    'Pasta com entrada própria: ao abri-la, uma vista dela aparece ao lado da vista do diretório pai',
  'own {names} | own {names}': '{names} próprio | {names} próprios',
  'points to {count} file | points to {count} files':
    'aponta para {count} arquivo | aponta para {count} arquivos',
  'points to: {state}': 'aponta para: {state}',
  'Points to {count} file (distinct) | Points to {count} files (distinct)':
    'Aponta para {count} arquivo (distintos) | Aponta para {count} arquivos (distintos)',
  'referenced by {count} file | referenced by {count} files':
    'citado por {count} arquivo | citado por {count} arquivos',
  'Referenced by {count} file (distinct) | Referenced by {count} files (distinct)':
    'Citado por {count} arquivo (distintos) | Citado por {count} arquivos (distintos)',
  'Show more ({count})': 'Mostrar mais ({count})',
  'Structure of {name}': 'Estrutura de {name}',
  'The filter above the tree applies to the tree and the Structure; the map does not change':
    'O filtro acima da árvore vale para a árvore e a Estrutura; o mapa não muda',
  '{filter}: {files} in this folder and its subfolders (of {total})':
    '{filter}: {files} nesta pasta e nas subpastas (de {total})',
  'Class filter': 'Filtro de classe',
  '{count} folder | {count} folders': '{count} pasta | {count} pastas',
  'Read for references: {extensions}': 'Lidos em busca de referências: {extensions}',
  '{count} read | {count} read': '{count} lido | {count} lidos',
  'class': 'classe',
  'points to': 'aponta para',
  'referenced by': 'citado por',
  'observations': 'observações',
  'Distinct files the item points to, not counting the file itself':
    'Arquivos para os quais o item aponta, em arquivos distintos, sem contar o próprio arquivo',
  'Distinct files that reference the item, not counting the file itself':
    'Arquivos que citam o item, em arquivos distintos, sem contar o próprio arquivo',
  'Problems and warnings of the Audit about the item':
    'Problemas e avisos da Auditoria sobre o item',
  'Problems and warnings of the Audit in the files of the project':
    'Problemas e avisos da Auditoria nos arquivos do projeto',
  'Folder above: {name}': 'Pasta acima: {name}',
  'No item of this class filter in this folder. Clear the filter above the tree to see all.':
    'Nenhum item deste filtro de classe nesta pasta. Limpe o filtro acima da árvore para ver todos.',
  'Folder {label}. {details}': 'Pasta {label}. {details}',
  'Empty folder.': 'Pasta vazia.',

  // Header line of a map and the selected card (src/MapHeader.tsx, src/Canvas.tsx)
  'Context of the file': 'Contexto do arquivo',
  'Trace + context': 'Caminho + contexto',
  'Only the filter': 'Somente o filtro',
  'Filter highlighted · other relations dimmed': 'Filtro em destaque · demais conexões atenuadas',
  'Items of this folder': 'Itens deste diretório',
  'Entry points': 'Pontos de entrada',
  '+{count} in the inspector': '+{count} no inspetor',
  'Elements and relations drawn in this view': 'Elementos e relações desenhados nesta vista',
  'Elements and relations drawn in this view; +{count}: items of this folder outside the map, listed in the inspector':
    'Elementos e relações desenhados nesta vista; +{count}: itens deste diretório fora do mapa, listados no inspetor',
  'Elements and relations drawn in this view; +{count}: relations of the file in focus with elements outside the map, listed in the inspector':
    'Elementos e relações desenhados nesta vista; +{count}: relações do arquivo em foco com elementos fora do mapa, listadas no inspetor',
  'Map legend': 'Legenda do mapa',
  'Legend': 'Legenda',
  'Reference direction': 'Direção da referência',
  'Convention / hierarchy': 'Convenção / hierarquia',
  'Thicker arrow: more references': 'Seta mais grossa: mais referências',
  'Zoom of the map': 'Zoom do mapa',
  'Zoom out of the map': 'Afastar mapa',
  'Zoom in on the map': 'Aproximar mapa',
  'Zoom {percent}': 'Zoom {percent}',
  'Fit': 'Enquadrar',
  'Fit the map': 'Enquadrar mapa',
  'Part of the map out of view': 'Parte do mapa fora da vista',
  'Part of the map out of view · Fit': 'Parte do mapa fora da vista · Enquadrar',
  'Part of the map out of view. The automatic framing shows every column; the rows that do not fit in this view stay below. Fit shows the whole map, smaller.':
    'Parte do mapa fora da vista. O enquadramento automático mostra todas as colunas; as linhas que não cabem nesta vista ficam abaixo. Enquadrar mostra o mapa inteiro, menor.',
  'Focus selection': 'Focar seleção',
  'More map controls': 'Mais controles do mapa',
  'Controls and counts of the map that have no room on this line':
    'Controles e contagens do mapa que não cabem nesta linha',
  'Open inspector': 'Abrir inspetor',
  'Text, relations and evidence of this file in the inspector (Enter on the card)':
    'Texto, relações e evidências deste arquivo no inspetor (Enter no cartão)',

  // Map of a folder (src/Canvas.tsx, src/FolderMap.tsx, src/ScopeWorkspace.tsx)
  'Map: the references between the items of this folder, summed':
    'Mapa: as referências entre os itens desta pasta, somadas',
  'Summed references between the items of {folder}':
    'Referências somadas entre os itens de {folder}',
  'References written in files of this folder: between its items (the arrows), to outside it (the box at the end) and inside one item (on its card); from outside: references written in other files to this folder or its items (the box at the start)':
    'Referências escritas em arquivos desta pasta: entre os itens (as setas), para fora dela (o quadro do fim) e dentro de um item (no cartão dele); de fora: referências escritas em outros arquivos para esta pasta ou para os itens dela (o quadro do início)',
  '{count} from outside | {count} from outside': '{count} de fora | {count} de fora',
  '{count} between items | {count} between items': '{count} entre itens | {count} entre itens',
  '{count} outside | {count} outside': '{count} para fora | {count} para fora',
  '{count} inside folders | {count} inside folders':
    '{count} dentro de pastas | {count} dentro de pastas',
  '{count} inside items | {count} inside items':
    '{count} dentro de itens | {count} dentro de itens',
  '{count} with items not drawn | {count} with items not drawn':
    '{count} com itens fora do mapa | {count} com itens fora do mapa',
  'Partial scan: the sums may be incomplete': 'Leitura parcial: as somas podem estar incompletas',
  'Instructions of this folder': 'Instruções desta pasta',
  'Reference without being referenced': 'Citam sem ser citados',
  'Reference and are referenced': 'Citam e são citados',
  'Reference other items': 'Citam outros itens',
  'Referenced by other items': 'Citados por outros itens',
  'Others that reference': 'Outros que citam',
  'Other items': 'Outros itens',
  'Referenced directly': 'Citados diretamente',
  'Referenced in {steps} steps': 'Citados em {steps} passos',
  'Referenced in {from} to {to} steps': 'Citados em {from} a {to} passos',
  'symbolic link': 'link simbólico',
  '{count} internal | {count} internal': '{count} interna | {count} internas',
  '{count} to itself | {count} to itself': '{count} para si mesmo | {count} para si mesmo',
  'own {name}': '{name} próprio',
  'own {first} and {second}': '{first} e {second} próprios',
  '{incoming} from other items · {outgoing} to other items':
    '{incoming} de outros itens · {outgoing} para outros itens',
  '{count} written reference from files of {source} to files of {target} | {count} written references from files of {source} to files of {target}':
    '{count} referência escrita de arquivos de {source} para arquivos de {target} | {count} referências escritas de arquivos de {source} para arquivos de {target}',
  '{count} written reference from files of {source} to {target} | {count} written references from files of {source} to {target}':
    '{count} referência escrita de arquivos de {source} para {target} | {count} referências escritas de arquivos de {source} para {target}',
  '{count} written reference from {source} to files of {target} | {count} written references from {source} to files of {target}':
    '{count} referência escrita de {source} para arquivos de {target} | {count} referências escritas de {source} para arquivos de {target}',
  '{count} written reference from {source} to {target} | {count} written references from {source} to {target}':
    '{count} referência escrita de {source} para {target} | {count} referências escritas de {source} para {target}',
  'This folder points to': 'Esta pasta aponta para',
  'This folder (.)': 'Este diretório (.)',
  'Elsewhere in this project': 'Em outro lugar deste projeto',
  'Another open project: {project}': 'Outro projeto aberto: {project}',
  'Other open projects': 'Outros projetos abertos',
  '[map] Outside open projects': 'Fora dos projetos abertos',
  '+{count} other destination | +{count} other destinations':
    '+{count} outro destino | +{count} outros destinos',
  'from {names}': 'de {names}',
  'from {first}, {second} and {count} more': 'de {first}, {second} e mais {count}',
  'Point to this folder': 'Apontam para esta pasta',
  'To this folder (.)': 'Para este diretório (.)',
  '+{count} other source | +{count} other sources':
    '+{count} outra origem | +{count} outras origens',
  'to {names}': 'para {names}',
  'to {first}, {second} and {count} more': 'para {first}, {second} e mais {count}',
  'References of the arrow': 'Referências da seta',
  'Close the references of the arrow': 'Fechar as referências da seta',
  '{file} · line {line}': '{file} · linha {line}',
  'Show {count} more · {left} left': 'Mostrar mais {count} · faltam {left}',
  'Items without a card': 'Itens sem cartão',
  'Fold the line': 'Recolher a linha',
  'Show the line': 'Mostrar a linha',
  'Not linked · {count}': 'Sem ligação · {count}',
  'Linked items left out of the map by its limit of {limit} cards':
    'Itens com referências que ficaram fora do mapa pelo limite de {limit} cartões',
  'Items left out of the map by its limit of {limit} cards':
    'Itens que ficaram fora do mapa pelo limite de {limit} cartões',
  '+{count} item | +{count} items': '+{count} item | +{count} itens',
  '{count} reference not drawn | {count} references not drawn':
    '{count} referência não desenhada | {count} referências não desenhadas',
  'Not linked to other items of this folder': 'Sem ligação com outros itens desta pasta',
  '+{count} more | +{count} more': 'mais {count} | mais {count}',
  'Arrow without a number: 1 reference': 'Seta sem número: 1 referência',
  '{count} arrow not drawn | {count} arrows not drawn':
    '{count} seta não desenhada | {count} setas não desenhadas',
  '{count} number not drawn | {count} numbers not drawn':
    '{count} número não desenhado | {count} números não desenhados',
  'Drawn while the pointer or the keyboard focus is on one of their items':
    'Desenhadas enquanto o ponteiro ou o foco do teclado está num dos itens delas',
  'This folder has no items in this scan.': 'Esta pasta não tem itens nesta leitura.',
  'No references between the items of this folder.':
    'Nenhuma referência entre os itens desta pasta.',
  'None of its files was read for references.':
    'Nenhum dos arquivos dela foi lido em busca de referências.',

  // Estrutura › folder rows (src/StructureView.tsx)
  'references {count} file outside the folder | references {count} files outside the folder':
    'aponta para {count} arquivo fora da pasta | aponta para {count} arquivos fora da pasta',
  'Files of this folder reference {count} file outside it (distinct) | Files of this folder reference {count} files outside it (distinct)':
    'Arquivos desta pasta citam {count} arquivo fora dela (distintos) | Arquivos desta pasta citam {count} arquivos fora dela (distintos)',
  'referenced by {count} file outside the folder | referenced by {count} files outside the folder':
    'citado por {count} arquivo fora da pasta | citado por {count} arquivos fora da pasta',
  '{count} file outside this folder references files of it (distinct) | {count} files outside this folder reference files of it (distinct)':
    '{count} arquivo fora desta pasta cita arquivos dela (distintos) | {count} arquivos fora desta pasta citam arquivos dela (distintos)',

  // Help › Atalhos (src/Help.tsx)
  'Ctrl+O opens a saved project · Ctrl+K searches files · Ctrl+B or the button in the top bar shows or hides the explorer · Alt+←/→ goes back and forward. The More menu hides and shows the panels and switches the theme. The dividers accept dragging and arrow keys; double-click restores the size.':
    'Ctrl+O abre um projeto salvo · Ctrl+K busca arquivos · Ctrl+B ou o botão da barra de cima mostra ou recolhe o explorador · Alt+←/→ volta e avança. O menu Mais recolhe e devolve os painéis e troca o tema. As divisórias aceitam arraste e as setas; clique duplo restaura o tamanho.',

  // Help › Estrutura e Mapa (src/Help.tsx)
  'The Structure lists folders and files with the class, how many files each one references (points to), how many reference it (referenced by) and the observations; clicking a file opens the inspector. In the Map, double-click. The Map of a folder sums the references between its items; the number on an arrow opens the list.':
    'A Estrutura lista pastas e arquivos com a classe, quantos arquivos cada um cita (aponta para), quantos o citam (citado por) e as observações; clicar num arquivo abre o inspetor. No Mapa, clique duas vezes. O Mapa de uma pasta soma as referências entre os itens dela; o número na seta abre a lista.',
  'The house button shows <b>Home</b>: the list of projects. On a view, <b>–</b> hides it (the project stays open and scanned); <b>Close</b>, in the project menu of the tree, closes the project (it stays saved); <b>×</b>, on a row of Home or in Open project, forgets it: it leaves the app, after a confirmation.':
    'O botão da casinha mostra o <b>Início</b>: a lista de projetos. Numa vista, <b>–</b> a oculta (o projeto continua aberto e lido); <b>Remover da tela</b>, no menu do projeto na árvore, fecha o projeto (ele continua salvo); <b>×</b>, numa linha do Início ou em Abrir projeto, o exclui do aplicativo, depois de uma confirmação.',
  'A folder with its own AGENTS.md or CLAUDE.md opens a view beside its parent’s; with two or more, each view has a header with Structure | Map, <b>Minimize</b> (kept in the Views strip) and <b>Close view</b> (subfolder or filter).':
    'Uma pasta com AGENTS.md ou CLAUDE.md próprio abre uma vista ao lado da do pai; com duas ou mais, cada vista tem cabeçalho com Estrutura | Mapa, <b>Minimizar</b> (guarda nas abas de baixo) e <b>Fechar vista</b> (subpasta ou filtro).',
  // Top bar › Reler (src/App.tsx)
  'Reads the files on disk again; the app does not rescan by itself, except after saving a document in the editor.':
    'Lê de novo os arquivos do disco; o app não relê sozinho, salvo depois de gravar um documento pelo editor.',

  // Help (src/Help.tsx)
  '<b>Edit</b> makes a Markdown file editable; the first time, it asks to turn editing on in the project, which the bottom bar turns off. <b>Save</b> (Ctrl+S) writes at once, never over a file changed on disk. <b>Show changes</b> marks added and removed lines. <b>Undo</b> reverts the last save.':
    '<b>Editar</b> torna editável um arquivo Markdown; na primeira vez, pede para ligar a edição do projeto, que a barra inferior desliga. <b>Gravar</b> (Ctrl+S) grava na hora, nunca por cima de um arquivo mudado no disco. <b>Ver mudanças</b> marca as linhas incluídas e excluídas. <b>Desfazer</b> volta a última gravação.',

  // Window: top bar, strip, notices, bottom bar and its tools (src/App.tsx)
  'Trace between files': 'Caminho entre arquivos',
  'Audit of references': 'Auditoria de referências',
  'Changes between scans': 'Alterações entre leituras',
  'Changes since the baseline': 'Alterações desde a referência',
  'Dismiss notice': 'Dispensar aviso',
  '{count} notice | {count} notices': '{count} aviso | {count} avisos',
  'Status': 'Estado',
  'Scan status that does not fit in the bar': 'Estado da leitura que não cabe na barra',
  '{parsed} of {total} file read | {parsed} of {total} files read':
    '{parsed} de {total} arquivo lido | {parsed} de {total} arquivos lidos',
  '{parsed} of at least {total} file read | {parsed} of at least {total} files read':
    '{parsed} de pelo menos {total} arquivo lido | {parsed} de pelo menos {total} arquivos lidos',
  '{total} relation | {total} relations': '{total} relação | {total} relações',
  'Class filter and with observations': 'Filtro de classe e com observações',
  'Filter with observations': 'Filtro com observações',
  '[selection] Back': 'Voltar seleção',
  'Back (Alt+←)': 'Voltar (Alt+←)',
  '[selection] Forward': 'Avançar seleção',
  'Forward (Alt+→)': 'Avançar (Alt+→)',
  'Location': 'Localização',
  '{count} folder in between | {count} folders in between':
    '{count} pasta intermediária | {count} pastas intermediárias',
  'Rescan projects': 'Reler diretórios',
  'Open, add or create a project': 'Abrir, adicionar ou criar um projeto',
  'No saved project yet: start with Add folder':
    'Nenhum projeto salvo ainda: comece por Adicionar diretório',
  'Dismiss error': 'Dispensar erro',
  'View limits': 'Ver limites',
  'Since the baseline: {changes}. Open Changes': 'Desde a referência: {changes}. Abrir Alterações',
  'Since the baseline: {changes}': 'Desde a referência: {changes}',
  'Dismiss the changes notice': 'Dispensar aviso de alterações',
  '{name} closed': '{name} saiu da tela',
  'Reopen': 'Reabrir',
  'Dismiss the closed-project notice': 'Dispensar aviso de projeto removido',
  'Connecting…': 'Conectando…',
  'Explorer width': 'Largura do explorador',
  'Add the folder of an agent (AGENTS.md, CLAUDE.md, skills, memory) to see the structure, the references and the observations.':
    'Adicione a pasta de um agente (AGENTS.md, CLAUDE.md, skills, memória) para ver a estrutura, as referências e as observações.',
  'Bottom panel height': 'Altura do painel inferior',
  'Hide bottom panel': 'Recolher painel inferior',
  'Inspector width': 'Largura do inspetor',
  '[close] Hide inspector': 'Fechar inspetor',
  'Tools': 'Ferramentas',
  '{changes} since the baseline scan': '{changes} desde a leitura de referência',
  'No change since the baseline scan': 'Nenhuma alteração desde a leitura de referência',
  'Create and manage filters': 'Criar e gerenciar filtros',
  'Conventions are set when editing the filter': 'Convenções são definidas ao editar o filtro',
  'Include scope conventions in the folder map':
    'Incluir convenções de escopo no mapa de diretórios',
  'Conventions': 'Convenções',
  'Scanning…': 'Lendo arquivos…',
  'Ready': 'Pronto',
  '{count} project | {count} projects': '{count} diretório | {count} diretórios',
  'Partial scan: {cause}': 'Leitura parcial: {cause}',
  'Files read for references, out of all those listed (without folders or symbolic links). In a scan cut by the item limit, the total adds the files left out':
    'Arquivos lidos em busca de referências, de todos os listados (sem diretórios nem links simbólicos). Numa leitura cortada pelo limite de itens, o total soma os arquivos que ficaram de fora',
  '{total} target not found | {total} targets not found':
    '{total} citado não encontrado | {total} citados não encontrados',
  '(+{count} expected) | (+{count} expected)': '(+{count} esperado) | (+{count} esperados)',
  'Not in this count: {count} target whose references were all marked as expected. Opens in the Audit the references without a target found (missing, names without a file and ambiguous), with file and line. | Not in this count: {count} targets whose references were all marked as expected. Opens in the Audit the references without a target found (missing, names without a file and ambiguous), with file and line.':
    'Fora desta contagem: {count} destino cujas referências foram todas marcadas como esperadas. Abre na Auditoria as referências sem destino encontrado (ausentes, nomes sem arquivo e ambíguas), com arquivo e linha. | Fora desta contagem: {count} destinos cujas referências foram todas marcadas como esperadas. Abre na Auditoria as referências sem destino encontrado (ausentes, nomes sem arquivo e ambíguas), com arquivo e linha.',
  'Opens in the Audit the references without a target found (missing, names without a file and ambiguous), with file and line.':
    'Abre na Auditoria as referências sem destino encontrado (ausentes, nomes sem arquivo e ambíguas), com arquivo e linha.',
  'All the relations of the scan: each reference counts, with its line, including repeats and self-references; relations declared in a manifest and scope conventions count here even with Conventions off':
    'Todas as relações da leitura: cada citação conta, com sua linha, inclusive repetidas e autorreferências; relações declaradas em manifesto e convenções de escopo entram aqui mesmo com Convenções desligado',
  'Read-only': 'Somente leitura',

  // Trace: the fields A and B, the result (src/App.tsx)
  'Source file A': 'Arquivo de origem A',
  'Target file B': 'Arquivo de destino B',
  'Source: path of the file': 'Origem: caminho do arquivo',
  'Target: path of the file': 'Destino: caminho do arquivo',
  'Absolute path or relative to an open project, with or without its name at the start':
    'Caminho absoluto ou relativo a um diretório aberto, com ou sem o nome dele no início',
  '{count} files match this path. Choose one:':
    '{count} arquivos correspondem a este caminho. Escolha um:',
  'No file at this path.': 'Nenhum arquivo neste caminho.',
  'With that ending:': 'Com esse final:',
  'Trace direction': 'Direção do caminho',
  '[action] Trace': 'Traçar',
  'Trace found · {count} step | Trace found · {count} steps':
    'Caminho encontrado · {count} passo | Caminho encontrado · {count} passos',
  'Structural relation in both directions': 'Conexão estrutural em ambos os sentidos',
  'Closes the view of the trace; the other views come back as they were':
    'Fecha a vista do caminho; as outras vistas voltam como estavam',
  'reverse direction': 'sentido inverso',
  'No trace following the arrows.': 'Nenhum caminho seguindo as setas.',
  'No trace found between these files in the open projects.':
    'Nenhum caminho encontrado entre estes arquivos nos diretórios abertos.',

  // Inspector: a folder, a file, its tabs (src/App.tsx)
  'Only the lines shown are on the page: the browser search (Ctrl+F) and copying do not reach the others.':
    'Só as linhas mostradas estão na página: a busca do navegador (Ctrl+F) e o copiar não alcançam as demais.',
  'Line {line} does not exist in the version of the file on disk, which ends at line {last}: it changed after the scan. Rescan the projects.':
    'A linha {line} não existe na versão do arquivo no disco, que termina na linha {last}: ele mudou depois da leitura. Releia os diretórios.',
  'Show {count} earlier · {left} left': 'Mostrar {count} anteriores · faltam {left}',
  '(item limit: {fix}).': '(limite de itens: {fix}).',
  '({cause}: see the observation below).': '({cause}: veja a observação abaixo).',
  '({cause} and item limit: {fix}; see the observation below).':
    '({cause} e limite de itens: {fix}; veja a observação abaixo).',
  'above the open project': 'acima do diretório aberto',
  'name without a file': 'nome sem arquivo',
  'Where it points': 'Para onde aponta',
  'What points to it': 'Quem aponta para ele',
  'Distinct targets (files or targets not found) and relations: each reference counts, with its line, including repeats in the same file.':
    'Destinos distintos (arquivos ou citados não encontrados) e relações: cada citação conta, com sua linha, inclusive repetidas no mesmo arquivo.',
  'Distinct files that reference this file and relations: each reference counts, with its line, including repeats in the same file.':
    'Arquivos distintos que citam este arquivo e relações: cada citação conta, com sua linha, inclusive repetidas no mesmo arquivo.',
  '{count} target | {count} targets': '{count} destino | {count} destinos',
  'References of this file to itself: they appear in both lists, after the others.':
    'Citações deste arquivo a ele mesmo: aparecem nas duas listas, depois das demais.',
  '{count} self-reference | {count} self-references':
    '{count} autorreferência | {count} autorreferências',
  '{relation}: view the evidence': '{relation}: ver a evidência',
  'Evidence: {relation} at line {line}': 'Evidência: {relation} na linha {line}',
  'Evidence: {relation}': 'Evidência: {relation}',
  '{evidence}, resolved {how}': '{evidence}, resolvida {how}',
  '(resolved {how})': '(resolvida {how})',
  'self-reference': 'autorreferência',
  'declared scope: {pattern}': 'escopo declarado: {pattern}',
  'Show {count} more target · {left} left | Show {count} more targets · {left} left':
    'Mostrar mais {count} destino · faltam {left} | Mostrar mais {count} destinos · faltam {left}',
  'Show {count} more file · {left} left | Show {count} more files · {left} left':
    'Mostrar mais {count} arquivo · faltam {left} | Mostrar mais {count} arquivos · faltam {left}',
  'Type not read ({extension}): the content of this file is not read for references.':
    'Tipo não lido ({extension}): o conteúdo deste arquivo não é lido em busca de referências.',
  'Error: {message}': 'Erro: {message}',
  'Not read · {atLeast}{count} item on disk | Not read · {atLeast}{count} items on disk':
    'Não lida · {atLeast}{count} item no disco | Não lida · {atLeast}{count} itens no disco',
  '[folder] Not read': 'Não lida',
  'open this folder as a project to read it': 'abra esta pasta como diretório para lê-la',
  'the reader could not read the folder or the names in it':
    'o leitor não conseguiu ler a pasta ou os nomes nela',
  'Partly read · {atLeast}{count} item left out | Partly read · {atLeast}{count} items left out':
    'Lida em parte · {atLeast}{count} item fora | Lida em parte · {atLeast}{count} itens fora',
  'open this folder as a project to read all of it':
    'abra esta pasta como diretório para lê-la inteira',
  'name that is not valid UTF-8': 'nome que não é UTF-8 válido',
  'No item available. See the Audit for the scan limits.':
    'Nenhum item disponível. Consulte a auditoria para verificar limites de leitura.',
  '{count} line | {count} lines': '{count} linha | {count} linhas',
  'Identity the file itself declares in the frontmatter; wikilinks [[name]] without a folder resolve by it':
    'Identidade que o próprio arquivo declara no frontmatter; wikilinks [[nome]] sem pasta resolvem por ela',
  'Declared name:': 'Nome declarado:',
  'Copy absolute path': 'Copiar caminho absoluto',
  'Copy absolute path: {path}': 'Copiar caminho absoluto: {path}',
  'Could not copy the path.': 'Não foi possível copiar o caminho.',
  'Path copied': 'Caminho copiado',
  'partly read: JSON depth limit': 'lido em parte: limite de profundidade do JSON',
  'not read: size limit (1 MiB)': 'não lido: limite de tamanho (1 MiB)',
  'not read: read failure': 'não lido: falha de leitura',
  'not read: text limit of the scan': 'não lido: limite de texto da leitura',
  'preview limited to 1 MiB': 'prévia limitada a 1 MiB',
  'Use this file as source A of the Trace': 'Usar este arquivo como origem A do Caminho',
  'Set as <b>A</b>': 'Definir como <b>A</b>',
  'Use this file as target B of the Trace': 'Usar este arquivo como destino B do Caminho',
  'Set as <b>B</b>': 'Definir como <b>B</b>',
  'File details': 'Detalhes do arquivo',
  'Evidence': 'Evidências',
  'Notes': 'Anotações',
  'Reading file…': 'Lendo arquivo…',
  'Select a file to read its content.': 'Selecione um arquivo para ler seu conteúdo.',
  'Read the evidence in {name}': 'Ler evidência em {name}',
  'Relation declared in the manifest above.': 'Relação declarada no manifesto acima.',
  'Resolved {how}.': 'Resolvida {how}.',
  '<b>Declared scope:</b> {kindName} (<code>{kindCode}</code>), pattern <code>{pattern}</code>. The target does not exist in the package; the reference was absorbed and is counted in the summary of the audit, with no proof that the file will exist at run time.':
    '<b>Escopo declarado:</b> {kindName} (<code>{kindCode}</code>), padrão <code>{pattern}</code>. O destino não existe no pacote; a referência foi absorvida e é contada no resumo da auditoria, sem prova de que o arquivo existirá durante a execução.',
  'Show {count} more evidence item | Show {count} more evidence items':
    'Mostrar mais {count} evidência | Mostrar mais {count} evidências',
  'No relation found for this file.': 'Nenhuma relação encontrada para este arquivo.',
  'Logical object · {type}': 'Objeto lógico · {type}',
  'Relations come only from {extensions}; references in scripts (.py, .sh…) are not counted.':
    'Relações vêm só de {extensions}; citações em scripts (.py, .sh…) não entram.',
  'Saved in the app, outside the file.': 'Salvas no aplicativo, fora do arquivo.',
  'File note': 'Anotação do arquivo',
  'Responsibility, question, decision…': 'Responsabilidade, dúvida, decisão…',
  'Save note': 'Salvar anotação',
  '[note] Saving…': 'Salvando…',
  'Unsaved changes': 'Alterações não salvas',
  'Saved on this computer': 'Salvo neste computador',
  'Select a file in the tree, the Structure or the map.':
    'Selecione um arquivo na árvore, na Estrutura ou no mapa.',

  // Help: other sections (src/Help.tsx)
  'Open a project': 'Abrir um projeto',
  'In the <b>Projects</b> menu, <b>Add folder</b> saves a folder as a project and opens it. <b>Open project</b> lists the saved projects: Open adds the project to the open ones; Switch closes the others.':
    'No menu <b>Projetos</b>, <b>Adicionar diretório</b> salva uma pasta como projeto e a abre. <b>Abrir projeto</b> lista os projetos salvos: Abrir junta o projeto aos abertos; Trocar fecha os outros.',
  'The app does not rescan by itself: after changing files in another program, use <b>Rescan</b>.':
    'O app não relê sozinho: depois de mudar arquivos em outro programa, use <b>Reler</b>.',
  'Structure and Map': 'Estrutura e Mapa',
  'Inspector': 'Inspetor',
  'Shows the text of the selected file, with its observations above. Tabs: File, Relations (what it references and what references it), Evidence (the excerpt of each reference) and Notes (your notes, saved in the app). <b>Set as A</b> and <b>Set as B</b> fill in the Trace.':
    'Mostra o texto do arquivo selecionado, com as observações dele acima. Abas: Arquivo, Relações (quem ele cita e quem o cita), Evidências (o trecho de cada referência) e Anotações (notas suas, salvas no app). <b>Definir como A</b> e <b>Definir como B</b> preenchem o Caminho.',
  'Audit': 'Auditoria',
  'Lists the observations of the open projects by level: Problems, Warnings, Info and All. Signals (cycles, repeated references, high fan-out) are kept apart, out of the count.':
    'Lista as observações dos projetos abertos por nível: Problemas, Avisos, Informativos e Todas. Sinais (ciclos, referências repetidas, muitas saídas) ficam à parte, fora da contagem.',
  'The line number opens the file at that line. The rest of the row opens the detail, with <b>Mark as expected</b>, which takes the observation out of the counts in this app only, and <b>Declare in project…</b>, which shows the excerpt to write in the agent-architecture.json of the project.':
    'O número da linha abre o arquivo nessa linha. O resto da linha abre o detalhe, com <b>Marcar como esperada</b>, que tira a observação das contagens só neste app, e <b>Declarar no projeto…</b>, que mostra o trecho a escrever no agent-architecture.json do projeto.',
  'Looks for the shortest path from A to B through the written references. The fields take the absolute path or the path relative to the project; Enter traces. “Both directions” also follows arrows backwards. <b>Clear trace</b> closes the view of the trace.':
    'Procura o menor caminho de A até B pelas referências escritas. Os campos aceitam o caminho absoluto ou relativo ao projeto; Enter traça. “Ambos os sentidos” também percorre setas ao contrário. <b>Limpar caminho</b> fecha a vista do caminho.',
  'Changes': 'Alterações',
  'Compares the current scan with the baseline of each project: new or resolved files, relations and observations. The first scan is the baseline; it advances with <b>Update baseline</b>, stays valid after the server restarts and is erased when the project is forgotten.':
    'Compara a leitura atual com a referência de cada projeto: arquivos, relações e observações novas ou resolvidas. A primeira leitura é a referência; ela avança com <b>Atualizar referência</b>, continua valendo depois de reiniciar o servidor e é apagada ao excluir o projeto.',
  'Filters': 'Filtros',
  'Above the tree, the class (All, Instructions, Memory, Skills, Manifests, Other) and With observations filter the tree and the Structure, without changing the map.':
    'Acima da árvore, a classe (Todos, Instruções, Memória, Skills, Manifestos, Outros) e Com observações filtram a árvore e a Estrutura, sem mudar o mapa.',
  '<b>Filters</b>, in the bottom bar, chooses files by their path and shows their relations or the paths between them, highlighted on the map or in a view of their own.':
    '<b>Filtros</b>, na barra de baixo, escolhe arquivos pelo caminho e mostra as relações deles ou os caminhos entre eles, em destaque no mapa ou numa vista própria.',
  'Create an architecture': 'Criar uma arquitetura',
  '<b>New architecture</b> creates a new folder with files, types and relations, after you review each file, with editable default text; it never overwrites a folder.':
    '<b>Nova arquitetura</b> cria uma pasta nova com nós, tipos e relações, depois de revisar cada arquivo, com texto padrão editável; nunca sobrescreve uma pasta.',
  'Shortcuts': 'Atalhos',
  'Scan limits': 'Limites da leitura',
  '{items} items divided among the open projects, {file} MiB per file, {text} MiB of text per scan. Symbolic links are not followed.':
    '{items} itens repartidos pelos projetos, {file} MiB por arquivo, {text} MiB de texto por leitura. Links simbólicos não são seguidos.',
  'Ignored folders: {folders}.': 'Pastas ignoradas: {folders}.',
  'A partial scan shows in the bottom bar or in a strip at the top; the link opens the limits in the Audit.':
    'Uma leitura parcial aparece na barra de baixo ou numa faixa no topo; o link abre os limites na Auditoria.',

  // Header of a view, Structure | Map, the view opened by the scope rule (src/ScopeWorkspace.tsx)
  'View mode of {name}': 'Modo da vista {name}',
  'Structure: folders and files as they are on disk':
    'Estrutura: pastas e arquivos como estão no disco',
  'Structure': 'Estrutura',
  'Map of {name}': 'Mapa de {name}',
  'Map: references of the selected file': 'Mapa: referências do arquivo selecionado',
  'Map': 'Mapa',
  'Child of {parent} · +{count} level | Child of {parent} · +{count} levels':
    'Filho de {parent} · +{count} nível | Filho de {parent} · +{count} níveis',
  '{name} has its own {entry}': '{name} tem {entry} próprio',
  '{name} has its own {first} and {second}': '{name} tem {first} e {second} próprios',
  'Folder panel: {path}': 'Painel do diretório {path}',
  'Folder containment · {parent}': 'Contenção de diretório · {parent}',
  'Folder details: {name}': 'Detalhes do diretório {name}',
  'Path and subfolders': 'Caminho e subdiretórios',
  'Folder containment · {parent} ({containment}). It does not state a run-time dependency.':
    'Contenção de diretório · {parent} ({containment}). Não afirma dependência de execução.',
  'Subfolders with their own entry point:': 'Subdiretórios com entrada própria:',
  'Opened automatically: {reason} · Folder containment · {parent} ({containment})':
    'Aberta automaticamente: {reason} · Contenção de diretório · {parent} ({containment})',
  'Opened automatically: {reason}': 'Aberta automaticamente: {reason}',
  'Opened automatically: <b>{reason}</b>': 'Aberta automaticamente: <b>{reason}</b>',
  '{count} reference between this folder and another | {count} references between this folder and others':
    '{count} referência entre este diretório e outro | {count} referências entre este diretório e outros',
  'View the evidence of the reference {id}': 'Ver evidência da referência {id}',

  // Grid of views: tabs, arrangement, minimizing (src/MapWorkspace.tsx)
  'Trace': 'Caminho',
  'Temporary view: the others stay in the Views strip and come back as they were when the trace is cleared':
    'Vista temporária: as demais continuam nas abas abaixo e voltam como estavam ao limpar o caminho',
  'temporary': 'temporária',
  'Arrange view {name}': 'Organizar vista {name}',
  'Move view': 'Mover vista',
  'Move {name} left': 'Mover {name} para esquerda',
  'Move {name} right': 'Mover {name} para direita',
  'Move left': 'Mover para esquerda',
  'Move right': 'Mover para direita',
  'Minimize view {name}': 'Minimizar vista {name}',
  'Minimize: the view goes to the Views strip': 'Minimizar: guarda a vista na barra de vistas',
  'Clear trace': 'Limpar caminho',
  'Close view': 'Fechar vista',
  'Views': 'Vistas',
  'Restore view {name}': 'Restaurar vista {name}',
  'Activate view {name}': 'Ativar vista {name}',
  'temporary view': 'vista temporária',
  'Minimized': 'Minimizada',
  'Arrange views in rows': 'Organizar vistas em linhas',
  'Arrange views in columns': 'Organizar vistas em colunas',
  'One view above the other': 'Uma vista acima da outra',
  'Views side by side': 'Vistas lado a lado',
  'Parallel maps': 'Mapas em paralelo',
  'All views are minimized': 'Todas as vistas estão minimizadas',
  'Restore views': 'Restaurar vistas',
  'View {name}': 'Vista {name}',

  // Map of a file: cards, arrows, columns and the evidence of an arrow (src/Canvas.tsx)
  'Reference to the current folder': 'Referência ao diretório atual',
  'Reference to the open project': 'Referência à raiz aberta',
  'Reference outside this folder': 'Referência fora deste diretório',
  '{name} (project)': '{name} (raiz)',
  'Missing target': 'Destino ausente',
  'Not read': 'Não lido',
  'Referenced folder': 'Diretório referenciado',
  '↙ {incoming} incoming · ↗ {outgoing} outgoing':
    '↙ {incoming} de entrada · ↗ {outgoing} de saída',
  '↙ {incoming} incoming · ↗ {outgoing} outgoing · only the relations with this folder':
    '↙ {incoming} de entrada · ↗ {outgoing} de saída · só as relações com este diretório',
  '{step} · reverse': '{step} · inverso',
  'Step {steps}. {count} relation from {source} to {target}. View the evidence | Step {steps}. {count} relations from {source} to {target}. View the evidence':
    'Passo {steps}. {count} relação de {source} para {target}. Ver evidências | Passo {steps}. {count} relações de {source} para {target}. Ver evidências',
  '{count} relation from {source} to {target}. View the evidence | {count} relations from {source} to {target}. View the evidence':
    '{count} relação de {source} para {target}. Ver evidências | {count} relações de {source} para {target}. Ver evidências',
  'Step {steps}': 'Passo {steps}',
  'References outside this context': 'Referências fora deste contexto',
  'Paths of other scopes or not opened': 'Caminhos de outros escopos ou não abertos',
  'Files of the trace ↓': 'Etapas do caminho ↓',
  'Sources ↑ · selection · targets ↓': 'Origens ↑ · seleção · destinos ↓',
  'File {step}': 'Etapa {step}',
  'Context': 'Contexto',
  'What points to the selection': 'Quem aponta para a seleção',
  'File being inspected': 'Arquivo em inspeção',
  'Where the selection points': 'Para onde a seleção aponta',
  '{count} relation: {source} → {target} | {count} relations: {source} → {target}':
    '{count} relação: {source} → {target} | {count} relações: {source} → {target}',
  'contains · +{count} level | contains · +{count} levels':
    'contém · +{count} nível | contém · +{count} níveis',
  'Architecture map': 'Mapa da arquitetura',
  'Evidence of the arrow': 'Evidências da conexão',
  '{count} relation between these files | {count} relations between these files':
    '{count} relação entre estes arquivos | {count} relações entre estes arquivos',
  'Close the evidence of the arrow': 'Fechar evidências da conexão',
  '{relation} · line {line}': '{relation} · linha {line}',

  // Dividers of the panels (src/layout.tsx)
  '{label} · drag or use the arrow keys · double-click to restore':
    '{label} · arraste ou use as setas · clique duplo para restaurar',

  // Editing a document (src/FileEditor.tsx; the bottom bar in src/App.tsx)
  'Edit': 'Editar',
  'Edit this document in the inspector': 'Editar este documento no inspetor',
  '{extension} is not editable here: the app edits Markdown':
    '{extension} ainda não é editável aqui: o app edita Markdown',
  'A file without extension is not editable here: the app edits Markdown':
    'Arquivo sem extensão não é editável aqui: o app edita Markdown',
  'Larger than {size}: not editable here': 'Arquivo acima de {size}: não é editável aqui',
  'Symbolic link: not editable here': 'Link simbólico: não é editável aqui',
  'Not a file of the scan: not editable here': 'Não é um arquivo da leitura: não é editável aqui',
  'No answer from the server.': 'Sem resposta do servidor.',
  'Allow the app to save the documents of {project}?':
    'Permitir que o app grave nos documentos de {project}?',
  'Editing stays on in this project until you turn it off in the bottom bar; the app keeps no earlier versions, so use Git for history.':
    'A permissão fica ligada neste projeto até você desligar na barra inferior; o app não guarda versões anteriores, então use o Git para ter histórico.',
  'Allow editing': 'Permitir edição',
  'Invalid session. Reopen the app.': 'Sessão inválida. Reabra o aplicativo.',
  'Checking the file on disk…': 'Conferindo o arquivo no disco…',
  'The folder of this project moved or no longer exists. Rescan the projects.':
    'A pasta deste projeto mudou de lugar ou não existe mais. Releia os diretórios.',
  'Reload from disk': 'Recarregar do disco',

  'Up to {count} Markdown file, which may hold instructions, commands or skills: what is saved in it applies to the agents and can make them run commands. | Up to {count} Markdown files, and some are instructions, commands or skills: what is saved in them applies to the agents and can make them run commands.':
    'Até {count} arquivo Markdown, que pode ter instruções, comandos ou skills: o que for gravado nele passa a valer para os agentes e pode fazê-los executar comandos. | Até {count} arquivos Markdown, e alguns são instruções, comandos ou skills: o que for gravado neles passa a valer para os agentes e pode fazê-los executar comandos.',

  // Editing › refusals of the server, by code: the Portuguese is the server's text for each code
  'Editing cannot be turned on in the system root, the home folder or a folder above it: it would reach the documents and agent settings of every project. Open the project folder and turn editing on there.':
    'A edição não pode ser ligada na raiz do sistema, no diretório pessoal nem numa pasta acima dele: ela alcançaria os documentos e as configurações de agentes de todos os projetos. Abra a pasta do projeto e ligue a edição nela.',
  'Editing is not on in the open project that contains this file.':
    'A edição não está ligada no projeto aberto que contém este arquivo.',
  'The project is not open or not available. Rescan the projects.':
    'O projeto informado não está aberto ou não está disponível. Releia os diretórios.',
  'This path is not a file of the current scan of this project. Rescan the projects.':
    'Este caminho não é um arquivo da leitura atual deste projeto. Releia o diretório.',
  'Files of the app state are not editable.': 'Arquivos do estado do aplicativo não são editáveis.',
  'This path is protected by AAE_PROTECTED_PATHS or by protected-paths.txt. Editing respects that list too. The protection applies to you here in the app too. Taking off the list the entry that protects this project allows editing, and also creation and state of any program in that path.':
    'Este caminho está protegido por AAE_PROTECTED_PATHS ou por protected-paths.txt. A edição também respeita essa lista. A proteção vale também para você aqui no aplicativo. Tirar da lista a entrada que protege este projeto libera a edição, e libera também criação e estado de qualquer programa nesse caminho.',
  'This path is protected by AAE_PROTECTED_PATHS or by protected-paths.txt. Editing respects that list too.':
    'Este caminho está protegido por AAE_PROTECTED_PATHS ou por protected-paths.txt. A edição também respeita essa lista.',
  'The app edits only Markdown documents (.md and .markdown).':
    'O aplicativo edita só documentos Markdown (.md e .markdown).',
  'On disk, this path is not a regular file or goes through a symbolic link. Rescan the projects.':
    'No disco, este caminho não é um arquivo regular ou passa por um link simbólico. Releia o diretório.',
  'The file has more than one name (a hard link); saving would split the names.':
    'O arquivo tem mais de um nome (link físico); gravar separaria os nomes.',
  'The file belongs to another user.': 'O arquivo pertence a outro usuário.',
  'The system did not let the app keep the group of the file. Nothing was saved.':
    'O sistema não deixou manter o grupo do arquivo. Nada foi gravado.',
  'The file has no write permission.': 'O arquivo está sem permissão de escrita.',
  'The file has a null byte: it looks binary.': 'O arquivo tem byte nulo: parece binário.',
  'The file is not valid UTF-8 text.': 'O arquivo não é texto UTF-8 válido.',
  'The file mixes line breaks or has a lone carriage return.':
    'O arquivo mistura quebras de linha ou tem \\r solto.',
  'The text cannot be saved: it starts with a BOM (U+FEFF), or has a null byte or a character that does not exist in UTF-8.':
    'O texto enviado não pode ser gravado: começa com um BOM (U+FEFF) ou tem byte nulo ou um caractere que não existe em UTF-8.',
  'The file, or the new text, is larger than 256 KiB.':
    'O arquivo, ou o texto novo, passa de 256 KiB.',
  'The file changed on disk after it was opened for editing. Nothing was saved.':
    'O arquivo mudou no disco depois de aberto para edição. Nada foi gravado.',
  'The file, or a folder of its path, no longer exists on disk.':
    'O arquivo, ou uma pasta do caminho, não existe mais no disco.',
  'The folder of the file was moved or replaced during the save. Nothing was saved.':
    'A pasta do arquivo foi movida ou trocada durante a gravação. Nada foi gravado.',
  'Could not save the file. Nothing was saved.':
    'Não foi possível gravar o arquivo. Nada foi gravado.',
  'Could not confirm whether the file was replaced. Read the file again before saving again.':
    'Não foi possível confirmar se o arquivo foi trocado. Releia o arquivo antes de gravar de novo.',
  'Editor of {name}': 'Editor de {name}',
  'Text of {name}': 'Texto de {name}',
  'Save': 'Gravar',
  'Save the file (Ctrl+S)': 'Gravar o arquivo (Ctrl+S)',
  'Saving…': 'Gravando…',
  'Could not copy the text.': 'Não foi possível copiar o texto.',
  'Close editor': 'Fechar editor',
  'Line {line}, column {column}': 'Linha {line}, coluna {column}',
  'Undo': 'Desfazer',
  'Undo the last save?': 'Desfazer a última gravação?',
  'The file on disk does not change; the text typed here is lost.':
    'O arquivo no disco não muda; o texto digitado aqui se perde.',
  'Save over the version on disk?': 'Gravar sobre a versão do disco?',
  'You kept your text over a newer version on disk. Saving replaces that version; what it changes:':
    'Você manteve o seu texto sobre uma versão mais nova do disco. Gravar substitui essa versão; o que muda:',
  'Undo returns the file to the previous text and discards what you typed after saving.':
    'Desfazer volta o arquivo ao texto anterior e descarta o que você digitou depois de gravar.',
  'the system did not confirm the save to disk': 'o sistema não confirmou a gravação em disco',
  'rescanning the projects…': 'relendo os projetos…',
  'stale scan': 'leitura desatualizada',
  'Rescan': 'Reler',
  '{title} ({target}), line {line}': '{title} ({target}), linha {line}',
  '{title}, line {line}': '{title}, linha {line}',
  '{count} resolved in other files | {count} resolved in other files':
    '{count} resolvida em outros arquivos | {count} resolvidas em outros arquivos',
  '{count} new in other files | {count} new in other files':
    '{count} nova em outros arquivos | {count} novas em outros arquivos',
  'the file changed again on disk after your save':
    'o arquivo mudou de novo no disco depois da sua gravação',
  'not verified in this scan': 'não verificado nesta leitura',
  'the file is no longer in the scan': 'o arquivo não está mais na leitura',
  'Not saved: the file on disk is still the one you opened.':
    'Não gravado: o arquivo no disco ainda é o que você abriu.',
  'No answer from the server. Your text stays in this window.':
    'Sem resposta do servidor. Seu texto continua nesta janela.',
  'Try again': 'Tentar de novo',
  'The file no longer exists on disk. The app does not create it again; your text stays in the list of unsaved documents.':
    'O arquivo não existe mais no disco. O app não o recria; seu texto fica na lista de documentos não gravados.',
  'Allow and save': 'Permitir e gravar',
  'Another program is changing this file without changing its text; try again.':
    'Outro programa está mexendo neste arquivo sem mudar o conteúdo; tente de novo.',
  'The file changed on disk since you opened it.': 'O arquivo mudou no disco desde que você abriu.',
  'What you changed': 'O que você mudou',
  'What changed on disk': 'O que mudou no disco',
  'Keep my text': 'Manter meu texto',
  'Keeps your text over the new version on disk; saving then shows what of that version it undoes.':
    'Mantém o seu texto sobre a versão nova do disco; a gravação mostra antes o que dessa versão ela desfaz.',
  'Discard my text': 'Descartar meu texto',
  'Copy my text': 'Copiar meu texto',
  'What the save changes on disk': 'O que a gravação muda no disco',
  'Confirm save': 'Confirmar gravação',
  'Too many changes to compare line by line: shown as one block replaced.':
    'Mudanças demais para comparar linha a linha: mostradas como um bloco substituído.',
  'No difference.': 'Nenhuma diferença.',
  'Added:': 'Incluída:',
  'Removed:': 'Excluída:',
  '{count} more line not shown | {count} more lines not shown':
    'mais {count} linha não mostrada | mais {count} linhas não mostradas',
  'Stale scan: {count} file saved after the scan of {time} | Stale scan: {count} files saved after the scan of {time}':
    'Leitura desatualizada: {count} arquivo gravado depois da leitura de {time} | Leitura desatualizada: {count} arquivos gravados depois da leitura de {time}',
  'Stale scan: {count} file saved after the scan | Stale scan: {count} files saved after the scan':
    'Leitura desatualizada: {count} arquivo gravado depois da leitura | Leitura desatualizada: {count} arquivos gravados depois da leitura',
  'Unsaved documents': 'Documentos não gravados',
  'No unsaved documents.': 'Nenhum documento não gravado.',
  'Show text': 'Mostrar texto',
  'Discard': 'Descartar',
  'Discard the unsaved text of {name}?': 'Descartar o texto não gravado de {name}?',
  'Not saved': 'Não gravado',
  'Changed on disk': 'Mudou no disco',
  'No longer on disk': 'Não existe mais no disco',
  'Not in the current scan': 'Fora da leitura atual',
  'Editing off in this project': 'Edição desligada neste projeto',
  'Close the project?': 'Remover da tela?',
  'Switch projects?': 'Trocar de projeto?',
  '{count} document has unsaved edits in {projects}. It stays in the list of unsaved documents, only to copy. | {count} documents have unsaved edits in {projects}. They stay in the list of unsaved documents, only to copy.':
    '{count} documento tem edição não gravada em {projects}. Ele continua na lista de documentos não gravados, só para copiar. | {count} documentos têm edição não gravada em {projects}. Eles continuam na lista de documentos não gravados, só para copiar.',
  'Turn off editing in {project}?': 'Desligar a edição em {project}?',
  'Turn off editing': 'Desligar edição',
  '{count} document has unsaved edits in {project}. It stays in the list of unsaved documents; saving it needs editing on again. | {count} documents have unsaved edits in {project}. They stay in the list of unsaved documents; saving them needs editing on again.':
    '{count} documento tem edição não gravada em {project}. Ele continua na lista de documentos não gravados; para gravá-lo, ligue a edição de novo. | {count} documentos têm edição não gravada em {project}. Eles continuam na lista de documentos não gravados; para gravá-los, ligue a edição de novo.',
  'Editing on: {project}': 'Edição ligada: {project}',
  'Editing on: {count} project | Editing on: {count} projects':
    'Edição ligada: {count} projeto | Edição ligada: {count} projetos',
  'Editing is on: the editor saves to the files of these projects':
    'Edição ligada: o editor grava nos arquivos destes projetos',
  'Turn off editing in {project}': 'Desligar edição em {project}',
  '{count} unsaved | {count} unsaved': '{count} não gravado | {count} não gravados',
  '{count} unsaved document | {count} unsaved documents':
    '{count} documento não gravado | {count} documentos não gravados',

  // Editing › the state line at the foot of the editor: short sentences (the long ones in the tooltip)
  'Saved': 'Gravado',
  'Save undone': 'Gravação desfeita',
  'Nothing new to save': 'Nada novo a gravar',
  'L{line} resolved': 'L{line} resolvida',
  'checked by reading again': 'conferido relendo o arquivo',
  'not confirmed on disk': 'sem confirmação do disco',
  'The scan on the screen is older than the save.':
    'A leitura na tela é mais antiga que a gravação.',
  'Undo the last save': 'Desfazer a última gravação',
  'Lines added and removed': 'Linhas incluídas e excluídas',
  'Copy your text': 'Copiar o seu texto',
  'Changed on disk since you opened it': 'Mudou no disco desde que você abriu',
  'Resolve…': 'Resolver…',
  'Compare the two versions and decide': 'Comparar as duas versões e decidir',
  'Go to the observation': 'Ir até a observação',
  'Not saved; the disk did not change': 'Não gravado; o disco não mudou',
  'No answer from the server': 'Sem resposta do servidor',
  'The file no longer exists': 'O arquivo não existe mais',
  'The project folder moved': 'A pasta do projeto mudou',
  'Another program is changing the file': 'Outro programa está mudando o arquivo',
  'What does not fit in the state line': 'O que não cabe na linha de estado',
  'Invalid session; reopen the app': 'Sessão inválida; reabra o aplicativo',
  'A file of the app state': 'Arquivo do estado do app',
  'Protected path': 'Caminho protegido',
  'Only Markdown is editable': 'Só Markdown é editável',
  'Not a regular file on disk': 'Não é um arquivo comum no disco',
  'A file with more than one name': 'Arquivo com mais de um nome',
  'A file of another user': 'Arquivo de outro usuário',
  'Could not keep the file group': 'Não deu para manter o grupo',
  'No write permission': 'Sem permissão de escrita',
  'The file looks binary': 'O arquivo parece binário',
  'Not valid UTF-8 text': 'Não é texto UTF-8 válido',
  'Mixed line breaks': 'Quebras de linha misturadas',
  'A character that cannot be saved': 'Caractere que não se grava',
  'Larger than 256 KiB': 'Maior que 256 KiB',
  'Changed on disk; nothing saved': 'Mudou no disco; nada gravado',
  'The folder moved while saving': 'A pasta mudou durante a gravação',
  'Could not save the file': 'Não foi possível gravar',
  'Save not confirmed': 'Gravação não confirmada',
  'The server refused the save': 'O servidor recusou a gravação',

  // Editing › the conflict, as a dialog
  'The file changed on disk': 'O arquivo mudou no disco',
  'Another program saved {name} after you opened it. Nothing was overwritten.':
    'Outro programa gravou {name} depois que você o abriu. Nada foi sobrescrito.',
  'Decide later': 'Decidir depois',

  // Editing › what is above the text keeps its place while the file is edited
  'refresh list': 'atualizar lista',
  '{count} new observation since the editor opened | {count} new observations since the editor opened':
    '{count} observação nova desde que o editor abriu | {count} observações novas desde que o editor abriu',
  'Evidence of {source} → {target} · line {line}':
    'Evidência de {source} → {target} · linha {line}',
  'Evidence of {source} → {target}': 'Evidência de {source} → {target}',
  'Line {line}:': 'Linha {line}:',
  'Back to the file': 'Voltar ao arquivo',
  '[observation] changed': 'alterada',
  'Clear highlight': 'Limpar destaque',

  // Editing › "Ver mudanças": the text with its changes
  'Show changes': 'Ver mudanças',
  'Resolve the conflict first': 'Resolva o conflito antes',
  'Nothing changed yet: type or save first': 'Nada mudou ainda: digite ou grave antes',
  'Back to the text to edit (Esc)': 'Voltar ao texto para editar (Esc)',
  'Show in the text what saving will change': 'Mostrar no texto o que gravar vai mudar',
  'Show in the text what the last save changed': 'Mostrar no texto o que a última gravação mudou',
  'Changes in {name}': 'Mudanças em {name}',
  'one block replaced': 'um bloco substituído',
  'Too many changes to compare line by line.': 'Mudanças demais para comparar linha a linha.',
  '{count} line replaced as one block | {count} lines replaced as one block':
    '{count} linha substituída em bloco | {count} linhas substituídas em bloco',

  // Editing › a discard in the conflict is undone from the state line
  'Your text was discarded': 'Seu texto foi descartado',
  'The editor took the version on disk; Undo gives your text back.':
    'O editor ficou com a versão do disco; Desfazer devolve o seu texto.',
  'Give your text back': 'Devolver o seu texto',

  // Server answers › the client's own words for a refusal without a sentence (src/api.ts)
  'The operation could not be completed.': 'Não foi possível concluir a operação.',
  // Changes › a text budget saved before the server wrote English, in English (src/observations.ts)
  '{count} text file listed but not analyzed ({bytes} bytes) | {count} text files listed but not analyzed ({bytes} bytes)':
    '{count} arquivo de texto listado, mas não analisado ({bytes} bytes) | {count} arquivos de texto listados, mas não analisados ({bytes} bytes)',
};

// ─── Server texts ───────────────────────────────────────────────────────────────────────────────
// Portuguese of the sentences the server writes (server/texts.py): each English phrase, exactly as the
// server writes it, and its Portuguese. The server sends English and, next to a sentence made with
// parameters, its phrase; src/serverText.ts looks the phrase up here and then in `ptBR`, above. What is
// in neither shows in English.
// - A sentence `ptBR` already has with the same Portuguese (the refusals of editing, which the screen
//   also says by itself) is not repeated here.
// - Keep each `{parameter}` of the English phrase. A number is written as the server sends it.
// - Two forms by number are two entries (the server chooses the phrase).
// - tests/test_server_texts.py checks this block against the server: an entry the server no longer
//   writes, a phrase without an entry or a translation with other parameters fails `npm test`.
export const ptBRServer: Pack = {
  // Reader: observations, signals and refusals (server/scanner.py)
  'Target not found: {raw}': 'Destino não encontrado: {raw}',
  'A name written without a folder matches no inventoried file: {raw}. It may be a runtime artifact, an example or a placeholder; it is not treated as a broken path.':
    'Nome citado sem diretório não corresponde a nenhum arquivo do inventário: {raw}. Pode ser artefato de execução, exemplo ou marcador; não é tratado como caminho quebrado.',
  'Inventory limit reached in {root} ({budget} items per root in this workspace): folders read in part: {partial}; folders not read: {unread}; items left out of the inventory: {omitted}. The cut affects both sides: findings may be missing in those folders, and references into them are checked only for existence. Open a subfolder for a complete scan.':
    'Limite de inventário atingido em {root} ({budget} elementos por raiz neste workspace): {partial} pasta(s) lida(s) em parte e {unread} não lida(s), com {omitted} elemento(s) fora do inventário. O corte afeta os dois lados: pode faltar achado nessas pastas, e referências para dentro delas são conferidas só por existência. Abra um subdiretório para uma leitura completa.',
  'Inventory limit reached in {root} ({budget} items per root in this workspace): folders read in part: {partial}; folders not read: {unread}; items left out of the inventory: at least {omitted}. The cut affects both sides: findings may be missing in those folders, and references into them are checked only for existence. Open a subfolder for a complete scan.':
    'Limite de inventário atingido em {root} ({budget} elementos por raiz neste workspace): {partial} pasta(s) lida(s) em parte e {unread} não lida(s), com no mínimo {omitted} elemento(s) fora do inventário. O corte afeta os dois lados: pode faltar achado nessas pastas, e referências para dentro delas são conferidas só por existência. Abra um subdiretório para uma leitura completa.',
  'Inventory limit reached in {root} ({budget} items per root in this workspace): folders read in part: {partial}; folders not read: {unread}; items left out of the inventory: {omitted}. Entry or skill files (AGENTS.md, CLAUDE.md, SKILL.md) left out: {entries}, such as {example}. The cut affects both sides: findings may be missing in those folders, and references into them are checked only for existence. Open a subfolder for a complete scan.':
    'Limite de inventário atingido em {root} ({budget} elementos por raiz neste workspace): {partial} pasta(s) lida(s) em parte e {unread} não lida(s), com {omitted} elemento(s) fora do inventário. {entries} arquivo(s) de entrada ou de skill (AGENTS.md, CLAUDE.md, SKILL.md) ficaram fora, como {example}. O corte afeta os dois lados: pode faltar achado nessas pastas, e referências para dentro delas são conferidas só por existência. Abra um subdiretório para uma leitura completa.',
  'Inventory limit reached in {root} ({budget} items per root in this workspace): folders read in part: {partial}; folders not read: {unread}; items left out of the inventory: at least {omitted}. Entry or skill files (AGENTS.md, CLAUDE.md, SKILL.md) left out: {entries}, such as {example}. The cut affects both sides: findings may be missing in those folders, and references into them are checked only for existence. Open a subfolder for a complete scan.':
    'Limite de inventário atingido em {root} ({budget} elementos por raiz neste workspace): {partial} pasta(s) lida(s) em parte e {unread} não lida(s), com no mínimo {omitted} elemento(s) fora do inventário. {entries} arquivo(s) de entrada ou de skill (AGENTS.md, CLAUDE.md, SKILL.md) ficaram fora, como {example}. O corte afeta os dois lados: pode faltar achado nessas pastas, e referências para dentro delas são conferidas só por existência. Abra um subdiretório para uma leitura completa.',
  'The file must have a normalized absolute path.':
    'O arquivo deve ter um caminho absoluto normalizado.',
  'Listed, but not read: it is not a regular file.':
    'Elemento listado, mas não lido: não é um arquivo regular.',
  'Reference repeated in {count} evidence locations: {source} → {target}. It may be intentional; it does not prove runtime noise.':
    'Referência repetida em {count} locais de evidência: {source} → {target}. Pode ser intencional; não comprova ruído de execução.',
  'Concentration of references: {count} distinct explicit targets (threshold: {threshold}). Review the organization; a count does not prove inefficiency.':
    'Concentração de referências: {count} destinos explícitos distintos (limiar: {threshold}). Revise a organização; quantidade não comprova ineficiência.',
  'Structural cycle: {count} files in a group with a way back through explicit references ({sample}). It does not prove repetition when an agent runs.':
    'Ciclo estrutural: {count} arquivo(s) em um grupo com retorno por referências explícitas ({sample}). Não comprova repetição na execução de um agente.',
  'Open at most {max} folders per workspace.': 'Abra no máximo {max} diretórios por workspace.',
  'Folder with a name that is not valid UTF-8: {path}':
    'Diretório com nome que não é UTF-8 válido: {path}',
  'Not a folder: {path}': 'Não é um diretório: {path}',
  'A name that is not valid UTF-8, left out of the scan: {name}':
    'Nome que não é UTF-8 válido, deixado fora da leitura: {name}',
  'Symbolic link listed without following its target.':
    'Link simbólico listado sem seguir seu destino.',
  'File listed, but not analyzed: text size limit.':
    'Arquivo listado, mas não analisado: limite de tamanho de texto.',
  'Could not analyze: {reason}': 'Não foi possível analisar: {reason}',
  'Text budget of the scan reached: text files listed but not analyzed: {count} ({bytes} bytes). References and findings inside them are not in this scan; each one has analysis “skipped” and the full list is in the audit report.':
    'Orçamento de texto da leitura atingido: {count} arquivo(s) de texto listado(s), mas não analisado(s) ({bytes} bytes). Referências e achados dentro deles não entram nesta leitura; cada um tem análise “skipped” e a lista completa está no relatório audit.',
  'Invalid scope declaration, ignored: {reason}':
    'Declaração de escopo inválida e ignorada: {reason}',
  'Reference with a character that is not valid UTF-8: {raw}':
    'Referência com caractere que não é UTF-8 válido: {raw}',
  'Invalid file URI: {raw}': 'URI de arquivo inválida: {raw}',
  'The reference contains an invalid NUL character.':
    'Referência contém um caractere NUL inválido.',
  'Could not resolve the home folder: {raw}':
    'Não foi possível resolver o diretório pessoal: {raw}',
  'Ambiguous wiki reference: {raw}': 'Referência wiki ambígua: {raw}',
  'Ambiguous reference: {raw} ({total} candidates in the inventory; none was chosen).':
    'Referência ambígua: {raw} ({total} candidatos no inventário; nenhum foi escolhido).',
  'Ambiguous reference: {raw} ({total} candidates, {hidden} beyond the inventory; none was chosen).':
    'Referência ambígua: {raw} ({total} candidatos, {hidden} além do inventário; nenhum foi escolhido).',
  'The reference {raw} does not resolve inside the open folder, but the target exists in the same repository (that of {repository}, with .git), outside the open folder: in the ancestor {ancestor} ({above}, {levels} level above the open folder), at {relative}. If this folder is used on its own, the reference is broken; if it is used inside the repository, open its root.':
    'A referência {raw} não resolve dentro do diretório aberto, mas o destino existe no mesmo repositório (o de {repository}, com .git), fora do diretório aberto: no ancestral {ancestor} ({above}, {levels} nível acima do diretório aberto), em {relative}. Se este diretório é usado sozinho, a referência está quebrada; se é usado dentro do repositório, abra a raiz dele.',
  'The reference {raw} does not resolve inside the open folder, but the target exists in the same repository (that of {repository}, with .git), outside the open folder: in the ancestor {ancestor} ({above}, {levels} levels above the open folder), at {relative}. If this folder is used on its own, the reference is broken; if it is used inside the repository, open its root.':
    'A referência {raw} não resolve dentro do diretório aberto, mas o destino existe no mesmo repositório (o de {repository}, com .git), fora do diretório aberto: no ancestral {ancestor} ({above}, {levels} níveis acima do diretório aberto), em {relative}. Se este diretório é usado sozinho, a referência está quebrada; se é usado dentro do repositório, abra a raiz dele.',
  'Unverifiable absence: {raw}. The inventory and the existence index reached their limit ({files} and {lookup} items), and the target may be in the part not listed; open a subfolder for a complete scan.':
    'Ausência não verificável: {raw}. O inventário e o índice de existência atingiram o limite ({files} e {lookup} elementos), e o destino pode estar na parte não listada; abra um subdiretório para uma leitura completa.',
  'Unverifiable absence: [[{raw}]]. The header of some Markdown file of this root that was not analyzed could not be read, and it may declare that name in the frontmatter (name:).':
    'Ausência não verificável: [[{raw}]]. O cabeçalho de algum Markdown não analisado desta raiz não pôde ser lido, e ele pode declarar esse nome no frontmatter (name:).',
  'Partial analysis: the JSON exceeded the depth limit of the parser.':
    'Análise parcial: JSON excedeu o limite de profundidade do parser.',
  'The root of the manifest must be an object.': 'A raiz do manifesto deve ser um objeto.',
  'objects and relationships must be lists.': 'objects e relationships devem ser listas.',
  'Logical object without a valid path.': 'Objeto lógico sem path válido.',
  'Relationship without a valid source/target.': 'Relacionamento sem source/target válido.',
  'Relationship with an invalid type: it must be text.':
    'Relacionamento com type inválido: deve ser texto.',
  'Invalid manifest: {reason}': 'Manifesto inválido: {reason}',
  'Convention: instructions file in an ancestor folder. It does not affirm the precedence of a runtime.':
    'Convenção: arquivo de instruções em diretório ancestral. Não afirma precedência de um runtime.',
  'No AGENTS.md or CLAUDE.md in {root}.': 'Nenhum AGENTS.md ou CLAUDE.md em {root}.',
  'Limit of {max} relations reached: relations beyond it left out of the scan: {omitted}; reachability, the signals and the resolution counts are computed without them.':
    'Limite de {max} relações atingido: {omitted} relação(ões) além dele ficaram fora da leitura, e a alcançabilidade, os sinais e as contagens de resolução são calculados sem elas.',
  'Scope pattern without effect ({kind}: {pattern}): no reference absorbed and no inventoried file matched. Review or remove the declaration.':
    'Padrão de escopo sem efeito ({kind}: {pattern}): nenhuma referência absorvida e nenhum arquivo inventariado casou. Revise ou remova a declaração.',
  'the source file was not read whole (size, inventory limit, folder not read or type not analyzed)':
    'o arquivo de origem não foi lido inteiro (tamanho, limite de inventário, pasta não lida ou tipo não analisado)',
  'one end does not resolve to a definite file (symbolic link, unverifiable absence or several candidates); no link with its other end is reported as missing from the manifest':
    'uma ponta não se resolve num arquivo certo (link simbólico, ausência não verificável ou vários candidatos); nenhum link com a outra ponta dela é dado como fora do manifesto',
  'neither end resolves to a definite file (symbolic link, unverifiable absence or several candidates); no link it could be is reported as missing from the manifest':
    'as duas pontas não se resolvem num arquivo certo (link simbólico, ausência não verificável ou vários candidatos); nenhum link que ela possa ser é dado como fora do manifesto',
  'one end is not a file path (address, anchor, placeholder, variable, wildcard or a path too long)':
    'uma ponta não é caminho de arquivo (endereço, âncora, marcador, variável, curinga ou caminho longo demais)',
  'one end is an agent-architecture.json, which is not a node of another manifest':
    'uma ponta é um agent-architecture.json, que não é nó de outro manifesto',
  'the source has a link the reader did not resolve (symbolic link, unverifiable absence or candidates beyond those listed), and it may be the one of this relation':
    'a origem tem um link que o leitor não resolveu (link simbólico, ausência não verificável ou candidatos além dos listados), e ele pode ser o desta relação',
  'the source has an ambiguous reference, and the target is among the candidates':
    'a origem tem uma referência ambígua, e o destino está entre os candidatos',
  'the source has a link to a folder the reader does not read, and the target is in it':
    'a origem tem um link para uma pasta que o leitor não lê, e o destino está nela',
  'the source writes the path of the target as a link target in a form the reader does not extract (link text over several lines, target or title on another line)':
    'a origem escreve o caminho do destino como destino de link numa forma que o leitor não extrai (texto do link em várias linhas, destino ou título em outra linha)',
  'Manifest relation not checked against the links: {pair}. Reason: {reason}.':
    'Relação do manifesto não conferida com os links: {pair}. Motivo: {reason}.',
  'Manifest relation without a link in the source file: {pair}. With linkedRelationships, each relation has an explicit link from the source file to the target, outside a code block.':
    'Relação do manifesto sem link no arquivo de origem: {pair}. Com linkedRelationships, cada relação tem um link explícito do arquivo de origem para o destino, fora de bloco de código.',
  'Link without a relation in the manifest {manifest}: {raw}. With linkedRelationships, each explicit link between two objects of the manifest is one of its relations.':
    'Link sem relação no manifesto {manifest}: {raw}. Com linkedRelationships, cada link explícito entre dois objetos do manifesto é uma relação dele.',
  'No path by explicit reference from the entries considered: referenced only by files that have no path either: {inbound}. Candidate for review: the file can still be found by search, and the tool does not observe execution.':
    'Sem caminho por referência explícita a partir das entradas consideradas: referenciado apenas por {inbound} arquivo(s) também sem caminho. Candidato a revisão: o arquivo continua localizável por busca e a ferramenta não observa execução.',
  'No path by explicit reference from the entries considered: no other file references it. Candidate for review: the file can still be found by search, and the tool does not observe execution.':
    'Sem caminho por referência explícita a partir das entradas consideradas: nenhum outro arquivo o referencia. Candidato a revisão: o arquivo continua localizável por busca e a ferramenta não observa execução.',
  '{finding} Not conclusive: the scan of this root is partial (inventory cut, text not analyzed or relations cut).':
    '{finding} Não conclusivo: a leitura desta raiz é parcial (inventário cortado, texto não analisado ou relações cortadas).',
  '{finding} Not conclusive: the scan of another root of the workspace is partial, and a file of it may reference this one.':
    '{finding} Não conclusivo: a leitura de outra raiz do workspace é parcial, e um arquivo dela pode citá-lo.',
  'Select two files of the workspace.': 'Selecione dois arquivos do workspace.',
  'Invalid direction.': 'Direção inválida.',
  // Scope declaration (server/scope.py)
  '{kind}: each pattern must be a text of 1 to {max} characters.':
    '{kind}: cada padrão deve ser um texto de 1 a {max} caracteres.',
  '{kind}: a pattern with a backslash or a control character is not accepted.':
    '{kind}: padrão com barra invertida ou caractere de controle não é aceito.',
  '{kind}: a pattern with a character that is not valid UTF-8 (a JSON escape such as \\udcff) is not accepted.':
    '{kind}: padrão com caractere que não é UTF-8 válido (escape de JSON como \\udcff) não é aceito.',
  '{kind}: the pattern {pattern} must be relative to the root, without a leading /.':
    '{kind}: o padrão {pattern} deve ser relativo à raiz, sem / inicial.',
  '{kind}: the pattern {pattern} has an empty, "." or ".." segment.':
    '{kind}: o padrão {pattern} tem segmento vazio, "." ou "..".',
  'The scope declaration must be a JSON object.': 'A declaração de escopo deve ser um objeto JSON.',
  'Unknown field in the scope declaration: {sample} (and {more} more).':
    'Campo desconhecido na declaração de escopo: {sample} (e mais {more}).',
  'Unknown field in the scope declaration: {sample}.':
    'Campo desconhecido na declaração de escopo: {sample}.',
  'Incompatible scope version; use version: 1.': 'Versão de escopo incompatível; use version: 1.',
  '{kind} must be a list of patterns.': '{kind} deve ser uma lista de padrões.',
  'The scope declaration takes at most {max} patterns in all.':
    'A declaração de escopo admite no máximo {max} padrões no total.',
  '{kind}: repeated pattern.': '{kind}: padrão repetido.',
  // Audit findings and comparison notes shown in Changes (server/audit.py)
  './ mention that does not exist from the folder of the file, resolved from the opened root; write the path without ./ if it is relative to the root, or fix it from the file.':
    'Menção ./ que não existe a partir da pasta do arquivo, resolvida a partir da raiz aberta; escreva o caminho sem ./ se ele é relativo à raiz, ou corrija-o a partir do arquivo.',
  'Reference resolved by the only candidate under the folder of the source skill (homonyms outside it do not count); write the path from the file so as not to depend on the search by name.':
    'Referência resolvida pelo único candidato sob a pasta da skill de origem (homônimos fora dela não contam); escreva o caminho a partir do arquivo para não depender da busca por nome.',
  'Reference resolved by the only candidate in the inventory; write the full path so as not to depend on the search by name.':
    'Referência resolvida pelo único candidato no inventário; escreva o caminho completo para não depender da busca por nome.',
  'Reference resolved by the only file with that path suffix; write the path from the file or from the root so as not to depend on the search.':
    'Referência resolvida pelo único arquivo com esse sufixo de caminho; escreva o caminho a partir do arquivo ou da raiz para não depender da busca.',
  'Missing reference absorbed by the declared scope: counted as external to the package, not verified.':
    'Referência ausente absorvida pelo escopo declarado: contada como externa ao package, não verificada.',
  'Partial inventory or analysis: the absence of findings or of paths is not conclusive.':
    'Inventário ou análise parcial: ausência de achados ou de caminhos não é conclusiva.',
  'Different audit context ({differs}): suite or scope findings may change because of the context, not of the revision.':
    'Contexto de auditoria diferente ({differs}): achados de suíte ou de escopo podem mudar por causa do contexto, não da revisão.',
  '{note} Different effective scope (source before: {before}; after: {after}): part of the delta, resolved findings above all, may be an artifact of the scope declaration, not of the revision.':
    '{note} Escopo efetivo diferente (fonte antes: {before}; depois: {after}): parte do delta, sobretudo achados resolvidos, pode ser artefato da declaração de escopo, não da revisão.',
  'Partial or inconclusive audit in {sides}: missing findings do not prove resolution.':
    'Auditoria parcial ou inconclusiva em {sides}: achados ausentes não comprovam resolução.',
  '{before} and {after}': '{before} e {after}',
  // Changes: warnings about the baseline and reasons a saved baseline is not used (server/delta.py)
  'The saved baseline was read by another version of the app: relations and observations may show as changed with no change in the files, because of the reading rules. The Files section compares the content and stays valid. To compare only scans of this version, use “Update baseline”.':
    'A referência salva foi lida por outra versão do aplicativo: relações e observações podem aparecer como alteradas sem mudança nos arquivos, por causa das regras de leitura. A seção Arquivos compara o conteúdo e continua válida. Para comparar só leituras desta versão, use “Atualizar referência”.',
  'The saved baselines of {count} projects were read by another version of the app: relations and observations may show as changed with no change in the files, because of the reading rules. The Files section compares the content and stays valid. To compare only scans of this version, use “Update baseline”.':
    'As referências salvas de {count} projetos foram lidas por outra versão do aplicativo: relações e observações podem aparecer como alteradas sem mudança nos arquivos, por causa das regras de leitura. A seção Arquivos compara o conteúdo e continua válida. Para comparar só leituras desta versão, use “Atualizar referência”.',
  'More than {cap} observations in the baseline and in the current scan: only the first {cap}, in audit order (most severe first), are kept. No observation is reported as new or as resolved; those that would be count as not compared.':
    'Mais de {cap} observações na referência e na leitura atual: só as {cap} primeiras, na ordem da auditoria (mais graves primeiro), ficam guardadas. Nenhuma observação é dada como nova nem como resolvida; as que seriam contam como não comparadas.',
  'More than {cap} observations in the baseline: only the first {cap}, in audit order (most severe first), are kept. No observation is reported as new; those that would be count as not compared.':
    'Mais de {cap} observações na referência: só as {cap} primeiras, na ordem da auditoria (mais graves primeiro), ficam guardadas. Nenhuma observação é dada como nova; as que seriam contam como não comparadas.',
  'More than {cap} observations in the current scan: only the first {cap}, in audit order (most severe first), are kept. No observation is reported as resolved; those that would be count as not compared.':
    'Mais de {cap} observações na leitura atual: só as {cap} primeiras, na ordem da auditoria (mais graves primeiro), ficam guardadas. Nenhuma observação é dada como resolvida; as que seriam contam como não comparadas.',
  'the references folder of the state is not an ordinary directory (a symbolic link or a file)':
    'a pasta de referências do estado não é um diretório comum (link simbólico ou arquivo)',
  'there is a symbolic link in place of the saved file':
    'há um link simbólico no lugar do arquivo salvo',
  'the name of the saved file is not an ordinary file':
    'o nome do arquivo salvo não é um arquivo comum',
  'the saved file has more than one name (hard link)':
    'o arquivo salvo tem mais de um nome (hardlink)',
  'ceiling of {size} MiB compressed': 'teto de {size} MiB comprimidos',
  'ceiling of {size} MiB uncompressed': 'teto de {size} MiB descomprimidos',
  'file above the {cap}': 'arquivo acima do {cap}',
  'content above the {cap}': 'conteúdo acima do {cap}',
  'file corrupted or truncated': 'arquivo corrompido ou truncado',
  'incompatible format version': 'versão de formato incompatível',
  'the file belongs to another root': 'o arquivo pertence a outra raiz',
  'fields with invalid types or values': 'campos com tipos ou valores inválidos',
  'no permission': 'sem permissão',
  'disk full': 'disco cheio',
  'disk quota exceeded': 'cota de disco excedida',
  'read-only file system': 'sistema de arquivos somente leitura',
  'symbolic link in the path': 'link simbólico no caminho',
  'a file is in the place of a folder': 'um arquivo ocupa o lugar de uma pasta',
  'a folder is in the place of the file': 'uma pasta ocupa o lugar do arquivo',
  'input/output error': 'erro de entrada e saída',
  'system error {code}': 'erro do sistema {code}',
  'could not read the references folder ({cause})':
    'não foi possível ler a pasta de referências ({cause})',
  'could not read the saved file ({cause})': 'não foi possível ler o arquivo salvo ({cause})',
  'the baseline could not be serialized': 'a referência não pôde ser serializada',
  'baseline above the {cap}': 'referência acima do {cap}',
  'the baseline would not pass validation when loaded ({reason})':
    'a referência não passaria na validação ao carregar ({reason})',
  'failed to prepare the references folder ({cause})':
    'falha ao preparar a pasta de referências ({cause})',
  'write failure ({cause})': 'falha de gravação ({cause})',
  // Observations marked as expected (server/expected.py)
  'An invalid mark of an expected observation in the saved state was ignored.':
    'Uma marcação de observação esperada inválida no estado salvo foi ignorada.',
  '{count} invalid marks of expected observations in the saved state were ignored.':
    '{count} marcações de observação esperada inválidas no estado salvo foram ignoradas.',
  'A mark of an expected observation above the ceiling of {limit} per project was left out; the most recent ones stayed.':
    'Uma marcação de observação esperada acima do teto de {limit} por projeto foi deixada de fora; ficaram as mais recentes.',
  '{count} marks of expected observations above the ceiling of {limit} per project were left out; the most recent ones stayed.':
    '{count} marcações de observação esperada acima do teto de {limit} por projeto foram deixadas de fora; ficaram as mais recentes.',
  'The path of a project with marks was in a non-canonical form (with a trailing slash, for example) and was normalized.':
    'O caminho de um projeto com marcações estava numa forma não canônica (por exemplo, com barra no fim) e foi normalizado.',
  'The paths of {count} projects with marks were in a non-canonical form (with a trailing slash, for example) and were normalized.':
    'Os caminhos de {count} projetos com marcações estavam numa forma não canônica (por exemplo, com barra no fim) e foram normalizados.',
  'Limit of {limit} marks in this project reached. Marks without a matching observation count too ({orphans} now) and can be removed in the Audit; remove marks before creating others.':
    'Limite de {limit} marcações neste projeto atingido. Marcações sem observação correspondente também contam ({orphans} agora) e podem ser removidas na Auditoria; remova marcações antes de criar outras.',
  'The project is not open: open the folder before marking observations.':
    'Projeto não está aberto: abra o diretório antes de marcar observações.',
  'Malformed observation key.': 'Chave de observação mal formada.',
  'The expected option must be a boolean.': 'A opção expected deve ser booleana.',
  'The reason must be a text of up to {max} characters.':
    'O motivo deve ser um texto de até {max} caracteres.',
  'The reason cannot have control characters or text direction marks; only line breaks are accepted.':
    'O motivo não pode ter caracteres de controle nem marcas de direção do texto; só quebras de linha são aceitas.',
  // Editing: refusals (server/editing.py)
  'The file system of this folder does not allow reserving it (flock), and without that two saves could overlap; editing is not available here. Nothing was saved.':
    'O sistema de arquivos desta pasta não permite reservá-la (flock), e sem isso duas gravações poderiam se sobrepor; a edição não está disponível aqui. Nada foi gravado.',
  'The folder of the document is reserved (flock) by another program or by another save. Try again. Nothing was saved.':
    'A pasta do documento está reservada (flock) por outro programa ou por outra gravação. Tente de novo. Nada foi gravado.',
  'The file was replaced, but it could not be confirmed that the file now in the place of the document is the one of this save. Read the file again and check the content before saving again.':
    'A troca foi feita, mas não foi possível confirmar que o arquivo que ficou no lugar do documento é o desta gravação. Releia o arquivo e confira o conteúdo antes de gravar de novo.',
  'The protection applies to you here in the app too. Taking off the list the entry that protects this project allows editing, and also creation and state of any program in that path.':
    'A proteção vale também para você aqui no aplicativo. Tirar da lista a entrada que protege este projeto libera a edição, e libera também criação e estado de qualquer programa nesse caminho.',
  'The folder at this path is not the same as when editing was turned on in it. If this is the right project, turn editing on again.':
    'O diretório neste caminho não é o mesmo de quando a edição foi ligada nele. Se este for o projeto certo, ligue a edição de novo.',
  '{protected} Editing respects that list too.': '{protected} A edição também respeita essa lista.',
  'The text sent cannot be saved.': 'O texto enviado não pode ser gravado.',
  'save the file': 'gravar o arquivo',
  'No permission to {action}. Nothing was saved.': 'Sem permissão para {action}. Nada foi gravado.',
  'Could not {action} ({cause}). Nothing was saved.':
    'Não foi possível {action} ({cause}). Nada foi gravado.',
  'The project is not open. Rescan the projects.':
    'O projeto informado não está aberto. Releia os diretórios.',
  'The file is in a folder this project does not read.':
    'O arquivo está numa pasta que este projeto não lê.',
  'A file named {file} is never editable by the app, in any folder.':
    'Um arquivo chamado {file} nunca é editável pelo aplicativo, em nenhuma pasta.',
  'The base hash sent is invalid.': 'O hash de base enviado é inválido.',
  'The text sent must be text with \\n line breaks and without a null byte.':
    'O texto enviado precisa ser texto com quebras \\n e sem byte nulo.',
  'The text sent has a character that does not exist in UTF-8.':
    'O texto enviado tem um caractere que não existe em UTF-8.',
  'Could not consult the protected entry {entry}. Editing stays refused until it exists again or leaves the list.':
    'Não foi possível consultar a entrada protegida {entry}. A edição fica recusada até ela voltar a existir ou sair da lista.',
  'Could not consult the protected entry {entry}, from {source}. Editing stays refused until it exists again or leaves the list.':
    'Não foi possível consultar a entrada protegida {entry}, de {source}. A edição fica recusada até ela voltar a existir ou sair da lista.',
  'Could not consult the protected entry {entry}, from {source}: the form {form}, which the comparison also uses, does not exist or cannot be consulted. Editing stays refused until the entry is fixed or leaves the list.':
    'Não foi possível consultar a entrada protegida {entry}, de {source}: a forma {form}, que a comparação também usa, não existe ou não pode ser consultada. A edição fica recusada até a entrada ser corrigida ou sair da lista.',
  '{problem} Editing stays refused until the configuration is fixed.':
    '{problem} A edição fica recusada até a configuração ser corrigida.',
  'Could not consult the state directory of the app.':
    'Não foi possível consultar o diretório de estado do aplicativo.',
  'No permission to enter a folder of the path of the file.':
    'Sem permissão para entrar numa pasta do caminho do arquivo.',
  'No permission to open the file: read permission on it or access to its folder is missing.':
    'Sem permissão para abrir o arquivo: falta permissão de leitura nele ou de acesso à pasta dele.',
  'read the extended attributes of the file': 'ler os atributos estendidos do arquivo',
  'Could not read the file ({cause}).': 'Não foi possível ler o arquivo ({cause}).',
  'check the file': 'conferir o arquivo',
  'reserve the folder of the document': 'reservar a pasta do documento',
  'The text sent starts with a BOM (U+FEFF); the text always goes without it, and the BOM of the file is the one on disk.':
    'O texto enviado começa com um BOM (U+FEFF); o texto vai sempre sem ele, e o BOM do arquivo é o que está no disco.',
  'No write permission in the folder of the document. Nothing was saved.':
    'Sem permissão de escrita na pasta do documento. Nada foi gravado.',
  'Could not confirm whether the file was replaced ({cause}). Read the file again before saving again. The temporary file of this save was named {temporary}; if it is still in the folder, it was not deleted.':
    'Não foi possível confirmar se o arquivo foi trocado ({cause}). Releia o arquivo antes de gravar de novo. O temporário desta gravação se chamava {temporary}; se ele ainda estiver na pasta, não foi apagado.',
  '{refusal} The temporary file {temporary} was left in the folder of the document, with the new text; it can be deleted.':
    '{refusal} Sobrou na pasta do documento o arquivo temporário {temporary}, com o texto novo; ele pode ser apagado.',
  'keep the mode and the attributes of the file': 'manter o modo e os atributos do arquivo',
  'The system did not keep the mode or the extended attributes of the file. Nothing was saved.':
    'O sistema não manteve o modo ou os atributos estendidos do arquivo. Nada foi gravado.',
  'The folder of this project no longer exists at this path. Rescan the projects.':
    'O diretório deste projeto não existe mais neste caminho. Releia os diretórios.',
  'This file belongs to the open project {root}, which does not have editing on; editing turned on in {outer} does not apply to a project opened inside it.':
    'Este arquivo é do projeto aberto {root}, que não tem a edição ligada; a edição ligada em {outer} não vale para um projeto aberto dentro dele.',
  // Protected paths (server/protected.py)
  'This path is protected by {environment} or by {file}.':
    'Este caminho está protegido por {environment} ou por {file}.',
  'a control or invisible character (U+{code})': 'caractere de controle ou invisível (U+{code})',
  'the character {character} (quotes, glob or backslash)':
    'o caractere {character} (aspas, glob ou barra invertida)',
  'the character {character} (two paths on the same line?)':
    'o caractere {character} (dois caminhos na mesma linha?)',
  'a # after a space (a comment only on a line of its own)':
    'um # após espaço (comentário só em linha própria)',
  '{origin} has a ~ that could not be expanded.': '{origin} tem um ~ que não pôde ser expandido.',
  '{origin} takes only absolute paths; fix the relative entry (likely cause: {hint}).':
    '{origin} aceita somente caminhos absolutos; corrija a entrada relativa (provável causa: {hint}).',
  '{origin} takes only absolute paths; fix the relative entry.':
    '{origin} aceita somente caminhos absolutos; corrija a entrada relativa.',
  '{origin}: the path {entry} does not exist; likely cause: {hint}. Fix the line or comment it out with # at the start.':
    '{origin}: o caminho {entry} não existe; provável causa: {hint}. Corrija a linha ou comente-a com # no começo.',
  '{origin}: the path {entry} does not exist. Fix the line or comment it out with # at the start.':
    '{origin}: o caminho {entry} não existe. Corrija a linha ou comente-a com # no começo.',
  'Could not read {origin}: the link is broken.':
    'Não foi possível ler {origin}: o link está quebrado.',
  'Could not read {origin}: {cause}.': 'Não foi possível ler {origin}: {cause}.',
  '{origin} must be a regular text file (not a directory, FIFO or device).':
    '{origin} precisa ser um arquivo de texto regular (não diretório, FIFO ou dispositivo).',
  '{origin} is too large to be read (limit of 1 MiB).':
    '{origin} é grande demais para ser lido (limite de 1 MiB).',
  '{origin} is not valid UTF-8 text.': '{origin} não é um texto UTF-8 válido.',
  'Could not determine the default state directory.':
    'Não foi possível determinar o diretório de estado padrão.',
  '{source} (entry {number})': '{source} (entrada {number})',
  '{file} ({path}, line {number})': '{file} ({path}, linha {number})',
  // App state, projects, notes, baseline warnings and creation (server/workspace.py)
  'the directory does not exist': 'o diretório não existe',
  'write failure': 'falha de gravação',
  'Could not write to the state directory of the app ({directory}): {reason}.':
    'Não foi possível gravar no diretório de estado do aplicativo ({directory}): {reason}.',
  'An invalid editing permission in the saved state was ignored.':
    'Uma permissão de edição inválida no estado salvo foi ignorada.',
  '{count} invalid editing permissions in the saved state were ignored.':
    '{count} permissões de edição inválidas no estado salvo foram ignoradas.',
  'Could not parse the saved state.': 'Não foi possível interpretar o estado salvo.',
  'Invalid saved state; no folder was restored.':
    'Estado salvo inválido; nenhum diretório foi restaurado.',
  'Invalid saved list of folders.': 'Lista de diretórios salva inválida.',
  'Invalid saved path ignored.': 'Caminho salvo inválido ignorado.',
  'Give a valid folder path.': 'Informe um caminho de diretório válido.',
  'Invalid folder path.': 'Caminho de diretório inválido.',
  'Folder unavailable: {path}': 'Diretório indisponível: {path}',
  'Limit of {max} open folders; project kept in the list: {path}':
    'Limite de {max} diretórios abertos; projeto preservado na lista: {path}',
  'The app state cannot be kept here. {reason}':
    'O estado do aplicativo não pode ficar aqui. {reason}',
  'Give the path of a project.': 'Informe o caminho de um projeto.',
  'The last update of this baseline was not saved in the state directory of the app ({directory}): {reason}. The comparison uses the baseline saved before it; this warning leaves when a new baseline is saved.':
    'A última atualização desta referência não foi salva no diretório de estado do aplicativo ({directory}): {reason}. A comparação usa a referência salva antes dela; este aviso sai quando uma nova referência for salva.',
  // The reason of a refusal kept by a version that wrote Portuguese: the interface shows that reason instead.
  'reason recorded by an earlier version of the app':
    'motivo registrado por uma versão anterior do aplicativo',
  'Saved baseline ignored: {reason}. This scan became the baseline.':
    'Referência salva ignorada: {reason}. Esta leitura passou a ser a referência.',
  'the state directory is inside an open folder, where the app does not write':
    'o diretório de estado fica dentro de uma pasta aberta, onde o aplicativo não grava',
  'Baseline not saved in the state directory of the app ({directory}): {reason}. It holds only until the server restarts.':
    'Referência não salva no diretório de estado do aplicativo ({directory}): {reason}. Ela vale só até reiniciar o servidor.',
  '{warning} Afterwards, the comparison goes back to the baseline saved before, with a warning.':
    '{warning} Depois, a comparação volta à referência salva antes, com um aviso.',
  '{warning} Afterwards, the comparison goes back to the baseline saved before, without a warning: the reason could not be kept in the app state.':
    '{warning} Depois, a comparação volta à referência salva antes, sem aviso: o motivo não pôde ser guardado no estado do aplicativo.',
  'Open a folder before setting the baseline.': 'Abra um diretório antes de definir a referência.',
  'The option to replace the project must be a boolean.':
    'A opção de trocar de projeto deve ser booleana.',
  'The option to erase the notes must be a boolean.':
    'A opção de apagar as anotações deve ser booleana.',
  'The option to close the project must be a boolean.':
    'A opção de fechar o projeto deve ser booleana.',
  'Close the project before removing it from the saved list.':
    'Feche o projeto antes de removê-lo da lista de salvos.',
  'Project forgotten, but its saved baseline was not deleted from the state directory of the app ({directory}: {reason}): {path}':
    'Projeto esquecido, mas a referência salva dele não foi apagada do diretório de estado do aplicativo ({directory}: {reason}): {path}',
  'Give the ordered list of the paths of the open roots.':
    'Informe a lista ordenada dos caminhos das raízes abertas.',
  'Invalid root path (use the absolute path of an open root): {path}':
    'Caminho de raiz inválido (use o caminho absoluto de uma raiz aberta): {path}',
  'The new order repeats a root.': 'A nova ordem repete uma raiz.',
  'The new order names a folder that is not open: {path}':
    'A nova ordem cita um diretório que não está aberto: {path}',
  'The new order leaves out an open root: {path}': 'A nova ordem omite uma raiz aberta: {path}',
  'File outside the workspace.': 'Arquivo fora do workspace.',
  'A note must have up to 20,000 characters.': 'Anotação deve ter até 20.000 caracteres.',
  'Observation not found in the current scan of this project. Rescan the projects and try again.':
    'Observação não encontrada na leitura atual deste projeto. Releia os diretórios e tente de novo.',
  'This item is not an available local file.': 'Este elemento não é um arquivo local disponível.',
  'Target changed or outside the workspace. Rescan the folder.':
    'Destino alterado ou fora do workspace. Releia o diretório.',
  'Binary file. The preview is available for text files.':
    'Arquivo binário. A prévia está disponível para arquivos de texto.',
  'entry file': 'arquivo de entrada',
  'manifest': 'manifesto',
  'Description of {name}: it must be text.': 'Descrição de {name}: deve ser texto.',
  'Description of {name}: use up to {max} characters.':
    'Descrição de {name}: use até {max} caracteres.',
  'Description of {name}: use a single line, without control characters.':
    'Descrição de {name}: use uma linha só, sem caracteres de controle.',
  'Description of {name}: do not use backticks, brackets, @ or the signs < and >.':
    'Descrição de {name}: não use crase, colchetes, @ nem os sinais < e >.',
  'Description of {name}: do not write a file path; to link to another file, create a relation.':
    'Descrição de {name}: não escreva caminho de arquivo; para ligar a outro arquivo, crie uma relação.',
  'JSON object expected.': 'Objeto JSON esperado.',
  'Folder name: use letters, numbers, hyphen or underscore (up to 80 characters).':
    'Nome do diretório: use letras, números, hífen ou sublinhado (até 80 caracteres).',
  'Invalid language of the starting text: use "en" or "pt".':
    'Idioma do texto inicial inválido: use "en" ou "pt".',
  'Create 1 to 40 primitive nodes.': 'Crie de 1 a 40 nós primitivos.',
  'Invalid node.': 'Nó inválido.',
  'Each node needs a unique, simple name and a valid type.':
    'Cada nó precisa de um nome único e simples e um tipo válido.',
  'Node name {name}: reserved, because the file {name}.md would be read as {kind}.':
    'Nome do nó {name}: reservado, porque o arquivo {name}.md seria lido como {kind}.',
  'Use up to 200 relations.': 'Use até 200 relações.',
  'Relations must connect existing nodes.': 'As relações devem conectar nós existentes.',
  'Invalid relation type.': 'Tipo de relação inválido.',
  'The parent folder does not exist.': 'O diretório pai não existe.',
  'The target changed during creation.': 'O destino mudou durante a criação.',
  'The target stopped being empty during creation.':
    'O destino deixou de estar vazio durante a criação.',
  'The parent folder changed during creation.': 'O diretório pai mudou durante a criação.',
  // API: refusals and errors (server/main.py)
  'The path given does not exist.': 'O caminho informado não existe.',
  'A file or folder with that name already exists. Choose another name.':
    'Já existe um arquivo ou diretório com esse nome. Escolha outro nome.',
  'No permission to access the path given.': 'Sem permissão para acessar o caminho informado.',
  'The path given is not a folder (or goes through a file).':
    'O caminho informado não é um diretório (ou passa por um arquivo).',
  'There is no free space on the disk.': 'Não há espaço livre no disco.',
  'The file system is read-only.': 'O sistema de arquivos é somente leitura.',
  'A name of the path, or the whole path, is too long.':
    'Um nome do caminho, ou o caminho inteiro, é longo demais.',
  'The path goes through a loop of symbolic links (or through a link that cannot be followed).':
    'O caminho passa por um laço de links simbólicos (ou por um link que não pode ser seguido).',
  'The operation could not be completed. The technical detail was recorded in the server log.':
    'Não foi possível concluir a operação. O detalhe técnico foi registrado no log do servidor.',
  'Connection refused: the program that connected belongs to another system user.':
    'Conexão recusada: o programa que conectou pertence a outro usuário do sistema.',
  'Connection refused: it could not be confirmed that the program that connected belongs to the same system user.':
    'Conexão recusada: não foi possível confirmar que o programa que conectou pertence ao mesmo usuário do sistema.',
  'Required field missing: {field}.': 'Campo obrigatório ausente: {field}.',
  'Invalid request: a field has an unexpected type or format.':
    'Requisição inválida: um campo tem tipo ou formato inesperado.',
  'Internal failure of the reader ({kind}); the scan was not completed. The folder was not changed; reopen the app and, if it persists, report the error.':
    'Falha interna do leitor ({kind}); a leitura não foi concluída. O diretório não foi alterado; reabra o aplicativo e, se persistir, relate o erro.',
  'Unauthorized origin.': 'Origem não autorizada.',
  'Give a folder.': 'Informe um diretório.',
  'Route not found.': 'Rota não encontrada.',
  'Invalid path.': 'Caminho inválido.',
  'Invalid Content-Length header.': 'Cabeçalho Content-Length inválido.',
  'Invalid or too large JSON request.': 'Requisição JSON inválida ou muito grande.',
  'The request body is not UTF-8.': 'O corpo da requisição não está em UTF-8.',
  'The JSON request exceeded the depth limit.': 'Requisição JSON excedeu o limite de profundidade.',
  'The request body is not valid JSON.': 'O corpo da requisição não é um JSON válido.',
  'The option to include conventions must be a boolean.':
    'A opção de incluir convenções deve ser booleana.',
  'Close a folder before creating another (limit of {max}).':
    'Feche um diretório antes de criar outro (limite de {max}).',
  'Folder created at {path}, but the project could not be opened or saved. The files were kept. Use “Add folder” to open that path after solving the error: {error}':
    'Diretório criado em {path}, mas não foi possível abrir ou salvar o projeto. Os arquivos foram preservados. Use “Adicionar diretório” para abrir esse caminho após resolver o erro: {error}',
};
