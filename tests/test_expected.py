"""Observations marked as expected: stable key, storage, API and scope suggestion.

The mark is personal app state (workspace.json); the reader, the audit and the CLI do not change.
"""
import json
import os
import shutil
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
import audit
import expected
from main import make_handler
from scanner import scan
from scope import validate_scope
from workspace import Workspace
from tests.server_pack import portuguese

FILES = {
    'AGENTS.md': '# Loja\n[Guia](docs/guia.md)\n[Relatório](out/relatorio.md)\nGere `saida.md` no fim.\n[Falta](docs/falta.md)\n',
    'docs/guia.md': '# Guia\n[c](c.md)\n',
    'notas/c.md': '# c\n',
    'skills/s1/c.md': '# c\n',
    'skills/s1/SKILL.md': '# Skill\n',
    '.claude/agents/revisor.md': '# Revisor\n',
    'notas/solto.md': '# Solto\n',
}


def write(root, files):
    for name, text in files.items():
        path = Path(root, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')


def listing(root):
    return sorted((str(path.relative_to(root)), path.stat().st_size) for path in Path(root).rglob('*'))


class ExpectedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.state = self.folder / 'state'
        self.root = str(self.folder / 'loja')
        write(self.root, FILES)
        self.ws = Workspace(self.state)
        self.ws.open(self.root)

    def find(self, snapshot=None, code='broken', target='out/relatorio.md', kind='issues', node=None):
        snapshot = snapshot or self.ws.snapshot()
        items = [item for item in snapshot[kind] if item['code'] == code
                 and (target is None or item.get('target') == target)
                 and (node is None or item['node'] == str(Path(self.root, node)))]
        self.assertEqual(len(items), 1, items)
        return items[0]

    def keys(self, snapshot=None):
        snapshot = snapshot or self.ws.snapshot()
        return {item['key'] for item in snapshot['issues'] + snapshot['signals'] if 'key' in item}

    def stored(self):
        return json.loads(self.ws.state_file.read_text(encoding='utf-8')).get('expected', {})

    # Stable identity

    def test_key_mirrors_the_audit_id_of_a_standalone_audit_of_the_project(self):
        report = audit.audit(scan([self.root]))
        ids = {(item['code'], item.get('path'), item.get('target')): item['id'] for item in report['findings']}
        for item in self.ws.snapshot()['issues']:
            path = os.path.relpath(item['node'], self.root) if item['node'] != self.root else '.'
            self.assertEqual(item['key'], ids[(item['code'], path, item.get('target'))], item['code'])
        # The reader's id (with line and absolute path) stays the one of the reading.
        self.assertEqual([item['id'] for item in self.ws.snapshot()['issues']], [item['id'] for item in scan([self.root])['issues']])

    def test_key_survives_lines_inserted_above_a_reread_and_a_restart(self):
        before = self.find()
        self.ws.expect(self.root, before['key'], True, 'criado pelo agente')
        agents = Path(self.root, 'AGENTS.md')
        agents.write_text('# Loja\n\nUma linha nova.\nOutra.\n' + agents.read_text(encoding='utf-8').split('\n', 1)[1], encoding='utf-8')
        after = self.find(self.ws.refresh())
        self.assertNotEqual(after['line'], before['line'])
        self.assertNotEqual(after['id'], before['id'])
        self.assertEqual(after['key'], before['key'])
        self.assertIn(after['key'], self.ws.snapshot()['expected'][self.root])
        restarted = Workspace(self.state).snapshot()
        self.assertEqual(self.find(restarted)['key'], before['key'])
        self.assertEqual(restarted['expected'][self.root][before['key']]['reason'], 'criado pelo agente')

    def test_key_changes_with_the_written_destination_the_source_path_and_the_code(self):
        key = self.find()['key']
        agents = Path(self.root, 'AGENTS.md')
        text = agents.read_text(encoding='utf-8')
        agents.write_text(text.replace('out/relatorio.md', 'out/outro.md'), encoding='utf-8')
        self.assertNotIn(key, self.keys(self.ws.refresh()))
        agents.write_text(text, encoding='utf-8')
        self.assertIn(key, self.keys(self.ws.refresh()))
        # Moving the source file changes the key.
        Path(self.root, 'instrucoes').mkdir()
        os.replace(agents, Path(self.root, 'instrucoes/AGENTS.md'))
        moved = self.ws.refresh()
        self.assertNotIn(key, self.keys(moved))
        os.replace(Path(self.root, 'instrucoes/AGENTS.md'), agents)
        # Another code for the same written destination: a name without a file becomes ambiguous.
        name = self.find(self.ws.refresh(), 'unresolved-name', 'saida.md')['key']
        write(self.root, {'a/saida.md': '# a\n', 'b/saida.md': '# b\n'})
        ambiguous = self.find(self.ws.refresh(), 'ambiguous', 'saida.md')
        self.assertNotEqual(ambiguous['key'], name)
        self.assertNotIn(name, self.keys())

    def test_identical_references_are_marked_one_at_a_time_and_the_documented_inheritance(self):
        write(self.root, {'AGENTS.md': '# Loja\n[a](falta.md)\ntexto\n[b](falta.md)\n'})
        snapshot = self.ws.refresh()
        first, second = sorted((item for item in snapshot['issues'] if item.get('target') == 'falta.md'), key=lambda item: item['line'])
        self.assertNotEqual(first['key'], second['key'])
        self.ws.expect(self.root, first['key'], True, 'só a primeira')
        marks = self.ws.snapshot()['expected'][self.root]
        self.assertIn(first['key'], marks)
        self.assertNotIn(second['key'], marks)
        # Known limit: without the first, the second becomes ordinal 0 and inherits the mark.
        write(self.root, {'AGENTS.md': '# Loja\ntexto\n[b](falta.md)\n'})
        (left,) = [item for item in self.ws.refresh()['issues'] if item.get('target') == 'falta.md']
        self.assertEqual(left['key'], first['key'])
        # And the other side (documented): an identical one inserted ABOVE the marked one inherits the mark,
        # and the reviewed one is active again.
        write(self.root, {'AGENTS.md': '# Loja\n[nova](falta.md)\ntexto\n[b](falta.md)\n'})
        inserted, reviewed = sorted((item for item in self.ws.refresh()['issues'] if item.get('target') == 'falta.md'), key=lambda item: item['line'])
        self.assertEqual(inserted['key'], first['key'])
        self.assertNotIn(reviewed['key'], self.ws.snapshot()['expected'][self.root])

    def test_key_does_not_depend_on_where_the_project_is_or_on_the_order_of_projects(self):
        keys = self.keys()
        copy = self.folder / 'outra-pasta' / 'loja'
        shutil.copytree(self.root, copy)
        other = Workspace(self.folder / 'state-2')
        self.assertEqual(self.keys(other.open(str(copy))), keys)
        sibling = str(self.folder / 'vizinho')
        write(sibling, {'AGENTS.md': '# Vizinho\n[x](out/relatorio.md)\n'})
        both = self.ws.open(sibling)
        mine = {item['key'] for item in both['issues'] + both['signals'] if item['node'] and item['node'].startswith(self.root + '/')}
        self.assertEqual(mine, keys)
        reordered = self.ws.reorder([sibling, self.root])
        self.assertTrue(keys <= {item['key'] for item in reordered['issues'] + reordered['signals'] if 'key' in item})

    def test_signals_have_keys_and_a_repeated_reference_keeps_its_destination(self):
        write(self.root, {'AGENTS.md': FILES['AGENTS.md'] + '[Guia de novo](docs/guia.md)\n[Notas](notas/c.md)\n[Notas](notas/c.md)\n'})
        signals = [item for item in self.ws.refresh()['signals'] if item['code'] == 'repeated-reference']
        self.assertEqual(len(signals), 2)
        self.assertEqual(len({item['key'] for item in signals}), 2)
        facts = self.ws._annotated()[2][self.root]
        self.assertEqual(sorted(facts[item['key']]['target'] for item in signals), ['docs/guia.md', 'notas/c.md'])
        guide = next(item for item in signals if facts[item['key']]['target'] == 'docs/guia.md')
        self.ws.expect(self.root, guide['key'], True, '')
        # A new repetition above does not take the mark of the other.
        write(self.root, {'AGENTS.md': '# Loja\n[Skill](skills/s1/SKILL.md)\n[Skill](skills/s1/SKILL.md)\n' + Path(self.root, 'AGENTS.md').read_text(encoding='utf-8').split('\n', 1)[1]})
        self.ws.refresh()
        again = {fact['target']: key for key, fact in self.ws._annotated()[2][self.root].items() if fact['code'] == 'repeated-reference'}
        self.assertEqual(set(again), {'skills/s1/SKILL.md', 'docs/guia.md', 'notas/c.md'})
        self.assertEqual(again['docs/guia.md'], guide['key'])
        self.assertIn(guide['key'], self.ws.snapshot()['expected'][self.root])

    def test_repeated_reference_outside_the_project_keeps_its_key_when_a_neighbour_opens_or_closes(self):
        shared = str(self.folder / 'compartilhado')
        write(shared, {'x.md': '# fora\n'})
        write(self.root, {'AGENTS.md': FILES['AGENTS.md'] + '[x](../compartilhado/x.md)\n\n[de novo](../compartilhado/x.md)\n'})
        def signal(snapshot):
            (item,) = [item for item in snapshot['signals'] if item['code'] == 'repeated-reference' and item['node'] == str(Path(self.root, 'AGENTS.md'))]
            return item['key']
        key = signal(self.ws.refresh())
        mark = self.ws.expect(self.root, key, True, 'externo')['expected'][self.root][key]
        self.assertEqual(mark['target'], '../compartilhado/x.md')
        self.assertEqual(signal(self.ws.open(shared)), key)
        self.assertEqual(signal(self.ws.close(shared)), key)
        self.assertIn(key, self.ws.snapshot()['expected'][self.root])

    # Storage and API

    def test_mark_is_stored_in_the_app_state_never_in_the_root_and_remarking_updates_the_reason(self):
        before = listing(self.root)
        item = self.find()
        result = self.ws.expect(self.root, item['key'], True, '  criado na execução  ')
        mark = result['expected'][self.root][item['key']]
        self.assertEqual({k: mark[k] for k in ('code', 'path', 'target', 'reason')},
                         {'code': 'broken', 'path': 'AGENTS.md', 'target': 'out/relatorio.md', 'reason': 'criado na execução'})
        self.assertTrue(mark['at'])
        self.assertEqual(self.stored()[self.root][item['key']], mark)
        self.ws.expect(self.root, item['key'], True, 'outro motivo')
        self.assertEqual(self.stored()[self.root][item['key']]['reason'], 'outro motivo')
        self.assertEqual(len(self.stored()[self.root]), 1)
        # Unmarking what does not exist is harmless and writes nothing.
        saved = self.ws.state_file.read_text(encoding='utf-8')
        self.assertEqual(self.ws.expect(self.root, 'f' * 16, False), {'expected': {self.root: self.stored()[self.root]}})
        self.assertEqual(self.ws.state_file.read_text(encoding='utf-8'), saved)
        self.ws.expect(self.root, item['key'], False)
        self.assertEqual(self.stored(), {})
        self.assertEqual(listing(self.root), before)

    def test_invalid_requests_are_refused_with_a_sentence_in_both_languages_without_writing(self):
        item = self.find()
        outside = str(self.folder / 'fechado')
        write(outside, {'AGENTS.md': '# x\n'})
        saved = self.ws.state_file.read_text(encoding='utf-8')
        cases = {
            'raiz não aberta': ((outside, item['key'], True, ''), 'não está aberto'),
            'raiz relativa': (('loja', item['key'], True, ''), 'não está aberto'),
            'raiz ausente': ((None, item['key'], True, ''), 'não está aberto'),
            'chave curta': ((self.root, item['key'][:8], True, ''), 'mal formada'),
            'chave maiúscula': ((self.root, item['key'].upper(), True, ''), 'mal formada'),
            'chave não texto': ((self.root, 12, True, ''), 'mal formada'),
            'chave com linha': ((self.root, item['key'] + ':3', True, ''), 'mal formada'),
            'motivo não texto': ((self.root, item['key'], True, 5), 'motivo'),
            'motivo longo': ((self.root, item['key'], True, 'x' * 501), '500 caracteres'),
            'expected não booleano': ((self.root, item['key'], 'true', ''), 'booleana'),
            'observação inexistente': ((self.root, 'a' * 16, True, ''), 'não encontrada'),
            'motivo com NUL': ((self.root, item['key'], True, 'a\x00b'), 'caracteres de controle'),
            'motivo com ESC': ((self.root, item['key'], True, 'a\x1b[31mb'), 'caracteres de controle'),
            'motivo com inversão bidi': ((self.root, item['key'], True, 'abc\u202edef'), 'direção do texto'),
            'motivo com isolamento bidi': ((self.root, item['key'], True, '\u2066abc\u2069'), 'direção do texto'),
            'motivo com LRM': ((self.root, item['key'], True, 'abc\u200edef'), 'direção do texto'),
            'motivo com RLM': ((self.root, item['key'], True, 'abc\u200fdef'), 'direção do texto'),
            'motivo com ALM': ((self.root, item['key'], True, 'abc\u061cdef'), 'direção do texto'),
        }
        # Each case names the Portuguese a Portuguese interface shows (what the server wrote before); the server says it in English.
        english = {'não está aberto': 'is not open', 'mal formada': 'Malformed', 'motivo': 'reason', '500 caracteres': '500 characters', 'booleana': 'boolean',
                   'não encontrada': 'not found', 'caracteres de controle': 'control characters', 'direção do texto': 'text direction'}
        for name, (args, message) in cases.items():
            with self.subTest(name), self.assertRaises(ValueError) as error:
                self.ws.expect(*args)
            self.assertIn(english[message], str(error.exception))
            self.assertIn(message, portuguese(error.exception.args[0]))
        self.assertEqual(self.ws.state_file.read_text(encoding='utf-8'), saved)
        self.ws.expect(self.root, item['key'], True, 'x' * 500)
        self.assertEqual(len(self.stored()[self.root][item['key']]['reason']), 500)
        # Measured after trimming, in code points (as the interface counts): spaces at the edges do not count.
        self.ws.expect(self.root, item['key'], True, '  ' + 'y' * 500 + '  ')
        self.assertEqual(self.stored()[self.root][item['key']]['reason'], 'y' * 500)
        self.ws.expect(self.root, item['key'], True, '😀' * 500)
        self.assertEqual(self.stored()[self.root][item['key']]['reason'], '😀' * 500)
        # A line break is accepted; null in an optional field counts as absent (marked, without a reason).
        self.ws.expect(self.root, item['key'], True, 'linha 1\nlinha 2')
        self.assertEqual(self.stored()[self.root][item['key']]['reason'], 'linha 1\nlinha 2')
        # CR LF and a lone CR are line breaks; a pasted TAB becomes a space.
        self.ws.expect(self.root, item['key'], True, 'a\r\nb\rc\td')
        self.assertEqual(self.stored()[self.root][item['key']]['reason'], 'a\nb\nc d')
        self.ws.expect(self.root, item['key'], None, None)
        self.assertEqual(self.stored()[self.root][item['key']]['reason'], '')

    def test_limit_of_marks_per_project(self):
        keys = sorted(self.keys())
        relatorio = self.find()['key']
        others = [key for key in keys if key != relatorio]
        with patch.object(expected, 'MAX_PER_ROOT', 2):
            self.ws.expect(self.root, relatorio, True)
            self.ws.expect(self.root, others[0], True)
            # The marked one becomes an orphan: the written destination changes.
            agents = Path(self.root, 'AGENTS.md')
            agents.write_text(agents.read_text(encoding='utf-8').replace('out/relatorio.md', 'out/outro.md'), encoding='utf-8')
            self.ws.refresh()
            with self.assertRaises(ValueError) as error:
                self.ws.expect(self.root, others[1], True)
            self.assertIn('Limit of', str(error.exception))
            self.assertIn('without a matching observation count too (1 now)', str(error.exception))
            self.assertIn('sem observação correspondente também contam (1 agora)', portuguese(error.exception.args[0]))
            # Updating the reason of an existing mark is still allowed.
            self.ws.expect(self.root, others[0], True, 'novo')
        self.assertEqual(expected.MAX_PER_ROOT, 5000)
        self.assertIn('5,000', expected.limit_message(0))
        self.assertIn('Limite de 5.000 marcações', portuguese(expected.limit_message(0)))  # the number, written for the language
        self.assertEqual(set(self.stored()[self.root]), {relatorio, others[0]})

    def test_close_keeps_and_forget_erases_only_that_project(self):
        other = str(self.folder / 'outro')
        write(other, {'AGENTS.md': '# Outro\n[x](sumido.md)\n'})
        self.ws.open(other)
        mine, theirs = self.find()['key'], self.find(code='broken', target='sumido.md')['key']
        self.ws.expect(self.root, mine, True, 'meu')
        self.ws.expect(other, theirs, True, 'deles')
        closed = self.ws.close(self.root)
        self.assertNotIn(self.root, closed['expected'])
        self.assertIn(self.root, self.stored())
        reopened = self.ws.open(self.root)
        self.assertEqual(reopened['expected'][self.root][mine]['reason'], 'meu')
        self.ws.close(self.root)
        self.ws.forget(self.root)
        self.assertNotIn(self.root, self.stored())
        self.assertEqual(self.stored()[other][theirs]['reason'], 'deles')
        self.assertNotIn(self.root, self.ws.open(self.root)['expected'])

    def test_corrupt_marks_are_ignored_on_load_keeping_the_valid_ones(self):
        key = self.find()['key']
        self.ws.expect(self.root, key, True, 'válida')
        state = json.loads(self.ws.state_file.read_text(encoding='utf-8'))
        good = state['expected'][self.root][key]
        state['expected'][self.root].update({
            'curta': good, 'A' * 16: good, '0' * 16: 'texto', '1' * 16: {**good, 'reason': 9},
            '2' * 16: {**good, 'reason': 'x' * 501}, '3' * 16: {k: v for k, v in good.items() if k != 'code'},
            '4' * 16: {**good, 'path': ['lista']}, '5' * 16: {**good, 'extra': 'campo desconhecido'},
            '6' * 16: {**good, 'reason': 'oculto\u202e'}, '7' * 16: {**good, 'reason': 'nul\x00'},
            '8' * 16: {**good, 'reason': 'oculto\u200f'}, '9' * 16: {**good, 'reason': 'com\ttab\r\nfim'},
        })
        state['expected']['relativo'] = {key: good}
        state['expected']['/abs/sem-dict'] = ['x']
        self.ws.state_file.write_text(json.dumps(state), encoding='utf-8')
        restored = Workspace(self.state)
        snapshot = restored.snapshot()
        self.assertEqual(set(snapshot['expected'][self.root]), {key, '5' * 16, '9' * 16})
        # On load, the same rule as the route: TAB and CR LF edited by hand become a space and a line break.
        self.assertEqual(snapshot['expected'][self.root]['9' * 16]['reason'], 'com tab\nfim')
        self.assertNotIn('extra', snapshot['expected'][self.root]['5' * 16])
        self.assertTrue(any('invalid marks of expected observations' in error for error in snapshot['restoreErrors']))
        self.assertTrue(any('marcações de observação esperada inválidas' in portuguese(error) for error in snapshot['restoreErrors']))
        self.assertFalse(any('ceiling' in error for error in snapshot['restoreErrors']))
        self.assertEqual(snapshot['roots'][0]['path'], self.root)
        for broken in ([], 'texto', 7, None):
            state['expected'] = broken
            self.ws.state_file.write_text(json.dumps(state), encoding='utf-8')
            with self.subTest(expected=broken):
                self.assertEqual(Workspace(self.state).snapshot()['expected'], {})
        # The next save writes only the valid marks.
        state['expected'] = {self.root: {key: good, 'curta': good}}
        self.ws.state_file.write_text(json.dumps(state), encoding='utf-8')
        again = Workspace(self.state)
        again.note(str(Path(self.root, 'AGENTS.md')), 'nota')
        self.assertEqual(set(json.loads(again.state_file.read_text(encoding='utf-8'))['expected'][self.root]), {key})

    def test_marks_above_the_ceiling_keep_the_most_recent_and_say_so(self):
        key = self.find()['key']
        state = json.loads(self.ws.state_file.read_text(encoding='utf-8'))
        old = {f'{index:016x}': {'code': 'broken', 'path': 'x.md', 'target': f'{index}.md', 'reason': '', 'at': '2026-01-01T00:00:00-03:00'}
               for index in range(3)}
        state['expected'] = {self.root: {**old, key: {'code': 'broken', 'path': 'AGENTS.md', 'target': 'out/relatorio.md',
                                                       'reason': 'a mais recente', 'at': '2026-11-07T10:00:00-03:00'}}}
        self.ws.state_file.write_text(json.dumps(state), encoding='utf-8')
        with patch.object(expected, 'MAX_PER_ROOT', 2):
            snapshot = Workspace(self.state).snapshot()
        kept = snapshot['expected'][self.root]
        self.assertEqual(len(kept), 2)
        self.assertEqual(kept[key]['reason'], 'a mais recente')
        self.assertIn('0000000000000000', kept)  # A tie in time: the key decides, deterministically.
        self.assertTrue(any('above the ceiling' in error and 'most recent' in error for error in snapshot['restoreErrors']))
        self.assertTrue(any('acima do teto de 5.000' in portuguese(error) and 'mais recentes' in portuguese(error) for error in snapshot['restoreErrors']))
        self.assertFalse(any('invalid' in error for error in snapshot['restoreErrors']))

    def test_root_written_in_a_non_canonical_form_is_normalized_once(self):
        key = self.find()['key']
        self.ws.expect(self.root, key, True, 'com barra')
        state = json.loads(self.ws.state_file.read_text(encoding='utf-8'))
        state['expected'] = {self.root + '/': state['expected'][self.root]}
        self.ws.state_file.write_text(json.dumps(state), encoding='utf-8')
        restored = Workspace(self.state)
        snapshot = restored.snapshot()
        self.assertEqual(snapshot['expected'][self.root][key]['reason'], 'com barra')
        self.assertTrue(any('was normalized' in error for error in snapshot['restoreErrors']))
        self.assertTrue(any('foi normalizado' in portuguese(error) for error in snapshot['restoreErrors']))
        restored.note(str(Path(self.root, 'AGENTS.md')), 'grava o estado')
        self.assertEqual(list(json.loads(restored.state_file.read_text(encoding='utf-8'))['expected']), [self.root])
        self.assertFalse(Workspace(self.state).restore_errors)
        restored.close(self.root)
        restored.forget(self.root)
        self.assertEqual(json.loads(restored.state_file.read_text(encoding='utf-8'))['expected'], {})

    def test_http_route_has_the_same_guard_and_errors(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.ws, self.folder, 'tok'))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def post(body, token='tok', headers=None):
            req = Request(f'http://127.0.0.1:{server.server_port}/api/expected', data=json.dumps(body).encode(),
                          headers={'Content-Type': 'application/json', 'X-AAE-Token': token, **(headers or {})})
            with urlopen(req, timeout=5) as response:
                return json.load(response)
        key = self.find()['key']
        self.assertEqual(post({'root': self.root, 'key': key, 'reason': 'ok'})['expected'][self.root][key]['reason'], 'ok')
        for body, token, headers, status, message in [
                ({'root': self.root, 'key': key}, 'ruim', None, 403, 'Invalid session'),
                ({'root': self.root, 'key': key}, 'tok', {'Origin': 'http://evil.example'}, 403, 'origin'),
                ({'root': self.root, 'key': key}, 'tok', {'Host': 'evil.example'}, 403, 'origin'),
                ({'root': '/nao/aberta', 'key': key}, 'tok', None, 400, 'is not open'),
                ({'root': self.root, 'key': 'zz'}, 'tok', None, 400, 'Malformed'),
                ({'root': self.root, 'key': key, 'reason': 'x' * 501}, 'tok', None, 400, '500'),
                ({}, 'tok', None, 400, 'is not open')]:
            with self.subTest(body=body, token=token, headers=headers), self.assertRaises(HTTPError) as error:
                post(body, token, headers)
            self.assertEqual(error.exception.code, status)
            self.assertIn(message, json.load(error.exception)['error'])
            error.exception.close()
        self.assertEqual(post({'root': self.root, 'key': key, 'expected': False}), {'expected': {}})
        # Errors of the request body, common to every route.
        for data, message in [(b'{"root": ', 'is not valid JSON'), ('{"reason": "ação"}'.encode('latin-1'), 'is not UTF-8')]:
            req = Request(f'http://127.0.0.1:{server.server_port}/api/expected', data=data,
                          headers={'Content-Type': 'application/json', 'X-AAE-Token': 'tok'})
            with self.subTest(data=data), self.assertRaises(HTTPError) as error:
                urlopen(req, timeout=5)
            self.assertEqual(error.exception.code, 400)
            self.assertIn(message, json.load(error.exception)['error'])
            error.exception.close()

    # Nothing changes in the reader or the CLI

    def test_cli_audit_and_the_reading_are_the_same_with_and_without_marks(self):
        def cli():
            result = subprocess.run([sys.executable, '-B', '-m', 'server.cli', 'audit', '--root', self.root],
                                    cwd=REPO, capture_output=True, text=True, timeout=60)
            self.assertIn(result.returncode, (0, 1), result.stderr)
            return result.stdout
        before = cli()
        model = json.dumps(self.ws.model, sort_keys=True)
        delta = json.dumps(self.ws.delta, sort_keys=True)
        marked = sorted(self.keys())
        for key in marked:
            self.ws.expect(self.root, key, True, 'todas')
        self.assertEqual(len(self.stored()[self.root]), len(marked))
        after = cli()
        self.assertEqual(after, before)
        self.assertEqual(json.dumps(self.ws.model, sort_keys=True), model)
        self.assertEqual(json.dumps(self.ws.refresh()['delta']['findings']['totals']), json.dumps(json.loads(delta)['findings']['totals']))
        # The CLI still reports the marked observation, with the same id that serves as the key.
        ids = {item['id'] for item in json.loads(after)['findings']}
        self.assertIn(self.find()['key'], ids)

    def test_snapshot_never_mutates_the_model(self):
        self.ws.snapshot()
        self.assertFalse(any('key' in item or 'suggestion' in item for item in self.ws.model['issues'] + self.ws.model['signals']))

    # Scope declaration suggestion

    def places(self, snapshot, code, target=None, node=None):
        return self.find(snapshot, code, target, node=node).get('suggestion', {}).get('places', [])

    def apply(self, root, kind, pattern):
        Path(root, 'agent-architecture.json').write_text(json.dumps({'scope': {'version': 1, kind: [pattern]}}), encoding='utf-8')

    def test_suggested_scope_absorbs_each_observation_with_each_kind_and_ambiguous_gets_none(self):
        write(self.root, {'AGENTS.md': FILES['AGENTS.md'] + 'Veja [rascunhos](rascunhos/).\n'})
        snapshot = self.ws.refresh()
        hints = {}
        for item in snapshot['issues']:
            places = item.get('suggestion', {}).get('places')
            if item['code'] in {'broken', 'unresolved-name', 'unreachable'}:
                self.assertEqual([place['root'] for place in places], [self.root], item)
                hints[item['key']] = places[0]
            else:
                self.assertNotIn('suggestion', item, item)
        by_node = {(item['code'], item.get('target') or os.path.relpath(item['node'], self.root)): hints[item['key']]
                   for item in snapshot['issues'] if item['key'] in hints}
        self.assertEqual({name: (hint['basis'], hint['pattern'], hint['kinds']) for name, hint in by_node.items()}, {
            ('broken', 'out/relatorio.md'): ('folder', 'out/', ['runtimeWorkspace', 'localFiles']),
            ('unresolved-name', 'saida.md'): ('root-file', 'saida.md', ['runtimeWorkspace', 'localFiles']),
            ('broken', 'docs/falta.md'): ('existing-folder', 'docs/falta.md', ['runtimeWorkspace', 'localFiles']),
            ('broken', 'rascunhos/'): ('directory', 'rascunhos/', ['runtimeWorkspace', 'localFiles']),
            ('unreachable', '.claude/agents/revisor.md'): ('agents', '.claude/agents/*.md', ['entries']),
            ('unreachable', 'skills/s1/SKILL.md'): ('skills', 'skills/*/SKILL.md', ['implicitLoads']),
            # Any other file: v1 cannot say "not for the agent"; marking it as expected is the way.
            ('unreachable', 'notas/c.md'): ('generic', None, []),
            ('unreachable', 'notas/solto.md'): ('generic', None, []),
            ('unreachable', 'skills/s1/c.md'): ('generic', None, []),
        })
        self.assertEqual({hint['manifest']['state'] for hint in hints.values()}, {'absent'})
        ambiguous = self.find(snapshot, 'ambiguous', 'c.md')
        self.assertNotIn('suggestion', ambiguous)
        # Each suggestion, alone and with each reading offered, makes its observation go away; the ambiguous one stays.
        for key, hint in hints.items():
            for kind in hint['kinds']:
                self.assertEqual(validate_scope({'version': 1, kind: [hint['pattern']]})[kind], [hint['pattern']])
                self.apply(self.root, kind, hint['pattern'])
                with self.subTest(pattern=hint['pattern'], kind=kind):
                    after = self.ws.refresh()
                    self.assertNotIn(key, self.keys(after))
                    self.assertFalse(any(item['code'] == 'manifest' for item in after['issues']))
                    self.assertIn(ambiguous['key'], self.keys(after))
        # All together: only the ambiguous one and the generic files stay, and the destinations become "declared".
        merged = {'version': 1}
        for hint in hints.values():
            if hint['pattern']:
                patterns = merged.setdefault(hint['kinds'][-1], [])
                if hint['pattern'] not in patterns:
                    patterns.append(hint['pattern'])
        Path(self.root, 'agent-architecture.json').write_text(json.dumps({'scope': merged}), encoding='utf-8')
        final = self.ws.refresh()
        self.assertEqual(sorted((item['code'], item.get('target') or os.path.relpath(item['node'], self.root)) for item in final['issues']),
                         [('ambiguous', 'c.md'), ('unreachable', 'notas/c.md'), ('unreachable', 'notas/solto.md'), ('unreachable', 'skills/s1/c.md')])
        statuses = {node['relative']: node['status'] for node in final['nodes'] if node['kind'] == 'unresolved'}
        self.assertEqual(statuses['out/relatorio.md'], 'declared')
        self.assertEqual(statuses['saida.md'], 'declared')

    def test_only_agents_under_claude_agents_and_skills_under_skills_get_a_starting_point(self):
        write(self.root, {'README.md': '# Para humanos\n', 'docs/agents/guia.md': '# Doc\n', 'sub/.claude/agents/rev.md': '# Rev\n',
                          'mod/SKILL.md': '# Mod\n', 'x/.agents/skills/s2/SKILL.md': '# S2\n'})
        snapshot = self.ws.refresh()
        def hint(path):
            (place,) = self.places(snapshot, 'unreachable', node=path)
            return place['basis'], place['pattern'], place['kinds']
        self.assertEqual(hint('README.md'), ('generic', None, []))
        self.assertEqual(hint('docs/agents/guia.md'), ('generic', None, []))
        self.assertEqual(hint('mod/SKILL.md'), ('generic', None, []))
        self.assertEqual(hint('sub/.claude/agents/rev.md'), ('agents', 'sub/.claude/agents/*.md', ['entries']))
        self.assertEqual(hint('x/.agents/skills/s2/SKILL.md'), ('skills', 'x/.agents/skills/*/SKILL.md', ['implicitLoads']))

    def test_wildcard_in_a_literal_part_gets_no_pattern(self):
        write(self.root, {'gen*/guia.md': '# G\n[r](out/relatorio.md)\n', 'genX/guia.md': '# X\n[r](out/relatroio.md)\n',
                          'AGENTS.md': FILES['AGENTS.md'] + '[g](gen*/guia.md)\n[x](genX/guia.md)\n',
                          'a?/.claude/agents/rev.md': '# Rev\n'})
        snapshot = self.ws.refresh()
        (star,) = self.places(snapshot, 'broken', 'out/relatorio.md', node='gen*/guia.md')
        self.assertEqual((star['basis'], star['pattern'], star['kinds']), ('wildcard', None, []))
        (plain,) = self.places(snapshot, 'broken', 'out/relatroio.md', node='genX/guia.md')
        self.assertEqual((plain['basis'], plain['pattern']), ('folder', 'genX/out/'))
        (agent,) = self.places(snapshot, 'unreachable', node='a?/.claude/agents/rev.md')
        self.assertEqual((agent['basis'], agent['pattern']), ('wildcard', None))

    def test_manifest_state_tells_where_the_pattern_goes(self):
        cases = {
            'sem-arquivo': (None, 'absent', []),
            'sem-scope': ({'version': 1}, 'no-scope', []),
            'scope-vazio': ({'version': 1, 'scope': {'version': 1}}, 'empty-scope', []),
            'scope-invalido': ({'version': 1, 'scope': {'version': 2, 'runtimeWorkspace': ['x/']}}, 'invalid-scope', []),
            'scope-local': ({'scope': {'version': 1, 'localFiles': ['config/*.local.json']}}, 'scope', ['localFiles']),
            'json-quebrado': ('{"version": 1, "scope": ', 'broken', []),
        }
        for name, (manifest, state, lists) in cases.items():
            root = str(self.folder / name)
            write(root, {'AGENTS.md': f'# {name}\n[n](gerado/novo.md)\n'})
            if manifest is not None:
                write(root, {'agent-architecture.json': manifest if isinstance(manifest, str) else json.dumps(manifest)})
            snapshot = self.ws.open(root)
            with self.subTest(name):
                (place,) = [item for item in snapshot['issues'] if item['code'] == 'broken' and item['node'].startswith(root + '/')][0]['suggestion']['places']
                self.assertEqual(place['manifest'], {'state': state, 'lists': lists})
            self.ws.close(root)

    def test_nested_projects_offer_the_owner_and_the_enclosing_root(self):
        child = str(Path(self.root, 'filha'))
        write(child, {'AGENTS.md': '# Filha\n[n](gerado/novo.md)\n[p](../out/pai.md)\n'})
        snapshot = self.ws.open(child)
        own, outer = self.places(snapshot, 'broken', 'gerado/novo.md')
        self.assertEqual((own['root'], own['pattern']), (child, 'gerado/'))
        self.assertEqual((outer['root'], outer['pattern']), (self.root, 'filha/gerado/'))
        # A destination outside the child, inside the opened parent: only the parent can absorb it.
        (only,) = self.places(snapshot, 'broken', '../out/pai.md')
        self.assertEqual((only['root'], only['pattern']), (self.root, 'out/'))
        key = self.find(snapshot, 'broken', 'gerado/novo.md')['key']
        # The child's declaration holds with both open; the parent's also holds with the parent open alone.
        self.apply(child, 'runtimeWorkspace', 'gerado/')
        self.assertNotIn(key, self.keys(self.ws.refresh()))
        Path(child, 'agent-architecture.json').unlink()
        self.apply(self.root, 'runtimeWorkspace', 'filha/gerado/')
        self.assertNotIn(key, self.keys(self.ws.refresh()))
        alone = self.ws.close(child)
        self.assertFalse([item for item in alone['issues'] if item.get('target') == 'gerado/novo.md'])

    def test_enclosing_root_blocked_by_a_wildcard_in_the_nested_name_is_listed_without_pattern(self):
        child = str(Path(self.root, 'fil*ha'))
        write(child, {'AGENTS.md': '# Filha\n[n](gerado/novo.md)\n'})
        snapshot = self.ws.open(child)
        own, outer = self.places(snapshot, 'broken', 'gerado/novo.md')
        self.assertEqual((own['root'], own['basis'], own['pattern']), (child, 'folder', 'gerado/'))
        # In the parent the path goes through fil*ha: the place is listed, without a pattern, for the interface to explain.
        self.assertEqual((outer['root'], outer['basis'], outer['pattern'], outer['kinds']), (self.root, 'wildcard', None, []))

    def test_no_suggestion_for_an_invalid_pattern(self):
        write(self.root, {'AGENTS.md': '# Loja\n[Barra](a\\b.md)\n'})
        (broken,) = [item for item in self.ws.refresh()['issues'] if item['code'] == 'broken']
        # scope.py does not accept a backslash: no suggestion, instead of an invalid pattern.
        self.assertNotIn('suggestion', broken)

if __name__ == '__main__':
    unittest.main()
