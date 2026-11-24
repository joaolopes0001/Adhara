"""The sentences of the server: written in English, sent with their phrase, worded by the Portuguese pack.

- No string of `server/` is Portuguese (but the listed exceptions, which are data, not sentences).
- Every phrase the server says (`texts.say`, `texts.plural`) has its Portuguese in the server block of
  src/i18n/pt-BR.ts (or, the same sentence, in the pack of the interface above it), with the same
  parameters, and the block has no entry the server no longer says.
- A sentence keeps its parameters whole, whatever they hold; a phrase the pack does not know shows in English.
- The API sends the phrase next to the sentence; the CLI and the audit report send the sentence alone.
"""
import ast
import io
import json
import re
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parents[1]
SERVER = REPO / 'server'
sys.path.insert(0, str(SERVER))
import audit  # noqa: E402
import editing  # noqa: E402
import expected  # noqa: E402
import scanner  # noqa: E402
import texts  # noqa: E402
from main import make_handler  # noqa: E402
from texts import is_text, number, plural, say, spelled, unwire, wire  # noqa: E402
from workspace import Workspace  # noqa: E402
from tests import server_pack  # noqa: E402
from tests.server_pack import english, portuguese  # noqa: E402

PLACEHOLDER = re.compile(r'\{([A-Za-z]\w*)\}')
BEFORE = REPO / 'tests' / 'server_phrases_before_english.json'
# Strings of server/ that are Portuguese on purpose, by (file, text): data the reader recognizes or writes into a
# snapshot, never a sentence for a person.
KEPT = {
    ('scanner.py', 'memória'),  # a folder name that makes its files memory, next to `memoria`
    # The content of the virtual canary document of a snapshot: its bytes are part of the snapshot hash.
    ('doc_snapshot.py', '# Canário de navegação\n\nDocumento artificial do experimento. Não contém instruções operacionais.\n'),
}
# creation_texts.py holds the starting text of a new architecture in both languages, on purpose.
BILINGUAL = {'creation_texts.py'}
ACCENTED = re.compile(r'[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]')
# Words that are Portuguese and not English; one of them in a string makes it Portuguese.
PORTUGUESE = frozenset('''não nao uma dos das pela pelo pelas pelos foi são está este esse essa isso isto até entre sobre quando onde cada outro outra
outros outras mesmo mesma apenas só já ainda também arquivo arquivos diretório diretorio diretórios pasta pastas leitura leituras caminho
caminhos projeto projetos raiz raízes limite aviso erro falha inválido invalido inválida válido ausente abra feche informe selecione releia
corrija deve devem pode podem nenhum nenhuma referência referencia referências destino origem entrada entradas texto textos lista padrão
padrões escopo relação relações observação observações nome nomes aberto aberta abertos salvo salva salvos gravar gravado gravada edição
lido lida lidos lidas novo nova antes depois durante sem com para que'''.split())


def literals(tree):
    """Every string constant of a module that is not a docstring, with its line."""
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                docstrings.add(id(first.value))
    return [(node.lineno, node.value) for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings]


def is_portuguese(value):
    return bool(ACCENTED.search(value)) or any(word in PORTUGUESE for word in re.findall(r'[a-zà-ÿ]+', value.lower()))


def modules():
    return {path.name: ast.parse(path.read_text(encoding='utf-8')) for path in sorted(SERVER.glob('*.py'))}


def constants(tree):
    """{name: every string in its value} of the module-level assignments."""
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            # Of a dictionary, its values: the keys are codes, not sentences.
            holders = node.value.values if isinstance(node.value, ast.Dict) else [node.value]
            found[node.targets[0].id] = [item.value for holder in holders for item in ast.walk(holder)
                                         if isinstance(item, ast.Constant) and isinstance(item.value, str)]
    return found


