"""Starter texts of a created architecture, in English and Portuguese. Data only.

Nothing here may name a file in backticks, write a path or write a link: the reader
would turn it into a relation nobody drew. The only links are the `{path}` of the
relation sentences, which `blueprint` fills with the drawn relation. Both languages keep
the same keys and the same shape, line by line (tests/test_creation_defaults.py).

`entry` (the AGENTS.md) holds `{name}` in its title and `{map}` where the Map lines go;
each `node` text holds `{name}` in its title. `blueprint` replaces `{name}` first and
concatenates the user's descriptions, so a placeholder typed by the user stays text.
"""

LANGUAGES = ('en', 'pt')
DEFAULT_LANGUAGE = 'en'
TEXTS = {
    'en': {
        'entry': (
            '# {name}\n'
            '\n'
            '## Purpose\n'
            '\n'
            'TODO: two or three sentences: what this project is and what the agent does here.\n'
            '\n'
            '## Always\n'
            '\n'
            '- TODO: a rule that holds in every task, concrete enough to check.\n'
            '\n'
            '## Map\n'
            '\n'
            'The files below are not loaded on their own. Open one when its line applies.\n'
            '\n'
            '{map}\n'
        ),
        'claude': (
            '@AGENTS.md\n'
            '\n'
            '<!-- Claude Code loads this file; the line above imports the shared entry file. Add Claude-only instructions below. -->\n'
        ),
        'pointer_gap': 'TODO: what this file holds; when to open it.',
        'relations': '## Relations',
        'relation': {
            'references': '- See [{name}]({path}) when relevant.',
            'reads': '- Read [{name}]({path}) before acting.',
            'uses': '- Use [{name}]({path}).',
            'governs': '- Follow [{name}]({path}).',
        },
        'node': {
            'agent': (
                '# {name}\n'
                '\n'
                '## Purpose\n'
                '\n'
                'TODO: what this agent is responsible for.\n'
                '\n'
                '## Instructions\n'
                '\n'
                '- Inputs: TODO.\n'
                '- Output: TODO.\n'
                '- Out of scope: TODO.\n'
                '- Done when: TODO.\n'
            ),
            'memory': (
                '# {name}\n'
                '\n'
                '## Purpose\n'
                '\n'
                'TODO: what this memory keeps.\n'
                '\n'
                '## How to use this memory\n'
                '\n'
                '- Write only what stays true across sessions: decisions, preferences, conventions, open questions.\n'
                '- One line per entry: `YYYY-MM-DD: fact (source)`.\n'
                '- Update an entry in place when it changes; delete it when it is no longer true.\n'
                '- Do not copy state that a command or another file already shows.\n'
                '- Never store secrets, credentials, personal data or session transcripts.\n'
                '- Keep it under 200 lines; move detail to another file and link it from here.\n'
                '\n'
                '## Entries\n'
                '\n'
                'None yet.\n'
            ),
            'tool': (
                '# {name}\n'
                '\n'
                '## Purpose\n'
                '\n'
                'TODO: what this tool does.\n'
                '\n'
                '## How to use this tool\n'
                '\n'
                '- When to use: TODO.\n'
                '- When not to use: TODO.\n'
                '- How to run it: TODO (command, API or MCP server, with exact arguments).\n'
                '- Inputs and outputs: TODO.\n'
                '- Limits and failure modes: TODO.\n'
                '\n'
                'This file describes the tool. It does not install it or grant access; the harness does.\n'
            ),
            'policy': (
                '# {name}\n'
                '\n'
                '## Purpose\n'
                '\n'
                'TODO: what this policy covers.\n'
                '\n'
                '## Rules\n'
                '\n'
                '- TODO: one rule per line, short and checkable ("Always ...", "Never ...").\n'
                '\n'
                'These rules are instructions; nothing here blocks an action. To block one, use the permission or hook settings of your harness.\n'
            ),
            'workflow': (
                '# {name}\n'
                '\n'
                '## Purpose\n'
                '\n'
                'TODO: what this workflow produces.\n'
                '\n'
                '## When to use\n'
                '\n'
                'TODO: the request or situation that starts it.\n'
                '\n'
                '## When not to use\n'
                '\n'
                'TODO: cases that look similar and should not follow these steps.\n'
                '\n'
                '## Steps\n'
                '\n'
                '1. TODO: an imperative step, with what it needs and what it produces.\n'
                '2. TODO.\n'
                '\n'
                '## Done when\n'
                '\n'
                'TODO: how to check that it worked.\n'
            ),
            'document': (
                '# {name}\n'
                '\n'
                '## Purpose\n'
                '\n'
                'TODO: what this document covers.\n'
                '\n'
                '## Content\n'
                '\n'
                'TODO.\n'
            ),
        },
    },
    'pt': {
        'entry': (
            '# {name}\n'
            '\n'
            '## Propósito\n'
            '\n'
            'TODO: duas ou três frases: o que é este projeto e o que o agente faz aqui.\n'
            '\n'
            '## Sempre\n'
            '\n'
            '- TODO: regra que vale em qualquer tarefa, concreta o bastante para conferir.\n'
            '\n'
            '## Mapa\n'
            '\n'
            'Os arquivos abaixo não são carregados automaticamente. Abra um quando a linha dele se aplicar.\n'
            '\n'
            '{map}\n'
        ),
        'claude': (
            '@AGENTS.md\n'
            '\n'
            '<!-- O Claude Code carrega este arquivo; a linha acima importa o arquivo de entrada comum. Instruções só para o Claude Code vão abaixo. -->\n'
        ),
        'pointer_gap': 'TODO: o que há neste arquivo; quando abrir.',
        'relations': '## Relações',
        'relation': {
            'references': '- Consulte [{name}]({path}) quando for relevante.',
            'reads': '- Leia [{name}]({path}) antes de agir.',
            'uses': '- Use [{name}]({path}).',
            'governs': '- Siga [{name}]({path}).',
        },
        'node': {
            'agent': (
                '# {name}\n'
                '\n'
                '## Propósito\n'
                '\n'
                'TODO: pelo que este agente responde.\n'
                '\n'
                '## Instruções\n'
                '\n'
                '- Entradas: TODO.\n'
                '- Saída: TODO.\n'
                '- Fora do escopo: TODO.\n'
                '- Pronto quando: TODO.\n'
            ),
            'memory': (
                '# {name}\n'
                '\n'
                '## Propósito\n'
                '\n'
                'TODO: o que esta memória guarda.\n'
                '\n'
                '## Como usar esta memória\n'
                '\n'
                '- Escreva só o que continua valendo entre sessões: decisões, preferências, convenções, perguntas em aberto.\n'
                '- Uma linha por entrada: `AAAA-MM-DD: fato (fonte)`.\n'
                '- Atualize a entrada no lugar quando ela mudar; apague-a quando deixar de valer.\n'
                '- Não copie estado que um comando ou outro arquivo já mostra.\n'
                '- Nunca guarde segredos, credenciais, dados pessoais nem transcrições de sessão.\n'
                '- Mantenha abaixo de 200 linhas; leve o detalhe para outro arquivo e aponte para ele daqui.\n'
                '\n'
                '## Entradas\n'
                '\n'
                'Nenhuma ainda.\n'
            ),
            'tool': (
                '# {name}\n'
                '\n'
                '## Propósito\n'
                '\n'
                'TODO: o que esta ferramenta faz.\n'
                '\n'
                '## Como usar esta ferramenta\n'
                '\n'
                '- Quando usar: TODO.\n'
                '- Quando não usar: TODO.\n'
                '- Como executar: TODO (comando, API ou servidor MCP, com os argumentos exatos).\n'
                '- Entradas e saídas: TODO.\n'
                '- Limites e modos de falha: TODO.\n'
                '\n'
                'Este arquivo descreve a ferramenta. Ele não a instala nem dá acesso a ela; isso é do harness.\n'
            ),
            'policy': (
                '# {name}\n'
                '\n'
                '## Propósito\n'
                '\n'
                'TODO: o que esta política cobre.\n'
                '\n'
                '## Regras\n'
                '\n'
                '- TODO: uma regra por linha, curta e conferível ("Sempre ...", "Nunca ...").\n'
                '\n'
                'Estas regras são instruções; nada aqui bloqueia uma ação. Para bloquear, use as permissões ou os hooks do seu harness.\n'
            ),
            'workflow': (
                '# {name}\n'
                '\n'
                '## Propósito\n'
                '\n'
                'TODO: o que este fluxo produz.\n'
                '\n'
                '## Quando usar\n'
                '\n'
                'TODO: o pedido ou a situação que dá início a ele.\n'
                '\n'
                '## Quando não usar\n'
                '\n'
                'TODO: casos parecidos que não devem seguir estes passos.\n'
                '\n'
                '## Passos\n'
                '\n'
                '1. TODO: um passo no imperativo, com o que ele precisa e o que produz.\n'
                '2. TODO.\n'
                '\n'
                '## Pronto quando\n'
                '\n'
                'TODO: como conferir que deu certo.\n'
            ),
            'document': (
                '# {name}\n'
                '\n'
                '## Propósito\n'
                '\n'
                'TODO: o que este documento cobre.\n'
                '\n'
                '## Conteúdo\n'
                '\n'
                'TODO.\n'
            ),
        },
    },
}
