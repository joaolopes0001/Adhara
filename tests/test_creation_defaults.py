"""The starter text of a created architecture: what the reader sees in it, in both languages.

A created directory is only Markdown (no manifest): the links are the one source of its relations. The entry
file holds only gaps and pointers; each drawn relation is one sentence with one link; `governs` is written in
the governed file. A description typed by the user becomes the Map line of its file and never a relation.
"""
import io
import itertools
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'server'))
from creation_texts import DEFAULT_LANGUAGE, LANGUAGES, TEXTS
from main import make_handler
from scanner import extract, find_path, scan
from tests.creation_golden import FILES as GOLDEN_FILES, PAYLOADS as GOLDEN_PAYLOADS
from tests.server_pack import portuguese
from workspace import DESCRIPTION_MAX, VERBS, Workspace, blueprint, create_directory

SIX = {
    'name': 'seis-tipos',
    'primitives': [
        {'name': 'pesquisador', 'type': 'agent'}, {'name': 'contexto', 'type': 'memory'}, {'name': 'busca', 'type': 'tool'},
        {'name': 'regras', 'type': 'policy'}, {'name': 'revisao', 'type': 'workflow'}, {'name': 'glossario', 'type': 'document'},
    ],
    'relationships': [
        {'source': 'pesquisador', 'target': 'contexto', 'type': 'reads'},
        {'source': 'pesquisador', 'target': 'busca', 'type': 'uses'},
        {'source': 'regras', 'target': 'pesquisador', 'type': 'governs'},
        {'source': 'revisao', 'target': 'glossario', 'type': 'references'},
    ],
}
# The example of the design: one node of each type, the four verbs.
EXAMPLE = {
    'name': 'my-architecture',
    'primitives': [
        {'name': 'assistant', 'type': 'agent', 'description': 'what this agent does and hands back; open it when you take this role.'},
        {'name': 'context', 'type': 'memory', 'description': 'decisions in force; read before changing what was already decided.'},
        {'name': 'search', 'type': 'tool', 'description': 'how to search the project records; open it before answering from memory.'},
        {'name': 'rules', 'type': 'policy', 'description': 'rules the work must follow; read before you finish a task.'},
        {'name': 'release', 'type': 'workflow', 'description': 'steps to publish a version; open it when asked to release.'},
        {'name': 'glossary', 'type': 'document', 'description': 'terms of this project; open it when a word is unclear.'},
    ],
    'relationships': [
        {'source': 'assistant', 'target': 'context', 'type': 'reads'},
        {'source': 'assistant', 'target': 'glossary', 'type': 'references'},
        {'source': 'assistant', 'target': 'search', 'type': 'uses'},
        {'source': 'rules', 'target': 'assistant', 'type': 'governs'},
        {'source': 'release', 'target': 'search', 'type': 'uses'},
    ],
}
# Headings of each node type, in order, by language.
SECTIONS = {
    'en': {'agent': ['Purpose', 'Instructions'], 'memory': ['Purpose', 'How to use this memory', 'Entries'],
           'tool': ['Purpose', 'How to use this tool'], 'policy': ['Purpose', 'Rules'],
           'workflow': ['Purpose', 'When to use', 'When not to use', 'Steps', 'Done when'], 'document': ['Purpose', 'Content']},
    'pt': {'agent': ['Propósito', 'Instruções'], 'memory': ['Propósito', 'Como usar esta memória', 'Entradas'],
           'tool': ['Propósito', 'Como usar esta ferramenta'], 'policy': ['Propósito', 'Regras'],
           'workflow': ['Propósito', 'Quando usar', 'Quando não usar', 'Passos', 'Pronto quando'], 'document': ['Propósito', 'Conteúdo']},
}
ENTRY_HEADINGS = {'en': ['Purpose', 'Always', 'Map'], 'pt': ['Propósito', 'Sempre', 'Mapa']}
RELATIONS_HEADING = {'en': '## Relations', 'pt': '## Relações'}
SENTENCE = {
    'en': {'references': '- See [{name}]({path}) when relevant.', 'reads': '- Read [{name}]({path}) before acting.',
           'uses': '- Use [{name}]({path}).', 'governs': '- Follow [{name}]({path}).'},
    'pt': {'references': '- Consulte [{name}]({path}) quando for relevante.', 'reads': '- Leia [{name}]({path}) antes de agir.',
           'uses': '- Use [{name}]({path}).', 'governs': '- Siga [{name}]({path}).'},
}
GAP = {'en': 'TODO: what this file holds; when to open it.', 'pt': 'TODO: o que há neste arquivo; quando abrir.'}
PATH_MESSAGE = 'do not write a file path; to link to another file, create a relation.'
SIGNS_MESSAGE = 'do not use backticks, brackets, @ or the signs < and >.'
CONTROL_MESSAGE = 'use a single line, without control characters.'
LENGTH_MESSAGE = f'use up to {DESCRIPTION_MAX} characters.'
LANGUAGE_MESSAGE = 'Invalid language of the starting text: use "en" or "pt".'
# Accepted descriptions that look like paths, markup or templates (design, 4.2): they stay text.
HOSTILE_ACCEPTED = [
    'memory/context.md', 'rules.md', 'AGENTS.md e CLAUDE.md', 'x.md:41', 'docs/guia.md#parte', 'https://example.com/a/b.md',
    '{name} {map} {path}', '# título', '* item', 'a | b', '$HOME', 'a \\n b', 'ends with a backslash \\', 'emoji \U0001F600 ok',
    '~~~', '~~~ md', '---', '***', '!--', 'x' * DESCRIPTION_MAX,
]
# Refused descriptions and the end of their message (design, 4.2).
HOSTILE_REFUSED = [
    ('[x](y.md)', SIGNS_MESSAGE), ('[[wiki]]', SIGNS_MESSAGE), ('[a]: b.md', SIGNS_MESSAGE), ('`x`', SIGNS_MESSAGE),
    ('see `notes.md`', SIGNS_MESSAGE), ('<b>x</b>', SIGNS_MESSAGE), ('<!-- hidden -->', SIGNS_MESSAGE), ('-->', SIGNS_MESSAGE),
    ('@notas.md', SIGNS_MESSAGE), ('@memory/context.md', SIGNS_MESSAGE), ('me@example.com', SIGNS_MESSAGE),
    ('a\nb', CONTROL_MESSAGE), ('a\tb', CONTROL_MESSAGE), ('a\rb', CONTROL_MESSAGE), ('a\x00b', CONTROL_MESSAGE),
    ('a\x7fb', CONTROL_MESSAGE), ('a\u2028b', CONTROL_MESSAGE), ('a\u2029b', CONTROL_MESSAGE), ('a\u202eb', CONTROL_MESSAGE),
    ('a\u200eb', CONTROL_MESSAGE), ('a\u2066b', CONTROL_MESSAGE),
    ('./notas.md', PATH_MESSAGE), ('../memory/context.md', PATH_MESSAGE), ('~/notas.md', PATH_MESSAGE),
    ('/etc/passwd/x', PATH_MESSAGE), ('see ./notes for this', PATH_MESSAGE), ('…/a/b.py', PATH_MESSAGE), ('.../a/b.py', PATH_MESSAGE),
    ('a\udcffb', CONTROL_MESSAGE), ('\ud800', CONTROL_MESSAGE),
    ('[', SIGNS_MESSAGE), (']', SIGNS_MESSAGE), ('<', SIGNS_MESSAGE), ('>', SIGNS_MESSAGE), ('`', SIGNS_MESSAGE), ('@', SIGNS_MESSAGE),
    ('x' * (DESCRIPTION_MAX + 1), LENGTH_MESSAGE), ('x' * 2000, LENGTH_MESSAGE),
]