def said(tree):
    """(phrases, problems) of a module: every phrase a call of `say` or `plural` may take.

    A phrase is a literal, a choice of literals (`a if x else b`) or a value of a module constant
    (`say(UNCHECKED[reason])`); anything else is a problem, since nothing could be checked for it.
    """
    names, phrases, problems = constants(tree), [], []

    def of(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return [node.value]
        if isinstance(node, ast.IfExp):
            return of(node.body) + of(node.orelse)
        while isinstance(node, ast.Subscript):
            node = node.value
        if isinstance(node, ast.Name) and node.id in names:
            return names[node.id]
        return None
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {'say', 'plural'}):
            continue
        arguments = node.args[:1] if node.func.id == 'say' else node.args[1:3]
        given = {keyword.arg for keyword in node.keywords} | ({'count'} if node.func.id == 'plural' else set())
        for argument in arguments:
            found = of(argument)
            if found is None:
                problems.append(f'line {node.lineno}: a phrase that is neither a literal nor a module constant')
                continue
            phrases += found
            # With the parameters written at the call (no `**mapping`), each placeholder has one.
            if None not in given and isinstance(argument, ast.Constant):
                missing = set(PLACEHOLDER.findall(argument.value)) - given
                if missing:
                    problems.append(f'line {node.lineno}: no parameter for {sorted(missing)}')
    return phrases, problems


class NoPortugueseInTheServerTests(unittest.TestCase):
    def test_no_string_of_the_server_is_portuguese(self):
        found = []
        for name, tree in modules().items():
            if name in BILINGUAL:
                continue
            found += [(name, line, value[:100]) for line, value in literals(tree) if is_portuguese(value) and (name, value) not in KEPT]
        self.assertEqual(found, [])

    def test_the_exceptions_are_still_there_and_the_check_sees_portuguese(self):
        present = {(name, value) for name, tree in modules().items() for _, value in literals(tree)}
        self.assertEqual(KEPT - present, set())
        # Negative control: the sentences the server wrote before are seen as Portuguese, with or without accents.
        for sentence in ('Destino não encontrado: x.md', 'Arquivo fora do workspace.', 'objects e relationships devem ser listas.',
                         'O arquivo deve ter um caminho absoluto normalizado.', 'Nada foi gravado.', 'sem permissão'):
            self.assertTrue(is_portuguese(sentence), sentence)
        for sentence in ('Target not found: x.md', 'No permission to access the path given.', 'a # after a space (a comment only on a line of its own)'):
            self.assertFalse(is_portuguese(sentence), sentence)