# Node names: words of the texts, type folders, names special elsewhere, templates and limits.
NAMES = ['AGENTS', 'CLAUDE', 'SKILL', 'agents', 'Agents', 'claude', 'Claude', 'AGENTS-x', 'AGENTS_', 'CLAUDE-local', 'CLAUDE_local',
         'xAGENTS', 'AGENT', 'CLAUD', 'skill', 'Skill', 'SKILLS', 'README', 'readme', 'index', 'INDEX', 'MEMORY', 'memory', 'Memory',
         'memoria', 'memories', 'GEMINI', 'CODEX', 'agent-architecture', 'manifest', 'plugin', 'mcp', 'marketplace', 'settings', 'config',
         'package', 'agent', 'tool', 'policy', 'workflow', 'document', 'Map', 'Mapa', 'Purpose', 'Always', 'Sempre', 'TODO', 'Relations',
         'Follow', 'Siga', 'See', 'Read', 'Use', 'Leia', 'Consulte', 'name', 'map', 'path', 'XX', 'NNN', 'YYYY', 'AAAA', 'YYYY-MM-DD',
         'N', 'X', 'NN-XX', '0', '1', '00', 'true', 'null', 'None', 'con', 'nul', 'aux', 'a', 'A', 'a-', 'a_', 'a--b', 'a__b', '9', 'x' * 60,
         'md', 'json', 'txt', 'http', 'file', 'TODO-TODO']
RESERVED = {'AGENTS': 'entry file', 'CLAUDE': 'entry file', 'SKILL': 'skill'}
# The same, as a Portuguese interface words it (the kind is a phrase of its own, but for the name Skill).
RESERVED_PT = {'AGENTS': 'arquivo de entrada', 'CLAUDE': 'arquivo de entrada', 'SKILL': 'skill'}


def with_language(payload, language=None, descriptions=True):
    """`payload` in `language` (None: no field, the old body), with or without the descriptions."""
    result = json.loads(json.dumps(payload))
    if language is not None:
        result['language'] = language
    if not descriptions:
        for item in result['primitives']:
            item.pop('description', None)
    return result


def drawn_edges(payload):
    """The relations the reader must see in a created directory, computed from the payload alone:
    the Map links of the entry, one link per drawn relation (in the governed file for governs) and the import."""
    path = {p['name']: f'{p["type"]}/{p["name"]}.md' for p in payload['primitives']}
    edges = [('AGENTS.md', path[p['name']], 'markdown') for p in payload['primitives']]
    for rel in payload.get('relationships', []):
        verb = rel.get('type', 'references')
        holder, linked = (rel['target'], rel['source']) if verb == 'governs' else (rel['source'], rel['target'])
        edges.append((path[holder], path[linked], 'markdown'))
    edges.append(('CLAUDE.md', 'AGENTS.md', 'import'))
    return sorted(edges)


def line_shape(line):
    for shape, pattern in (('empty', r''), ('h1', r'# .*'), ('h2', r'## .*'), ('item', r'- .*'), ('numbered', r'\d+\. .*'),
                           ('comment', r'<!--.*-->'), ('import', r'@\S+')):
        if re.fullmatch(pattern, line):
            return shape
    return 'paragraph'


def leaves(value, prefix=()):
    if isinstance(value, dict):
        for key in value:
            yield from leaves(value[key], prefix + (key,))
    else:
        yield prefix, value


def keys_tree(value):
    return {k: keys_tree(v) for k, v in value.items()} if isinstance(value, dict) else None


class CreationDefaultsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.parent = Path(self.tmp.name)
        self.count = 0

    def create(self, payload):
        self.count += 1
        return Path(create_directory({**payload, 'name': f'{payload["name"]}-{self.count}', 'parent': str(self.parent)}))

    def written(self, root):
        return {str(p.relative_to(root)): p.read_text(encoding='utf-8') for p in root.rglob('*') if p.is_file()}

    def read(self, root):
        return scan([str(root)])

    def edges(self, model, root):
        return sorted((os.path.relpath(e['source'], root), os.path.relpath(e['target'], root), e['kind']) for e in model['edges'])

    def check_clean(self, payload):
        """Created directory: preview == written, no observation, every document reachable, no logical object,
        only the drawn links and the import, and no manifest."""
        root = self.create(payload)
        written = self.written(root)
        self.assertEqual(written, blueprint({**payload, 'name': root.name}))
        self.assertNotIn('agent-architecture.json', written)
        model = self.read(root)
        self.assertEqual(model['issues'], [])
        reach = model['stats']['reachability']
        self.assertEqual(reach['reachable'], reach['documents'])
        self.assertEqual(model['objects'], [])
        self.assertEqual(self.edges(model, root), drawn_edges(payload))
        return root, model

    def audit(self, root):
        """`aae audit --root` as a person runs it: the JSON report of the CLI."""
        done = subprocess.run([sys.executable, str(REPO / 'scripts/aae.py'), 'audit', '--root', str(root)],
                              capture_output=True, text=True, check=True)
        return json.loads(done.stdout)

    def findings(self, root):
        return sorted((f['code'], f.get('path'), f.get('line')) for f in self.audit(root)['findings'])

    # Files and reading

    def test_files_are_the_nodes_and_the_two_entry_files(self):
        for language in LANGUAGES:
            files = blueprint(with_language(SIX, language))
            self.assertEqual(list(files), [f'{p["type"]}/{p["name"]}.md' for p in SIX['primitives']] + ['AGENTS.md', 'CLAUDE.md'])
            self.assertEqual(files['CLAUDE.md'].splitlines()[0], '@AGENTS.md')

    def test_reader_sees_no_observation_and_no_signal(self):
        for payload in (SIX, EXAMPLE):
            for language in LANGUAGES:
                for descriptions in (True, False):
                    with self.subTest(name=payload['name'], language=language, descriptions=descriptions):
                        root, model = self.check_clean(with_language(payload, language, descriptions))
                        self.assertEqual(model['signals'], [])
                        self.assertEqual(model['stats']['structure']['repeatedReferences'], 0)

    def test_each_type_has_its_sections_and_relations_only_when_drawn(self):
        for language in LANGUAGES:
            files = blueprint(with_language(SIX, language))
            for item in SIX['primitives']:
                text = files[f'{item["type"]}/{item["name"]}.md']
                headings = [line[3:] for line in text.splitlines() if line.startswith('## ')]
                drawn = any(item['name'] == (r['target'] if r['type'] == 'governs' else r['source']) for r in SIX['relationships'])
                expected = SECTIONS[language][item['type']] + ([RELATIONS_HEADING[language][3:]] if drawn else [])
                self.assertEqual(headings, expected, (language, item['name']))
                self.assertTrue(text.startswith(f'# {item["name"]}\n'))
                self.assertNotRegex(text, r'(?m)^(Type|Tipo):')
                self.assertNotIn('None yet.\n\n## Relations', text)
            # The policy governs: it holds no line; the governed agent does.
            self.assertNotIn('](', files['policy/regras.md'])
            self.assertIn(SENTENCE[language]['reads'].format(name='contexto', path='../memory/contexto.md'), files['agent/pesquisador.md'])

    def test_defaults_name_no_file_in_backticks_and_repeat_no_path(self):
        for language in LANGUAGES:
            files = blueprint(with_language(EXAMPLE, language))
            for relative, text in files.items():
                for code in re.findall(r'`([^`\n]+)`', text):
                    self.assertNotRegex(code, r'[./\\]', (language, relative, code))
            model = self.read(self.create(with_language(EXAMPLE, language)))
            self.assertEqual({e['kind'] for e in model['edges']}, {'markdown', 'import'})

    def test_the_entry_holds_only_gaps_and_pointers(self):
        for language in LANGUAGES:
            for descriptions in (True, False):
                payload = with_language(EXAMPLE, language, descriptions)
                entry = blueprint(payload)['AGENTS.md']
                lead = TEXTS[language]['entry'].split('\n\n{map}')[0].splitlines()[-1]
                headings = []
                for line in entry.splitlines():
                    if line.startswith('## '):
                        headings.append(line[3:])
                    elif not (line == '' or line == f'# {payload["name"]}' or line.startswith(('TODO: ', '- TODO: ')) or line == lead
                              or re.fullmatch(r'- \[[\w-]+\]\(\w+/[\w-]+\.md\): .+', line)):
                        self.fail(f'unexpected line in the entry ({language}): {line!r}')
                self.assertEqual(headings, ENTRY_HEADINGS[language])
                for word in ('manifest', 'Agent Architecture Explorer', 'aae audit', '<!--'):
                    self.assertNotIn(word, entry)

    def test_signals_about_the_drawn_structure_stay(self):
        payload = {'name': 'desenho', 'primitives': [{'name': 'a', 'type': 'agent'}, {'name': 'm', 'type': 'memory'}],
                   'relationships': [{'source': 'a', 'target': 'm', 'type': 'reads'}, {'source': 'a', 'target': 'm', 'type': 'references'},
                                     {'source': 'm', 'target': 'a', 'type': 'references'}]}
        root, model = self.check_clean(payload)
        self.assertEqual(sorted((s['code'], os.path.relpath(s['node'], root)) for s in model['signals']),
                         [('cycle', 'agent/a.md'), ('repeated-reference', 'agent/a.md')])
        # Eleven nodes: no signal (the entry cites eleven files). Twelve: the entry is a high fan-out.
        many = {'name': 'onze', 'primitives': [{'name': f'n{i}', 'type': 'document'} for i in range(11)], 'relationships': []}
        root, model = self.check_clean(many)
        self.assertEqual(model['signals'], [])
        many = {'name': 'doze', 'primitives': [{'name': f'n{i}', 'type': 'document'} for i in range(12)], 'relationships': []}
        root, model = self.check_clean(many)
        self.assertEqual([(s['code'], os.path.relpath(s['node'], root)) for s in model['signals']], [('high-fanout', 'AGENTS.md')])

    # Names

    def test_awkward_but_accepted_names(self):
        payload = {'name': 'A_b-9', 'primitives': [{'name': 'Z9_a-b', 'type': 'agent'}, {'name': '0-x_Y', 'type': 'tool'}],
                   'relationships': [{'source': 'Z9_a-b', 'target': '0-x_Y', 'type': 'uses'}]}
        for language in LANGUAGES:
            _, model = self.check_clean(with_language(payload, language))
            self.assertEqual(model['signals'], [])

    def test_names_equal_to_words_of_the_defaults(self):
        words = ['map', 'always', 'purpose', 'TODO', 'Mapa', 'Sempre', 'README', 'index', 'XX', 'NNN', 'relations', 'manifest']
        types = ['agent', 'memory', 'tool', 'policy', 'workflow', 'document'] * 2
        payload = {'name': 'manifest', 'primitives': [{'name': w, 'type': t} for w, t in zip(words, types)][:11],
                   'relationships': [{'source': 'map', 'target': 'always', 'type': 'reads'}, {'source': 'TODO', 'target': 'map', 'type': 'governs'},
                                     {'source': 'Mapa', 'target': 'XX', 'type': 'uses'}, {'source': 'index', 'target': 'NNN', 'type': 'references'}]}
        for language in LANGUAGES:
            _, model = self.check_clean(with_language(payload, language))
            self.assertEqual(model['signals'], [])

    def test_single_node_without_relations(self):
        payload = {'name': 'um', 'primitives': [{'name': 'so', 'type': 'agent'}], 'relationships': []}
        root, _ = self.check_clean(payload)
        text = self.written(root)['agent/so.md']
        self.assertNotIn('## Relations', text)
        self.assertNotIn('None yet.', text)

    def serve(self):
        """POST to an in-process server of the app (the routes /api/blueprint and /api/create): (status, body)."""
        state = Path(tempfile.mkdtemp(dir=self.tmp.name, prefix='state-'))
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(Workspace(state), self.parent, 'tok'))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        quiet = patch('sys.stderr', io.StringIO())
        quiet.start()
        self.addCleanup(quiet.stop)

        def post(route, data):
            request = Request(f'http://127.0.0.1:{server.server_port}{route}', data=json.dumps(data).encode(),
                              headers={'Content-Type': 'application/json', 'X-AAE-Token': 'tok'})
            try:
                with urlopen(request, timeout=5) as response:
                    return response.status, json.load(response)
            except HTTPError as error:
                with error as response:
                    return response.code, json.load(response)
        return post

    def test_a_name_whose_file_the_reader_treats_specially_is_refused(self):
        # The reader takes AGENTS.md and CLAUDE.md as entry files and SKILL.md as a skill, by exact name (scanner.kind).
        # A node with one of these names would be a second entry in a subfolder, or a skill and a logical object nobody
        # drew. The preview and the creation refuse it, over HTTP too, with a message that says why.
        post = self.serve()
        for name, typ in (('AGENTS', 'agent'), ('CLAUDE', 'policy'), ('SKILL', 'tool'), ('AGENTS', 'document'), ('SKILL', 'memory')):
            payload = {'parent': str(self.parent), 'name': 'reservado', 'primitives': [{'name': 'ok', 'type': 'agent'}, {'name': name, 'type': typ}]}
            message = f'Node name {name}: reserved, because the file {name}.md would be read as {RESERVED[name]}.'
            with self.subTest(name=name, type=typ):
                for function in (blueprint, create_directory):
                    with self.assertRaises(ValueError) as caught:
                        function(payload)
                    self.assertEqual(str(caught.exception), message)
                # Over HTTP the sentence comes with its phrase, and a Portuguese interface words it as before.
                kind = RESERVED[name] if name == 'SKILL' else {'phrase': RESERVED[name]}
                phrase = {'phrase': 'Node name {name}: reserved, because the file {name}.md would be read as {kind}.', 'params': {'name': name, 'kind': kind}}
                for route in ('/api/blueprint', '/api/create'):
                    self.assertEqual(post(route, payload), (400, {'error': message, 'errorPhrase': phrase}))
                self.assertEqual(portuguese(message, phrase), f'Nome do nó {name}: reservado, porque o arquivo {name}.md seria lido como {RESERVED_PT[name]}.')
                self.assertFalse((self.parent / 'reservado').exists())
        # Names that do not become a special file stay accepted (the reader compares the exact name).
        alike = ['agents-notes', 'claude2', 'agents', 'claude', 'Agents', 'Claude', 'AGENTS2', 'CLAUDE_md', 'AGENTSx', 'skill', 'Skill', 'SKILLS']
        payload = {'name': 'parecidos', 'primitives': [{'name': n, 'type': 'document'} for n in alike]}
        status, body = post('/api/create', {**payload, 'parent': str(self.parent)})
        self.assertEqual(status, 200, body)
        root = self.parent / 'parecidos'
        model = self.read(root)
        self.assertEqual((model['issues'], model['objects']), ([], []))
        self.assertEqual(sorted(os.path.relpath(s['node'], root) for s in model['stats']['reachability']['starts']), ['AGENTS.md', 'CLAUDE.md'])

    def test_without_the_refusal_a_node_would_be_a_second_entry_or_a_skill(self):
        # Why the names are refused: a tree with those names, built by hand.
        root = self.create({'name': 'motivo', 'primitives': [{'name': 'ok', 'type': 'agent'}]})
        for folder, name in (('policy', 'CLAUDE'), ('tool', 'SKILL')):
            (root / folder).mkdir()
            (root / folder / f'{name}.md').write_text(f'# {name}\n', encoding='utf-8')
            with (root / 'AGENTS.md').open('a', encoding='utf-8') as entry:
                entry.write(f'- [{name}]({folder}/{name}.md): TODO: what this file holds; when to open it.\n')
        model = self.read(root)
        kinds = {os.path.relpath(n['path'], root): n['kind'] for n in model['nodes'] if n['path'].endswith(('CLAUDE.md', 'SKILL.md'))}
        self.assertEqual(kinds, {'CLAUDE.md': 'entry', 'policy/CLAUDE.md': 'entry', 'tool/SKILL.md': 'skill'})
        starts = sorted(os.path.relpath(s['node'], root) for s in model['stats']['reachability']['starts'])
        self.assertEqual(starts, ['AGENTS.md', 'CLAUDE.md', 'policy/CLAUDE.md'])
        self.assertEqual(len(model['objects']), 1)

    def test_no_accepted_name_makes_an_object_or_an_entry(self):
        types = ['agent', 'memory', 'tool', 'policy', 'workflow', 'document']
        refused = set()
        for index, name in enumerate(NAMES):
            for typ in types:
                payload = {'name': 'nome', 'language': LANGUAGES[index % 2],
                           'primitives': [{'name': name, 'type': typ}, {'name': 'outro-no', 'type': 'agent'}, {'name': 'pol-no', 'type': 'policy'}],
                           'relationships': [{'source': 'outro-no', 'target': name, 'type': 'reads'}, {'source': name, 'target': 'outro-no', 'type': 'uses'},
                                             {'source': 'pol-no', 'target': name, 'type': 'governs'}]}
                try:
                    blueprint(payload)
                except ValueError as error:
                    self.assertTrue(str(error).startswith(f'Node name {name}: reserved'), (name, str(error)))
                    refused.add(name)
                    continue
                root, model = self.check_clean(payload)
                starts = sorted(os.path.relpath(s['node'], root) for s in model['stats']['reachability']['starts'])
                self.assertEqual(starts, ['AGENTS.md', 'CLAUDE.md'], (name, typ))
                self.assertEqual({n['kind'] for n in model['nodes'] if n['path'] == str(root / f'{typ}/{name}.md')},
                                 {'memory' if typ == 'memory' else 'file'}, (name, typ))
        self.assertEqual(refused, set(RESERVED))

    def test_preview_and_creation_refuse_the_same_bodies(self):
        post = self.serve()
        base = with_language(EXAMPLE, 'en')
        variants = [('accepted', lambda b: b), ('old body', lambda b: with_language(EXAMPLE, None, False))]
        for text, _ in HOSTILE_REFUSED:
            variants.append((f'description {text[:20]!r}', lambda b, text=text: {**b, 'primitives': [{**b['primitives'][0], 'description': text}] + b['primitives'][1:]}))
        for text in HOSTILE_ACCEPTED:
            variants.append((f'description {text[:20]!r}', lambda b, text=text: {**b, 'primitives': [{**b['primitives'][0], 'description': text}] + b['primitives'][1:]}))
        for value in ('fr', 'pt-BR', None, 1, ''):
            variants.append((f'language {value!r}', lambda b, value=value: {**b, 'language': value}))
        for name in ('AGENTS', 'SKILL', '../x', 'a b', ''):
            variants.append((f'node {name!r}', lambda b, name=name: {**b, 'primitives': [{**b['primitives'][0], 'name': name}] + b['primitives'][1:]}))
        variants += [('description number', lambda b: {**b, 'primitives': [{**b['primitives'][0], 'description': 5}] + b['primitives'][1:]}),
                     ('bad type', lambda b: {**b, 'primitives': [{**b['primitives'][0], 'type': 'x'}] + b['primitives'][1:]}),
                     ('bad verb', lambda b: {**b, 'relationships': [{'source': 'assistant', 'target': 'context', 'type': 'x'}]}),
                     ('unknown node', lambda b: {**b, 'relationships': [{'source': 'assistant', 'target': 'nope'}]}),
                     ('no nodes', lambda b: {**b, 'primitives': []}),
                     ('directory name', lambda b: {**b, 'name': '../x'})]
        for index, (label, change) in enumerate(variants):
            body = change(json.loads(json.dumps(base)))
            body = {**body, 'name': body['name'] if label == 'directory name' else f'paridade-{index}', 'parent': str(self.parent)}
            with self.subTest(label):
                preview, created = post('/api/blueprint', body), post('/api/create', body)
                self.assertEqual(preview[0], created[0], (preview, created))
                if preview[0] == 400:
                    self.assertEqual(preview[1], created[1])
                    if label != 'directory name':
                        self.assertFalse((self.parent / body['name']).exists())
                else:
                    self.assertEqual(preview[0], 200)
                    self.assertEqual(self.written(self.parent / body['name']), preview[1]['files'])
                    # A creation also opens the new root, and the app keeps at most 12 open: close it.
                    self.assertEqual(post('/api/close', {'path': str(self.parent / body['name'])})[0], 200)

    def test_each_language_writes_its_own_text_and_no_local_path(self):
        other = {'en': ('## Propósito', 'TODO: o que', '## Relações', 'Leia ['), 'pt': ('## Purpose', 'TODO: what', '## Relations', 'Read [')}
        for language in LANGUAGES:
            for relative, text in blueprint(with_language(EXAMPLE, language, False)).items():
                for fragment in other[language]:
                    self.assertNotIn(fragment, text, (language, relative))
                self.assertNotIn('/home/', text)
                self.assertNotIn('Descreva', text)

    # The two sets of text

    def test_both_languages_have_the_same_structure(self):
        self.assertEqual(LANGUAGES, ('en', 'pt'))
        self.assertIn(DEFAULT_LANGUAGE, LANGUAGES)
        self.assertEqual(keys_tree(TEXTS['en']), keys_tree(TEXTS['pt']))
        pt = dict(leaves(TEXTS['pt']))
        for key, en_text in leaves(TEXTS['en']):
            en_lines, pt_lines = en_text.split('\n'), pt[key].split('\n')
            self.assertEqual([line_shape(x) for x in en_lines], [line_shape(x) for x in pt_lines], key)
            for en_line, pt_line in zip(en_lines, pt_lines):
                for token in ('TODO', '{name}', '{map}', '{path}', '`', '['):
                    self.assertEqual(en_line.count(token), pt_line.count(token), (key, token, en_line, pt_line))

    def test_the_raw_texts_hold_no_reference_but_the_import(self):
        for language in LANGUAGES:
            for key, text in leaves(TEXTS[language]):
                for code in re.findall(r'`([^`\n]+)`', text):
                    self.assertNotRegex(code, r'[./]', (language, key, code))
                found = [(raw, syntax) for raw, syntax, *_ in extract(text, '.md')]
                if key == ('claude',):
                    self.assertEqual(found, [('AGENTS.md', 'import')])
                elif key[0] == 'relation':
                    self.assertEqual(found, [('{path}', 'markdown')], (language, key))
                else:
                    self.assertEqual(found, [], (language, key))

    # Relations

    def test_governs_is_written_in_the_governed_file(self):
        payload = {'name': 'regra', 'primitives': [{'name': 'a', 'type': 'agent'}, {'name': 'p', 'type': 'policy'}],
                   'relationships': [{'source': 'p', 'target': 'a', 'type': 'governs'}]}
        for language in LANGUAGES:
            root, model = self.check_clean(with_language(payload, language))
            files = self.written(root)
            self.assertIn(SENTENCE[language]['governs'].format(name='p', path='../policy/p.md'), files['agent/a.md'])
            self.assertNotIn('](', files['policy/p.md'])
            edges = self.edges(model, root)
            self.assertIn(('agent/a.md', 'policy/p.md', 'markdown'), edges)
            self.assertNotIn(('policy/p.md', 'agent/a.md', 'markdown'), edges)
            self.assertTrue(find_path(model, str(root / 'agent/a.md'), str(root / 'policy/p.md'))['found'])
            self.assertEqual(model['signals'], [])

    def test_each_verb_has_its_sentence_in_each_language(self):
        for language in LANGUAGES:
            for verb in VERBS:
                payload = {'name': 'verbo', 'language': language,
                           'primitives': [{'name': 'a', 'type': 'agent'}, {'name': 'b', 'type': 'policy' if verb == 'governs' else 'document'}],
                           'relationships': [{'source': 'b', 'target': 'a', 'type': verb} if verb == 'governs' else {'source': 'a', 'target': 'b', 'type': verb}]}
                files = blueprint(payload)
                linked = 'policy/b.md' if verb == 'governs' else 'document/b.md'
                line = SENTENCE[language][verb].format(name='b', path='../' + linked)
                self.assertTrue(files['agent/a.md'].endswith(f'\n{RELATIONS_HEADING[language]}\n\n{line}\n'), (language, verb))
                self.assertEqual(files[linked].count(']('), 0)

    def test_references_one_way_and_governs_the_other_is_a_repeated_reference(self):
        payload = {'name': 'par', 'primitives': [{'name': 'a', 'type': 'agent'}, {'name': 'p', 'type': 'policy'}],
                   'relationships': [{'source': 'a', 'target': 'p', 'type': 'references'}, {'source': 'p', 'target': 'a', 'type': 'governs'}]}
        root, model = self.check_clean(payload)
        self.assertEqual([(s['code'], os.path.relpath(s['node'], root)) for s in model['signals']], [('repeated-reference', 'agent/a.md')])
        # A policy that governs itself is a self link: counted, no signal.
        payload = {'name': 'proprio', 'primitives': [{'name': 'p', 'type': 'policy'}], 'relationships': [{'source': 'p', 'target': 'p', 'type': 'governs'}]}
        root, model = self.check_clean(payload)
        self.assertEqual(model['signals'], [])

    # Descriptions and language

    def test_governs_counts_in_the_direction_it_is_written(self):
        # For the reader, governs is a link from the governed file to its policy. So governs with another relation in
        # the same drawn direction is a cycle, and in opposite drawn directions a repeated reference; a drawn loop that
        # goes through a governs is no loop for the reader.
        cases = [
            ([('p', 'a', 'governs'), ('p', 'a', 'references')], [('cycle', 'agent/a.md')]),
            ([('a', 'p', 'references'), ('p', 'a', 'governs')], [('repeated-reference', 'agent/a.md')]),
            ([('p', 'a', 'governs'), ('p', 'c', 'reads'), ('c', 'a', 'references')], [('cycle', 'agent/a.md')]),
            ([('p', 'a', 'governs'), ('a', 't', 'uses'), ('t', 'p', 'references')], []),
        ]
        nodes = [{'name': 'a', 'type': 'agent'}, {'name': 'p', 'type': 'policy'}, {'name': 'c', 'type': 'memory'}, {'name': 't', 'type': 'tool'}]
        for relations, signals in cases:
            payload = {'name': 'sinais', 'primitives': nodes, 'relationships': [{'source': s, 'target': t, 'type': v} for s, t, v in relations]}
            with self.subTest(relations=relations):
                root, model = self.check_clean(payload)
                self.assertEqual(sorted((s['code'], os.path.relpath(s['node'], root)) for s in model['signals']), signals)

    def test_the_starter_texts_are_kept(self):
        # Golden files: the example of the design, in both languages, with and without descriptions, byte for byte.
        self.assertEqual(set(GOLDEN_PAYLOADS), {'en', 'pt', 'en-without-descriptions', 'pt-without-descriptions'})
        for key, payload in GOLDEN_PAYLOADS.items():
            with self.subTest(key):
                self.assertEqual(blueprint(payload), GOLDEN_FILES[key])
        # The description lives only in the Map line, never in the file of its node.
        for item in GOLDEN_PAYLOADS['en']['primitives']:
            self.assertEqual(sum(text.count(item['description']) for text in GOLDEN_FILES['en'].values()), 1)

    def test_the_description_is_the_map_line(self):
        for language in LANGUAGES:
            for value, line in (('  when to open it.  ', 'when to open it.'), ('', GAP[language]), ('   ', GAP[language]), (None, GAP[language])):
                item = {'name': 'a', 'type': 'agent'} if value is None else {'name': 'a', 'type': 'agent', 'description': value}
                entry = blueprint({'name': 'd', 'language': language, 'primitives': [item]})['AGENTS.md']
                self.assertTrue(entry.endswith(f'\n- [a](agent/a.md): {line}\n'), (language, value))

    def test_hostile_but_accepted_descriptions_create_no_relation(self):
        for index, text in enumerate(HOSTILE_ACCEPTED):
            language = LANGUAGES[index % 2]
            payload = {'name': 'aceito', 'language': language,
                       'primitives': [{'name': 'a', 'type': 'agent', 'description': text}, {'name': 'm', 'type': 'memory', 'description': text}],
                       'relationships': [{'source': 'a', 'target': 'm', 'type': 'reads'}]}
            with self.subTest(text=text):
                root, model = self.check_clean(payload)
                self.assertIn(f'- [a](agent/a.md): {text}\n- [m](memory/m.md): {text}\n', self.written(root)['AGENTS.md'])
                self.assertEqual(model['signals'], [])

    def test_refused_descriptions(self):
        for text, message in HOSTILE_REFUSED:
            payload = {'name': 'recusado', 'primitives': [{'name': 'ok', 'type': 'agent', 'description': 'fine'},
                                                          {'name': 'mau', 'type': 'memory', 'description': text}]}
            with self.subTest(text=text):
                with self.assertRaises(ValueError) as caught:
                    blueprint(payload)
                self.assertEqual(str(caught.exception), f'Description of mau: {message}')
                with self.assertRaises(ValueError):
                    create_directory({**payload, 'parent': str(self.parent)})
                self.assertFalse((self.parent / 'recusado').exists())

    def test_description_and_language_types(self):
        for value in (5, None, ['a'], {'a': 1}, True):
            with self.subTest(description=value), self.assertRaises(ValueError) as caught:
                blueprint({'name': 'tipo', 'primitives': [{'name': 'a', 'type': 'agent', 'description': value}]})
            self.assertEqual(str(caught.exception), 'Description of a: it must be text.')
        for value in ('fr', 'pt-BR', 'EN', 'PT', '', ' en', None, 1, ['en'], {'en': 1}, True):
            with self.subTest(language=value), self.assertRaises(ValueError) as caught:
                blueprint({'name': 'idioma', 'language': value, 'primitives': [{'name': 'a', 'type': 'agent'}]})
            self.assertEqual(str(caught.exception), LANGUAGE_MESSAGE)
        self.assertEqual(blueprint(with_language(EXAMPLE)), blueprint(with_language(EXAMPLE, 'en')))
        # The limit, as a number: 200 characters accepted, 201 refused.
        self.assertEqual(DESCRIPTION_MAX, 200)
        blueprint({'name': 'limite', 'primitives': [{'name': 'a', 'type': 'agent', 'description': 'x' * 200}]})
        with self.assertRaisesRegex(ValueError, 'use up to 200 characters'):
            blueprint({'name': 'limite', 'primitives': [{'name': 'a', 'type': 'agent', 'description': 'x' * 201}]})
        # Order of the checks: name of the directory, then language, then the nodes.
        with self.assertRaisesRegex(ValueError, '^Folder name'):
            blueprint({'name': '../x', 'language': 'fr', 'primitives': []})
        with self.assertRaisesRegex(ValueError, '^Invalid language'):
            blueprint({'name': 'x', 'language': 'fr', 'primitives': []})
        with self.assertRaisesRegex(ValueError, '^Each node'):
            blueprint({'name': 'x', 'primitives': [{'name': '../a', 'type': 'agent', 'description': 5}]})
        with self.assertRaisesRegex(ValueError, '^Description of a'):
            blueprint({'name': 'x', 'primitives': [{'name': 'a', 'type': 'agent', 'description': 5}],
                       'relationships': [{'source': 'a', 'target': 'nope'}]})
        # Unknown fields are still ignored.
        self.assertEqual(blueprint({**with_language(EXAMPLE, 'en'), 'extra': 1}), blueprint(with_language(EXAMPLE, 'en')))

    def test_old_body_is_accepted(self):
        old = with_language(EXAMPLE, None, False)
        self.assertNotIn('language', old)
        files = blueprint(old)
        self.assertEqual(files, blueprint(with_language(EXAMPLE, 'en', False)))
        self.assertIn('## Map\n', files['AGENTS.md'])
        self.assertEqual(files['AGENTS.md'].count(GAP['en']), len(EXAMPLE['primitives']))
        _, model = self.check_clean(old)
        self.assertEqual(model['signals'], [])

    def test_every_file_is_reachable_from_the_entry(self):
        types = ['agent', 'memory', 'tool', 'policy', 'workflow', 'document']
        for count in (1, 6, 40):
            payload = {'name': f'n{count}', 'primitives': [{'name': f'n{i}', 'type': types[i % 6]} for i in range(count)],
                       'relationships': [{'source': f'n{i}', 'target': f'n{i + 1}', 'type': VERBS[i % 4]} for i in range(count - 1)]}
            with self.subTest(count=count):
                root, model = self.check_clean(payload)
                reach = model['stats']['reachability']
                self.assertEqual((reach['reachable'], reach['documents'], reach['hops']['max']), (count + 2, count + 2, 1))
                expected = [('high-fanout', 'AGENTS.md')] if count >= 12 else []
                self.assertEqual([(s['code'], os.path.relpath(s['node'], root)) for s in model['signals']], expected)

    def test_the_entry_stays_small(self):
        for payload in (SIX, EXAMPLE):
            for language in LANGUAGES:
                size = len(blueprint(with_language(payload, language, False))['AGENTS.md'].encode('utf-8'))
                self.assertLess(size, 1000, (payload['name'], language))

    # The description never makes a relation

    def test_no_description_makes_a_relation_nobody_drew(self):
        """For many hostile texts, also generated by combination, the server either refuses the description or the
        created directory holds exactly the drawn relations, no observation and no signal."""
        fragments = [
            '', 'a', ' ', 'x.md', 'AGENTS.md', 'CLAUDE.md', 'memory/m.md', 'agent/a.md', './', '../', '~/', '/', '/etc/x', '\\',
            '.', '..', '...', '…', '#', '##', '-', '*', '+', '1.', '|', ':', '(', ')', '(x.md)', ']', '[', '`', '<', '>', '@', '!',
            '{name}', '{map}', '{path}', '$HOME', '%7E', 'http://h/x.md', 'file:///x.md', 'mailto:a', '~~~', '```', '---', '===',
            '<!--', '-->', '\n', '\r\n', '\r', '\n~~~ python', '\n# Map', '\t', '\u00a0', '\u2028', '\u202e', '\u200b', '\ufeff', 'é', '\U0001F600', 'C:\\x.md', 'x.md:41',
            'x.md#y', 'x.py::T', 'a/b/', 'skills/x/SKILL.md', '.claude/x.md', 'NN', 'XX', 'YYYY', '§3', 'json', '.json', 'x.txt',
        ]
        texts = set(fragments)
        for first, second in itertools.product(fragments, repeat=2):
            texts.add(first + second)
            texts.add(f'{first} {second}')
        alphabet = 'ab.x/~\\-_:#@()[]<>`|*!$%&+=?;,"\' \t\n\u2028\u00a0é…mdAGENTS'
        generator = random.Random(20261117)
        for _ in range(1500):
            texts.add(''.join(generator.choice(alphabet) for _ in range(generator.randint(1, 30))))
        accepted = 0
        for index, text in enumerate(sorted(texts)):
            payload = {'name': 'fuzz', 'language': LANGUAGES[index % 2],
                       'primitives': [{'name': 'a', 'type': 'agent', 'description': text}, {'name': 'm', 'type': 'memory', 'description': text}],
                       'relationships': [{'source': 'a', 'target': 'm', 'type': 'reads'}]}
            try:
                blueprint(payload)
            except ValueError as error:
                self.assertTrue(str(error).startswith('Description of a: '), (text, str(error)))
                continue
            accepted += 1
            root = self.create(payload)
            model = self.read(root)
            self.assertEqual(self.edges(model, root), drawn_edges(payload), text)
            self.assertEqual((model['issues'], model['signals']), ([], []), text)
            entry = self.written(root)['AGENTS.md']
            self.assertIn(f'- [a](agent/a.md): {text.strip() or GAP[payload["language"]]}\n', entry)
            # One line per file: a description never adds a line to the entry.
            self.assertEqual(len(entry.splitlines()), len(blueprint(with_language(payload, None, False))['AGENTS.md'].splitlines()), text)
        # Not vacuous: a good share of the hostile texts is accepted and goes through the reader.
        self.assertGreater(accepted, len(texts) // 4, (accepted, len(texts)))

    # Sabotage of a created directory (test 1 of section G of the study): what `aae audit` reports

    def sabotage_root(self):
        root, _ = self.check_clean(with_language(EXAMPLE, 'en'))
        self.assertEqual(self.findings(root), [])
        return root

    def assert_restored(self, root):
        self.assertEqual(self.findings(root), [])
        model = self.read(root)
        self.assertEqual((model['issues'], model['signals']), ([], []))

    def test_a_removed_pointer_is_reported_when_no_other_path_is_left(self):
        root = self.sabotage_root()
        entry, agent = root / 'AGENTS.md', root / 'agent/assistant.md'
        entry_text, agent_text = entry.read_text(encoding='utf-8'), agent.read_text(encoding='utf-8')
        pointer = next(line for line in entry_text.splitlines() if line.startswith('- [glossary]'))
        entry.write_text(entry_text.replace(pointer + '\n', ''), encoding='utf-8')
        # Limit: glossary is still reached through the link of assistant, at two hops; nothing is reported.
        self.assertEqual(self.findings(root), [])
        self.assertEqual(self.audit(root)['metrics']['reachability']['hops']['max'], 2)
        agent.write_text(agent_text.replace('- See [glossary](../document/glossary.md) when relevant.\n', ''), encoding='utf-8')
        self.assertEqual(self.findings(root), [('unreachable', 'document/glossary.md', None)])
        reach = self.audit(root)['metrics']['reachability']
        self.assertEqual((reach['reachable'], reach['documents']), (7, 8))
        entry.write_text(entry_text, encoding='utf-8')
        agent.write_text(agent_text, encoding='utf-8')
        self.assert_restored(root)

    def test_a_broken_link_is_reported(self):
        root = self.sabotage_root()
        agent = root / 'agent/assistant.md'
        text = agent.read_text(encoding='utf-8')
        agent.write_text(text.replace('../memory/context.md', '../memory/contexto.md'), encoding='utf-8')
        line = next(n for n, row in enumerate(text.splitlines(), 1) if '../memory/context.md' in row)
        self.assertEqual(self.findings(root), [('broken', 'agent/assistant.md', line)])
        agent.write_text(text, encoding='utf-8')
        self.assert_restored(root)

    def test_a_file_without_pointer_is_reported(self):
        root = self.sabotage_root()
        extra = root / 'document/extra.md'
        extra.write_text('# extra\n\nTODO.\n', encoding='utf-8')
        self.assertEqual(self.findings(root), [('unreachable', 'document/extra.md', None)])
        reach = self.audit(root)['metrics']['reachability']
        self.assertEqual((reach['reachable'], reach['documents']), (8, 9))
        extra.unlink()
        self.assert_restored(root)


if __name__ == '__main__':
    unittest.main()