class PackTests(unittest.TestCase):
    """The server block of the Portuguese pack against what the server says."""

    @classmethod
    def setUpClass(cls):
        cls.phrases, cls.problems = set(), []
        for name, tree in modules().items():
            phrases, problems = said(tree)
            cls.phrases |= set(phrases)
            cls.problems += [f'{name}, {problem}' for problem in problems]
        cls.block, cls.interface, cls.pack = server_pack.block(), server_pack.interface(), server_pack.pack()

    def test_every_phrase_is_a_literal_with_its_parameters(self):
        self.assertEqual(self.problems, [])
        self.assertGreater(len(self.phrases), 250)

    def test_every_phrase_of_the_server_has_its_portuguese(self):
        # A phrase without words (`{name}: {reason}`, `{file} ({path})`) joins others and needs no entry.
        worded = {phrase for phrase in self.phrases if re.search(r'[A-Za-z]', PLACEHOLDER.sub('', phrase))}
        self.assertEqual(sorted(worded - set(self.pack)), [])

    def test_the_block_has_no_entry_the_server_does_not_say(self):
        self.assertEqual(sorted(set(self.block) - self.phrases), [])

    def test_the_block_does_not_repeat_what_the_interface_pack_already_says(self):
        # A sentence both the server and the screen say (the refusals of editing) is written once, in the pack of
        # the interface: tests/ui/language.spec.ts finds each of its entries once in the built bundle.
        self.assertEqual(sorted(phrase for phrase, translation in self.block.items() if self.interface.get(phrase) == translation), [])
        # The ones the interface pack lends, and the one both have with other words (the block is looked up first).
        lent = sorted(phrase for phrase in self.phrases if phrase in self.interface and phrase not in self.block)
        self.assertEqual(len(lent), 24)
        self.assertIn('Could not save the file. Nothing was saved.', lent)
        self.assertEqual([phrase for phrase in self.block if phrase in self.interface], ['Symbolic link listed without following its target.'])
        self.assertEqual(portuguese(say('Symbolic link listed without following its target.')), 'Link simbólico listado sem seguir seu destino.')

    def test_each_translation_has_the_parameters_of_its_phrase_and_no_stray_brace(self):
        wrong = []
        for phrase, translation in self.block.items():
            if sorted(set(PLACEHOLDER.findall(phrase))) != sorted(set(PLACEHOLDER.findall(translation))):
                wrong.append((phrase, 'parameters'))
            if re.search(r'[{}]', PLACEHOLDER.sub('', translation)) and not re.search(r'[{}]', PLACEHOLDER.sub('', phrase)):
                wrong.append((phrase, 'brace'))
            if not translation.strip():
                wrong.append((phrase, 'empty'))
        self.assertEqual(wrong, [])

    def test_a_phrase_with_two_or_more_parameters_puts_each_where_the_earlier_server_did(self):
        # BEFORE: what the server wrote in Portuguese before it wrote English, for each of its phrases
        # with two or more parameters, with the distinct value «name» for each parameter `name`. A translation that
        # swaps two parameters or changes a word differs here, though it keeps the same set of parameters.
        recorded = json.loads(BEFORE.read_text(encoding='utf-8'))
        self.assertEqual(len(recorded), 46)
        multi = {phrase for phrase in self.block if len(set(PLACEHOLDER.findall(phrase))) >= 2}
        # Every one of them is still said; a phrase reworded in English keeps its Portuguese here, under the new words.
        self.assertEqual(sorted(set(recorded) - multi), [])
        self.assertEqual(sorted(multi - set(recorded)), [])  # a new one has no Portuguese of the earlier server
        for phrase, before in recorded.items():
            values = {name: f'«{name}»' for name in PLACEHOLDER.findall(phrase)}
            self.assertEqual(portuguese(say(phrase, **values)), before, phrase)
        # Negative control: the same phrase with two parameters swapped in its translation does not pass.
        phrase = 'Reference repeated in {count} evidence locations: {source} → {target}. It may be intentional; it does not prove runtime noise.'
        swapped = self.block[phrase].replace('{source}', '\0').replace('{target}', '{source}').replace('\0', '{target}')
        self.assertNotEqual(server_pack._fill(swapped, {name: f'«{name}»' for name in ('count', 'source', 'target')}), recorded[phrase])

    def test_no_phrase_names_a_parameter_the_interface_never_fills(self):
        # src/i18n/translate.ts reads `context` as the context of a phrase, never as a parameter: `{context}` would
        # stay written on the screen.
        self.assertEqual(sorted(phrase for phrase in self.phrases if 'context' in PLACEHOLDER.findall(phrase)), [])
        # Nor a tag: `<b>…</b>` in a phrase would lose its marks on the screen, though the sentence of the CLI keeps them.
        self.assertEqual(sorted(phrase for phrase in self.phrases if re.search(r'<([A-Za-z]\w*)>.*?</\1>', phrase)), [])

    def test_no_parameter_of_a_phrase_touches_a_word(self):
        # The audit writes the opened roots of a message relative (`_Frame.message`), parameter by parameter: the
        # result is the same as on the whole sentence only if no parameter is followed by a letter, a digit, `-` or `.x`.
        touching = [phrase for phrase in self.phrases if re.search(r'\{[A-Za-z]\w*\}(?:[\w\-]|\.\w)', phrase)]
        # The one phrase where it happens names a node, never a path: `{name}.md`.
        self.assertEqual(touching, ['Node name {name}: reserved, because the file {name}.md would be read as {kind}.'])

    def test_the_block_is_read_as_the_interface_reads_it(self):
        # The reader of this test understands the quotes and escapes prettier writes.
        self.assertEqual(server_pack._strings("  'a\\'b': \"c'd\", // comment 'x'\n  'e\\\\n': 'f\\u00e9',"), ["a'b", "c'd", 'e\\n', 'fé'])
        self.assertEqual(self.block['Target not found: {raw}'], 'Destino não encontrado: {raw}')
        self.assertEqual(self.pack['The file mixes line breaks or has a lone carriage return.'], 'O arquivo mistura quebras de linha ou tem \\r solto.')


class TextTests(unittest.TestCase):
    def test_a_text_is_the_english_sentence_and_keeps_its_phrase(self):
        text = say('Target not found: {raw}', raw='docs/x.md')
        self.assertEqual(text, 'Target not found: docs/x.md')
        self.assertIsInstance(text, str)
        self.assertEqual((text.phrase, text.params), ('Target not found: {raw}', {'raw': 'docs/x.md'}))
        self.assertEqual(json.dumps({'message': text}), '{"message": "Target not found: docs/x.md"}')
        self.assertIs(type(str(text)), str)
        self.assertTrue(is_text(text))
        self.assertFalse(is_text('Target not found: docs/x.md'))

    def test_parameters_are_written_whole_whatever_they_hold(self):
        strange = ['a{b}c', '{raw}', '100%', '%s %(x)s {0}', 'ação "aspas" \'simples\'', 'a\\b\nc', '<b>x</b>', '$HOME', '{', '}', '{{raw}}', '\udcff'.encode('utf-8', 'backslashreplace').decode()]
        for value in strange:
            with self.subTest(value=value):
                text = say('Target not found: {raw}', raw=value)
                self.assertEqual(text, f'Target not found: {value}')
                self.assertEqual(wire(text), {'phrase': 'Target not found: {raw}', 'params': {'raw': value}})
                self.assertEqual(english(wire(text)), text)
                self.assertEqual(portuguese(text), f'Destino não encontrado: {value}')
                # Read back from disk, the same text.
                self.assertEqual(unwire(json.loads(json.dumps(wire(text)))), text)

    def test_a_phrase_the_pack_does_not_know_shows_in_english(self):
        unknown = say('A sentence of a newer server about {path}.', path='/tmp/x{y}')
        self.assertNotIn(unknown.phrase, server_pack.pack())
        self.assertEqual(portuguese(unknown), 'A sentence of a newer server about /tmp/x{y}.')
        self.assertEqual(portuguese('A sentence without a phrase.'), 'A sentence without a phrase.')
        # A known sentence inside an unknown one is still worded, and the unknown one keeps its English.
        outer = say('Newer wrapper: {reason}', reason=say('disk full'))
        self.assertEqual((str(outer), portuguese(outer)), ('Newer wrapper: disk full', 'Newer wrapper: disco cheio'))
        # A placeholder without a parameter stays written, in both languages.
        self.assertEqual(say('Target not found: {raw}'), 'Target not found: {raw}')

    def test_a_text_inside_a_text_and_two_forms_by_number(self):
        reason = say('write failure ({cause})', cause=say('disk full'))
        text = say('Baseline not saved in the state directory of the app ({directory}): {reason}. It holds only until the server restarts.', directory='/s', reason=reason)
        self.assertEqual(text, 'Baseline not saved in the state directory of the app (/s): write failure (disk full). It holds only until the server restarts.')
        self.assertEqual(wire(text)['params']['reason'], {'phrase': 'write failure ({cause})', 'params': {'cause': {'phrase': 'disk full'}}})
        self.assertEqual(portuguese(text), 'Referência não salva no diretório de estado do aplicativo (/s): falha de gravação (disco cheio). Ela vale só até reiniciar o servidor.')
        one, many = expected.restore_messages({'invalid': 1, 'over': 0, 'normalized': 0}), expected.restore_messages({'invalid': 3, 'over': 0, 'normalized': 0})
        self.assertEqual((one, many), (['An invalid mark of an expected observation in the saved state was ignored.'], ['3 invalid marks of expected observations in the saved state were ignored.']))
        self.assertEqual([portuguese(one[0]), portuguese(many[0])], ['Uma marcação de observação esperada inválida no estado salvo foi ignorada.',
                                                                    '3 marcações de observação esperada inválidas no estado salvo foram ignoradas.'])
        self.assertEqual(plural(0, 'one {x}', '{count} {x}', x='y'), '0 y')

    def test_a_number_is_written_for_each_language_and_other_numbers_as_they_are(self):
        self.assertEqual((number(5000), wire(number(5000)), portuguese(number(5000))), ('5,000', {'number': 5000}, '5.000'))
        text = say('Limit of {limit} marks', limit=number(200000))
        self.assertEqual((str(text), wire(text)), ('Limit of 200,000 marks', {'phrase': 'Limit of {limit} marks', 'params': {'limit': {'number': 200000}}}))
        self.assertEqual(unwire(wire(text)), text)
        self.assertEqual(say('{files} and {lookup} items', files=20000, lookup=200000), '20000 and 200000 items')
        self.assertEqual(expected.LIMIT_TEXT, f'{expected.MAX_PER_ROOT:,}')

    def test_a_stored_phrase_is_untrusted(self):
        deep = {'phrase': '{a}'}
        for _ in range(8):
            deep = {'phrase': '{a}', 'params': {'a': deep}}
        for value in (None, 'text', [], {}, {'phrase': 5}, {'phrase': 'x', 'extra': 1}, {'phrase': 'x', 'params': []}, {'phrase': 'x', 'params': {'a': [1]}},
                      {'phrase': 'x', 'params': {'a': float('nan')}}, {'phrase': 'x' * 9000}, {'phrase': 'x', 'params': {str(index): 1 for index in range(40)}},
                      {'number': 5}, {'phrase': 'x', 'params': {'a': {'number': '5'}}}, deep):
            with self.subTest(value=str(value)[:60]):
                self.assertIsNone(unwire(value))
        self.assertEqual(texts.restored('disk full', {'phrase': 'disk full'}).phrase, 'disk full')
        # Without a phrase that reads as the sentence saved with it, the sentence is one an earlier server saved, in
        # Portuguese. It is never read: in English it is a phrase of its own, and the API sends the sentence with it.
        for value in ({'phrase': 'disk full'}, None):
            kept = texts.restored('disco cheio', value)
            self.assertEqual((kept, kept.phrase, kept.params, wire(kept)),
                             (texts.EARLIER, texts.EARLIER, {}, {'phrase': texts.EARLIER, 'earlier': 'disco cheio'}))
            self.assertEqual(portuguese(kept), 'disco cheio')
        # In Portuguese, as it came: a brace or a tag in it stays as saved.
        for saved in ('a {x} b', '<b>x</b> {y}'):
            self.assertEqual(portuguese(texts.restored(saved, None)), saved)
        # A sentence saved with it never goes back to disk as a phrase: read back, it is not one.
        self.assertIsNone(unwire(wire(texts.restored('disco cheio', None))))

    def test_an_answer_gets_the_phrase_next_to_each_sentence_made_with_parameters(self):
        answer = {'error': say('Not a folder: {path}', path='/x'), 'code': 'c', 'plain': say('Invalid path.'), 'other': 'text',
                  'list': [say('Folder unavailable: {path}', path='/y'), say('Invalid saved path ignored.'), 'old'],
                  'inner': {'message': say('Target not found: {raw}', raw='z'), 'nodes': [{'message': say('Not a folder: {path}', path='/skipped')}]}}
        self.assertEqual(spelled(answer, frozenset({'nodes'})), {
            'error': 'Not a folder: /x', 'errorPhrase': {'phrase': 'Not a folder: {path}', 'params': {'path': '/x'}}, 'code': 'c',
            'plain': 'Invalid path.', 'other': 'text',
            'list': ['Folder unavailable: /y', 'Invalid saved path ignored.', 'old'],
            'listPhrase': [{'phrase': 'Folder unavailable: {path}', 'params': {'path': '/y'}}, None, None],
            'inner': {'message': 'Target not found: z', 'messagePhrase': {'phrase': 'Target not found: {raw}', 'params': {'raw': 'z'}},
                      'nodes': [{'message': 'Not a folder: /skipped'}]}})


def write(root, files):
    for name, content in files.items():
        path = Path(root, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')


class ReaderFactsTests(unittest.TestCase):
    """What the interface reads from an observation without searching its sentence: fields of a signal, and the
    parameters of the phrase of an observation (the audit report keeps its fields)."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-server-texts-')
        self.addCleanup(temporary.cleanup)
        self.root = str(Path(temporary.name).resolve() / 'pacote')
        write(self.root, {'AGENTS.md': '# A\n[b](b.md) [b](b.md)\n[b](b.md)\n[amb](igual.md)\n' + ''.join(f'[d{index}](d/{index}.md)\n' for index in range(13)),
                          'b.md': '[a](AGENTS.md)\n', 'x/igual.md': 'x\n', 'y/igual.md': 'y\n', 'so.md': 's\n',
                          **{f'd/{index}.md': 'x\n' for index in range(13)}})

    def test_signals_carry_their_destination_and_files_as_fields(self):
        model = scanner.scan([self.root])
        signals = {item['code']: item for item in model['signals']}
        self.assertEqual(signals['repeated-reference']['to'], f'{self.root}/b.md')
        self.assertEqual((signals['cycle']['files'], signals['cycle']['count']), (['AGENTS.md', 'b.md'], 2))
        self.assertEqual({key for key in signals['high-fanout'] if key in ('to', 'files')}, set())
        # The key of a mark of the repeated reference is made from the field, relative to the project.
        _, annotated, facts = expected.annotate(model)
        repeated = next(item for item in annotated if item['code'] == 'repeated-reference')
        self.assertEqual(facts[self.root][repeated['key']], {'code': 'repeated-reference', 'path': 'AGENTS.md', 'target': 'b.md'})
        # Without the field (a model of another origin) the signal has no destination: never one guessed from the sentence.
        self.assertIsNone(expected._signal_target({**signals['repeated-reference'], 'to': None}, audit._Frame(model['roots']), 0))

    def test_the_inventory_limit_sends_its_numbers_and_unreachable_says_which_scan_is_partial(self):
        saved = scanner.MAX_FILES
        scanner.MAX_FILES = 8
        self.addCleanup(setattr, scanner, 'MAX_FILES', saved)
        model = scanner.scan([self.root])
        limit = next(item['message'] for item in model['issues'] if item['code'] == 'limit')
        self.assertEqual(set(limit.params), {'root', 'budget', 'partial', 'unread', 'omitted', 'minimum'})
        self.assertEqual((limit.params['budget'], limit.params['minimum'], type(limit.params['omitted'])), (8, False, int))
        unreachable = [item['message'] for item in model['issues'] if item['code'] == 'unreachable']
        self.assertTrue(unreachable)
        self.assertEqual({message.params['partial'] for message in unreachable}, {'root'})
        self.assertTrue(all(message.phrase.startswith('{finding} Not conclusive') and is_text(message.params['finding']) for message in unreachable))

    def test_the_audit_report_has_the_sentence_alone_and_the_same_one_with_the_roots_made_relative(self):
        other = str(Path(self.root).parent / 'vazio')
        write(other, {'nota.md': 'x\n'})
        model = scanner.scan([self.root, other])
        report = audit.audit(model)
        text = json.dumps(report)
        self.assertNotIn('messagePhrase', text)
        self.assertNotIn('"phrase"', text)
        no_entry = next(item for item in report['findings'] if item['code'] == 'no-entry')
        self.assertEqual(no_entry['message'], 'No AGENTS.md or CLAUDE.md in vazio.')
        # The sentence keeps its phrase through the audit, with the root already relative in the parameter.
        self.assertEqual(wire(no_entry['message']), {'phrase': 'No AGENTS.md or CLAUDE.md in {root}.', 'params': {'root': 'vazio'}})
        # Parameter by parameter gives the sentence the whole text would give.
        frame = audit._Frame(model['roots'])
        for issue in model['issues'] + model['signals']:
            self.assertEqual(frame.message(issue['message']), frame.message(str(issue['message'])), issue['code'])
        # The CLI prints the same English, with no language option.
        from server import cli
        output = io.StringIO()
        with redirect_stdout(output):
            cli.main(['audit', '--root', self.root])
        printed = json.loads(output.getvalue())
        self.assertNotIn('messagePhrase', output.getvalue())
        self.assertEqual([item['message'] for item in printed['findings'] if item['code'] == 'ambiguous'],
                         ['Ambiguous reference: igual.md (2 candidates in the inventory; none was chosen).'])


class ApiTests(unittest.TestCase):
    """Over HTTP: the phrase next to each sentence made with parameters, in observations, warnings and refusals."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-server-texts-api-')
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name).resolve()
        self.root = str(base / 'pacote')
        write(self.root, {'AGENTS.md': '# A\n[falta](docs/falta.md)\n[b](b.md) [b](b.md)\n[b](b.md)\n', 'b.md': '[a](AGENTS.md)\n',
                          'agent-architecture.json': json.dumps({'scope': {'version': 1, 'entries': ['/abs{x}%s "q"']}})})
        self.state = base / 'state'
        self.workspace = Workspace(self.state)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.workspace, base / 'static', 'token'))
        self.server.RequestHandlerClass.log_message = lambda *args: None
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def call(self, route, body=None):
        request = Request(f'http://127.0.0.1:{self.server.server_port}{route}', data=None if body is None else json.dumps(body).encode(),
                          headers={'X-AAE-Token': 'token', **({'Content-Type': 'application/json'} if body is not None else {})})
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.load(error)

    def test_observations_signals_and_refusals_come_with_their_phrase(self):
        status, model = self.call('/api/open', {'path': self.root})
        self.assertEqual(status, 200)
        broken = next(item for item in model['issues'] if item['code'] == 'broken')
        self.assertEqual((broken['message'], broken['messagePhrase']), ('Target not found: docs/falta.md', {'phrase': 'Target not found: {raw}', 'params': {'raw': 'docs/falta.md'}}))
        # A sentence inside a sentence, with a strange parameter: whole in both languages.
        manifest = next(item for item in model['issues'] if item['code'] == 'manifest')
        self.assertEqual(manifest['message'], 'Invalid scope declaration, ignored: entries: the pattern /abs{x}%s "q" must be relative to the root, without a leading /.')
        self.assertEqual(english(manifest['messagePhrase']), manifest['message'])
        self.assertEqual(portuguese(manifest['message'], manifest['messagePhrase']),
                         'Declaração de escopo inválida e ignorada: entries: o padrão /abs{x}%s "q" deve ser relativo à raiz, sem / inicial.')
        repeated = next(item for item in model['signals'] if item['code'] == 'repeated-reference')
        self.assertEqual((repeated['to'], repeated['messagePhrase']['params']), (f'{self.root}/b.md', {'count': 2, 'source': 'AGENTS.md', 'target': f'{self.root}/b.md'}))
        # No phrase where there is no sentence of the server: nodes and relations are not touched.
        self.assertFalse(any(key.endswith('Phrase') for item in model['nodes'] + model['edges'] for key in item))
        # A refusal with a parameter, and one without (the sentence is its own phrase).
        status, refused = self.call('/api/open', {'path': f'{self.root}/AGENTS.md'})
        self.assertEqual((status, refused), (400, {'error': f'Not a folder: {self.root}/AGENTS.md',
                                                   'errorPhrase': {'phrase': 'Not a folder: {path}', 'params': {'path': f'{self.root}/AGENTS.md'}}}))
        self.assertEqual(portuguese(refused['error'], refused['errorPhrase']), f'Não é um diretório: {self.root}/AGENTS.md')
        status, refused = self.call('/api/note', {'node': '/nowhere', 'body': 'x'})
        self.assertEqual((status, refused), (400, {'error': 'File outside the workspace.'}))
        self.assertEqual(portuguese(refused['error']), 'Arquivo fora do workspace.')
        status, refused = self.call('/api/edit/read', {'path': f'{self.root}/b.md'})
        self.assertEqual((status, refused), (403, {'error': str(editing.MESSAGES['edit-not-granted']), 'code': 'edit-not-granted'}))

    def test_restore_errors_and_changes_come_with_their_phrases(self):
        self.call('/api/open', {'path': self.root})
        Path(self.root, 'AGENTS.md').write_text('# A\n[b](b.md)\n[nova](docs/nova-falta.md)\n', encoding='utf-8')
        _, model = self.call('/api/refresh', {})
        new = model['delta']['findings']['new']
        self.assertEqual([(item['message'], item['messagePhrase']['params']) for item in new if item['code'] == 'broken'], [('Target not found: docs/nova-falta.md', {'raw': 'docs/nova-falta.md'})])
        # A saved state with a project that is gone: the restore error names it, with its phrase in a list alike.
        state = json.loads((self.state / 'workspace.json').read_text(encoding='utf-8'))
        state['roots'].append('/gone/{x}')
        state['expected'] = {'/gone': {'bad': 1}}
        (self.state / 'workspace.json').write_text(json.dumps(state), encoding='utf-8')
        snapshot = spelled(Workspace(self.state).snapshot(), frozenset({'nodes', 'edges', 'objects'}))
        self.assertEqual(snapshot['restoreErrors'], ['An invalid mark of an expected observation in the saved state was ignored.', 'Folder unavailable: /gone/{x}'])
        self.assertEqual(snapshot['restoreErrorsPhrase'], [{'phrase': 'An invalid mark of an expected observation in the saved state was ignored.', 'params': {'count': 1}},
                                                         {'phrase': 'Folder unavailable: {path}', 'params': {'path': '/gone/{x}'}}])
        self.assertEqual([portuguese(text, phrase) for text, phrase in zip(snapshot['restoreErrors'], snapshot['restoreErrorsPhrase'])],
                         ['Uma marcação de observação esperada inválida no estado salvo foi ignorada.', 'Diretório indisponível: /gone/{x}'])

    def test_a_refusal_kept_by_an_earlier_server_keeps_its_reason_as_it_was_saved(self):
        # `referenceRefusals` of a state written before the phrases: the reason is the Portuguese of then, without a phrase.
        # Nothing reads it. The English sentence says a phrase of its own in its place; the API sends the reason with
        # that phrase, and a Portuguese interface shows it as it came (tests/ui/server-text.spec.ts).
        self.call('/api/open', {'path': self.root})
        saved = next((self.state / 'references').iterdir())
        import hashlib
        state = json.loads((self.state / 'workspace.json').read_text(encoding='utf-8'))
        state['referenceRefusals'] = {self.root: {'reason': 'falha de gravação (disco cheio)', 'file': hashlib.sha256(saved.read_bytes()).hexdigest()}}
        (self.state / 'workspace.json').write_text(json.dumps(state), encoding='utf-8')
        warning = Workspace(self.state).snapshot()['delta']['warnings'][0]
        self.assertEqual(warning['code'], 'reference-update-not-saved')
        self.assertIn('): reason recorded by an earlier version of the app. The comparison uses the baseline saved before it', warning['message'])
        self.assertNotIn('falha', warning['message'])
        self.assertEqual(spelled(warning)['messagePhrase']['params']['reason'], {'phrase': texts.EARLIER, 'earlier': 'falha de gravação (disco cheio)'})
        self.assertIn('): falha de gravação (disco cheio). A comparação usa a referência salva antes dela', portuguese(warning['message']))


if __name__ == '__main__':
    unittest.main()
