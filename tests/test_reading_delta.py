"""Delta against a fixed reference reading: files, relations with lines and compare-audit findings."""
from contextlib import ExitStack
import hashlib
import http.client
import itertools
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

REPOSITORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY / 'server'))
import delta as readings
from main import make_handler
from scanner import scan
from workspace import Workspace
from tests.server_pack import portuguese

AGENTS = '# Agente sintético\n[Contrato](core/contrato.md)\n[Procedimento](conditional/incidente.md)\n[Contrato repetido](core/contrato.md)\n[Obsoleto](obsoleto/ausente.md)\n'
EMPTY = {'added': 0, 'removed': 0}


def clock():
    """Distinct, increasing reading times (the real clock has one-second resolution)."""
    counter = itertools.count()
    return lambda: f'2026-10-02T14:{next(counter):02d}:00-03:00'


class ReadingDeltaTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-reading-delta-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'atlas'
        for name, text in {'AGENTS.md': AGENTS, 'core/contrato.md': '# Contrato\nREQUISITO_A\n',
                           'conditional/incidente.md': '# Incidente\n', 'honeypot/irrelevante.md': '# Honeypot\n',
                           'noise/rascunho.md': '# Rascunho\n'}.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
        (self.root / 'diagram.png').write_bytes(b'\x89PNG\r\n' + b'\x00' * 10)
        clock_patch = patch.object(readings, 'now', clock())
        clock_patch.start()
        self.addCleanup(clock_patch.stop)
        self.ws = Workspace(self.base / 'state')

    def path(self, name):
        return str(self.root / name)

    def edit(self, name, old, new):
        target = self.root / name
        text = target.read_text(encoding='utf-8')
        self.assertIn(old, text)
        target.write_text(text.replace(old, new, 1), encoding='utf-8')

    def assertEmpty(self, delta):
        self.assertEqual(delta['files']['totals'], {'added': 0, 'removed': 0, 'changed': 0})
        self.assertEqual(delta['relations']['totals'], EMPTY)
        self.assertEqual(delta['findings']['totals'], {'new': 0, 'resolved': 0})

    def test_first_reading_is_the_reference_and_an_unchanged_reread_is_empty(self):
        self.assertIsNone(self.ws.snapshot()['delta'])
        delta = self.ws.open(str(self.root))['delta']
        self.assertEqual(delta['reference']['at'], delta['current']['at'])
        self.assertEqual(delta['roots'], [{'path': str(self.root), 'name': 'atlas', 'referenceAt': delta['current']['at'],
                                           'referenceOrigin': 'first-reading', 'referenceSaved': True, 'context': 'same'}])
        self.assertEqual(delta['warnings'], [])
        self.assertEmpty(delta)
        reread = self.ws.refresh()['delta']
        self.assertEqual(reread['reference']['at'], delta['reference']['at'])
        self.assertGreater(reread['current']['at'], reread['reference']['at'])
        self.assertEmpty(reread)
        self.assertGreater(reread['findings']['persisting'], 0)
        self.assertEqual(reread['limit'], 500)

    def test_files_added_removed_and_changed_by_hash_or_size(self):
        self.ws.open(str(self.root))
        (self.root / 'noise' / 'rascunho.md').unlink()
        (self.root / 'novo.md').write_text('# Novo\n', encoding='utf-8')
        self.edit('core/contrato.md', 'REQUISITO_A', 'REQUISITO_B')  # same size: only the hash tells it changed
        (self.root / 'diagram.png').write_bytes(b'\x89PNG\r\n' + b'\x00' * 20)  # not analysed: compared by size
        files = self.ws.refresh()['delta']['files']
        self.assertEqual([(item['relative'], item['path'], item['root']) for item in files['added']], [('novo.md', self.path('novo.md'), str(self.root))])
        self.assertEqual([item['relative'] for item in files['removed']], ['noise/rascunho.md'])
        changed = {item['relative']: item for item in files['changed']}
        self.assertEqual(set(changed), {'core/contrato.md', 'diagram.png'})
        self.assertEqual(changed['core/contrato.md']['basis'], 'sha256')
        self.assertEqual(changed['core/contrato.md']['before'], changed['core/contrato.md']['after'])
        self.assertEqual((changed['diagram.png']['basis'], changed['diagram.png']['before'], changed['diagram.png']['after']), ('size', 16, 26))
        self.assertEqual(files['totals'], {'added': 1, 'removed': 1, 'changed': 2})

    def test_swapped_link_is_one_relation_added_and_one_removed_with_file_and_line(self):
        self.ws.open(str(self.root))
        self.edit('AGENTS.md', '[Contrato repetido](core/contrato.md)', '[Nova dependência](honeypot/irrelevante.md)')
        snapshot = self.ws.refresh()
        relations = snapshot['delta']['relations']
        self.assertEqual(relations['totals'], {'added': 1, 'removed': 1})
        added, removed = relations['added'][0], relations['removed'][0]
        self.assertEqual((added['origin'], added['line'], added['target'], added['raw'], added['kind']),
                         (self.path('AGENTS.md'), 4, self.path('honeypot/irrelevante.md'), 'honeypot/irrelevante.md', 'markdown'))
        self.assertEqual(added['evidence'], '[Nova dependência](honeypot/irrelevante.md)')
        self.assertEqual(added['resolvedBy'], 'file')
        self.assertIn(added['edge'], {edge['id'] for edge in snapshot['edges']})
        # The removed one is the repeated line 4: file, line, target as written and kind, without evidence text.
        self.assertEqual(removed, {'origin': self.path('AGENTS.md'), 'source': self.path('AGENTS.md'), 'target': self.path('core/contrato.md'),
                                   'raw': 'core/contrato.md', 'kind': 'markdown', 'line': 4, 'targetStatus': 'resolved'})
        self.assertEqual([item['relative'] for item in snapshot['delta']['files']['changed']], ['AGENTS.md'])

    def test_rereading_twice_keeps_the_delta_and_undoing_the_edit_clears_it(self):
        self.ws.open(str(self.root))
        original = (self.root / 'AGENTS.md').read_text(encoding='utf-8')
        self.edit('AGENTS.md', '[Contrato repetido](core/contrato.md)', '[Nova dependência](honeypot/irrelevante.md)')
        first = self.ws.refresh()['delta']
        second = self.ws.refresh()['delta']
        self.assertEqual(second['relations']['totals'], {'added': 1, 'removed': 1})
        self.assertEqual(second['reference'], first['reference'])
        self.assertGreater(second['current']['at'], first['current']['at'])
        # Changes accumulate against the same reference.
        (self.root / 'novo.md').write_text('# Novo\n', encoding='utf-8')
        third = self.ws.refresh()['delta']
        self.assertEqual((third['relations']['totals'], third['files']['totals']['added']), ({'added': 1, 'removed': 1}, 1))
        (self.root / 'novo.md').unlink()
        (self.root / 'AGENTS.md').write_text(original, encoding='utf-8')
        self.assertEmpty(self.ws.refresh()['delta'])

    def test_adopting_the_current_reading_clears_the_delta_and_moves_the_reference_time(self):
        self.ws.open(str(self.root))
        self.edit('AGENTS.md', '[Obsoleto](obsoleto/ausente.md)', '[Obsoleto](obsoleto/outro.md)')
        before = self.ws.refresh()['delta']
        self.assertEqual(before['relations']['totals'], {'added': 1, 'removed': 1})
        adopted = self.ws.adopt_reference()['delta']
        self.assertEmpty(adopted)
        self.assertEqual(adopted['reference']['at'], before['current']['at'])
        self.assertGreater(adopted['reference']['at'], before['reference']['at'])
        self.assertEqual(adopted['roots'][0]['referenceOrigin'], 'user')
        # From now on, the reference is the adopted reading.
        self.edit('AGENTS.md', '[Obsoleto](obsoleto/outro.md)', '')
        after = self.ws.refresh()['delta']
        self.assertEqual([(item['raw'], item['line']) for item in after['relations']['removed']], [('obsoleto/outro.md', 5)])
        self.assertEqual(after['relations']['totals'], {'added': 0, 'removed': 1})

    def test_inserting_lines_above_moves_evidence_without_creating_relations(self):
        self.ws.open(str(self.root))
        self.edit('AGENTS.md', '# Agente sintético\n', '# Agente sintético\nLinha nova sem referência.\n\nOutra linha.\n')
        delta = self.ws.refresh()['delta']
        self.assertEqual(delta['relations']['totals'], EMPTY)
        self.assertEqual(delta['findings']['totals'], {'new': 0, 'resolved': 0})
        self.assertEqual(delta['files']['totals']['changed'], 1)
        self.assertTrue(any(edge['line'] == 8 and edge['raw'] == 'obsoleto/ausente.md' for edge in self.ws.model['edges']))

    def test_retargeted_reference_shows_line_and_findings(self):
        self.ws.open(str(self.root))
        self.edit('AGENTS.md', '[Obsoleto](obsoleto/ausente.md)', '[Obsoleto](obsoleto/outro.md)')
        delta = self.ws.refresh()['delta']
        self.assertEqual([(item['raw'], item['line'], item['targetStatus']) for item in delta['relations']['added']], [('obsoleto/outro.md', 5, 'missing')])
        self.assertEqual([(item['raw'], item['line'], item['targetStatus']) for item in delta['relations']['removed']], [('obsoleto/ausente.md', 5, 'missing')])
        self.assertEqual([(item['code'], item['target'], item['line'], item['node']) for item in delta['findings']['new']], [('broken', 'obsoleto/outro.md', 5, self.path('AGENTS.md'))])
        self.assertEqual([(item['code'], item['target'], item['node']) for item in delta['findings']['resolved']], [('broken', 'obsoleto/ausente.md', self.path('AGENTS.md'))])

    def cli_audit(self, destination):
        result = subprocess.run([sys.executable, '-B', '-m', 'server.cli', 'audit', '--root', str(self.root)],
                                cwd=REPOSITORY, capture_output=True, text=True, timeout=60)
        self.assertIn(result.returncode, {0, 1}, result.stderr)
        destination.write_text(result.stdout, encoding='utf-8')
        return destination

    def test_findings_match_the_cli_compare_audit_for_the_same_two_states(self):
        self.ws.open(str(self.root))
        before = self.cli_audit(self.base / 'antes.json')
        self.edit('AGENTS.md', '[Contrato repetido](core/contrato.md)', '[Nova dependência](honeypot/irrelevante.md)\n[Quebrada](core/inexistente.md)')
        (self.root / 'conditional' / 'incidente.md').unlink()
        after = self.cli_audit(self.base / 'depois.json')
        self.ws.refresh()  # an intermediate reading does not move the reference
        findings = self.ws.refresh()['delta']['findings']
        result = subprocess.run([sys.executable, '-B', '-m', 'server.cli', 'compare-audit', '--before', str(before), '--after', str(after)],
                                cwd=REPOSITORY, capture_output=True, text=True, timeout=60)
        comparison = json.loads(result.stdout)
        self.assertEqual(comparison['kind'], 'audit-comparison')
        self.assertTrue(comparison['new'] and comparison['resolved'])
        self.assertEqual(sorted(item['id'] for item in findings['new']), sorted(item['id'] for item in comparison['new']))
        self.assertEqual(sorted(item['id'] for item in findings['resolved']), sorted(item['id'] for item in comparison['resolved']))
        self.assertEqual(findings['persisting'], comparison['persisting'])
        self.assertEqual(findings['byCode'], comparison['byCode'])
        self.assertEqual(findings['status'], comparison['status'])
        for item in findings['new'] + findings['resolved']:
            self.assertTrue(item['node'].startswith(str(self.root)))

    def test_reference_is_compact_serializable_and_without_document_text(self):
        self.ws.open(str(self.root))
        reference = self.ws.references[str(self.root)]
        encoded = json.dumps(reference, ensure_ascii=False)
        self.assertNotIn('REQUISITO_A', encoded)
        self.assertNotIn('[Contrato repetido]', encoded)
        self.assertEqual(set(reference), {'version', 'root', 'name', 'at', 'reader', 'files', 'relations', 'unlisted', 'listed', 'audit', 'origin', 'context', 'phrases'})
        self.assertEqual(set(reference['relations'][0]), {'origin', 'source', 'target', 'kind', 'raw', 'line', 'evidenceHash', 'status', 'edge'})
        self.assertEqual(reference['files']['AGENTS.md']['sha256'], hashlib.sha256((self.root / 'AGENTS.md').read_bytes()).hexdigest())
        self.assertEqual(reference['files']['diagram.png'], {'sha256': None, 'bytes': 16})
        self.assertTrue(all(len(item['id']) == 16 for item in reference['audit']['findings']))

    def test_notes_close_reopen_and_forget_keep_the_reference_and_a_restart_loads_it(self):
        reference = self.ws.open(str(self.root))['delta']['reference']
        self.edit('AGENTS.md', '[Obsoleto](obsoleto/ausente.md)', '')
        self.ws.note(self.path('AGENTS.md'), 'Comentário salvo entre leituras.')
        delta = self.ws.refresh()['delta']
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 1})
        self.ws.note(self.path('core/contrato.md'), 'Outro comentário.')
        self.assertIs(self.ws.snapshot()['delta'], delta)
        self.assertEqual(self.ws.refresh()['delta']['reference'], reference)
        # Closing and reopening in the same server process keeps the reference of the root.
        other = self.base / 'outro'
        other.mkdir()
        (other / 'AGENTS.md').write_text('# Outro\n', encoding='utf-8')
        self.ws.open(str(other))
        self.ws.close(str(self.root))
        reopened = self.ws.open(str(self.root))['delta']
        mine = next(item for item in reopened['roots'] if item['path'] == str(self.root))
        self.assertEqual(mine['referenceAt'], reference['at'])
        # Read with another root open: relations and findings of the root are not compared, and the delta says why.
        self.assertEqual(mine['context'], 'changed')
        self.assertIn({'root': str(self.root), 'code': 'reference-context-changed', 'message': readings.CONTEXT_CHANGED},
                      self.ws.snapshot()['delta']['warnings'])
        self.assertEqual(reopened['relations']['totals'], {'added': 0, 'removed': 0})
        self.assertEqual(reopened['files']['totals'], {'added': 0, 'removed': 0, 'changed': 1})
        self.ws.close(str(other))
        kept = self.ws.delta
        self.ws.forget(str(other))
        self.assertIs(self.ws.delta, kept)
        self.assertIsNone(self.ws.close(str(self.root))['delta'])
        # A restarted server loads the saved reference at its first reading of the root.
        restarted = Workspace(self.base / 'state')
        self.assertIsNone(restarted.snapshot()['delta'])
        loaded = restarted.open(str(self.root))['delta']
        self.assertEqual(loaded['reference']['at'], reference['at'])
        self.assertEqual(loaded['roots'][0]['referenceOrigin'], 'persisted')
        self.assertEqual(loaded['relations']['totals'], {'added': 0, 'removed': 1})

    def test_root_opened_later_starts_its_own_reference(self):
        self.ws.open(str(self.root))
        other = self.base / 'outro'
        (other / 'docs').mkdir(parents=True)
        (other / 'AGENTS.md').write_text('# Outro\n[Guia](docs/guia.md)\n', encoding='utf-8')
        (other / 'docs' / 'guia.md').write_text('# Guia\n', encoding='utf-8')
        self.edit('AGENTS.md', '[Obsoleto](obsoleto/ausente.md)', '[Novo](noise/rascunho.md)')
        delta = self.ws.open(str(other))['delta']
        times = {item['path']: item['referenceAt'] for item in delta['roots']}
        self.assertLess(times[str(self.root)], times[str(other)])
        self.assertEqual(delta['reference'], {'at': times[str(self.root)], 'uniform': False})
        self.assertEqual(delta['files']['totals'], {'added': 0, 'removed': 0, 'changed': 1})
        # The reference of the first root was read alone: its relations are not compared with two roots open.
        self.assertEqual({item['path']: item['context'] for item in delta['roots']}, {str(self.root): 'changed', str(other): 'same'})
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})
        (other / 'docs' / 'guia.md').write_text('# Guia\n[Volta](../AGENTS.md)\n', encoding='utf-8')
        delta = self.ws.refresh()['delta']
        self.assertEqual([(item['origin'], item['line']) for item in delta['relations']['added']], [(str(other / 'docs' / 'guia.md'), 2)])
        adopted = self.ws.adopt_reference()['delta']
        self.assertEqual(adopted['reference']['uniform'], True)
        self.assertEqual([item['context'] for item in adopted['roots']], ['same', 'same'])
        self.assertEmpty(adopted)
        # In the same context, a change in either root shows again.
        self.edit('AGENTS.md', '[Novo](noise/rascunho.md)', '')
        delta = self.ws.refresh()['delta']
        self.assertEqual([(item['origin'], item['line']) for item in delta['relations']['removed']], [(self.path('AGENTS.md'), 5)])

    def test_opening_a_nested_root_neither_fakes_removals_nor_duplicates_changes(self):
        child = self.root / 'conditional'
        (child / 'AGENTS.md').write_text('# Filho\n[Incidente](incidente.md)\n', encoding='utf-8')
        self.ws.open(str(self.root))
        delta = self.ws.open(str(child))['delta']
        self.assertEqual([item['path'] for item in delta['roots']], [str(self.root), str(child)])
        self.assertEmpty(delta)
        (child / 'AGENTS.md').write_text('# Filho\n[Incidente](incidente.md)\n[Novo](novo.md)\n', encoding='utf-8')
        delta = self.ws.refresh()['delta']
        self.assertEqual([(item['origin'], item['line'], item['targetStatus']) for item in delta['relations']['added']], [(str(child / 'AGENTS.md'), 3, 'missing')])
        self.assertEqual([item['path'] for item in delta['files']['changed']], [str(child / 'AGENTS.md')])
        self.assertEqual([(item['code'], item['target']) for item in delta['findings']['new']], [('broken', 'novo.md')])
        self.ws.close(str(child))
        self.assertEqual(self.ws.delta['relations']['totals'], {'added': 1, 'removed': 0})

    def test_a_finding_of_a_nested_root_is_listed_once_whatever_words_each_baseline_keeps(self):
        # The outer root and the nested one each read the nested files. When the update of the nested baseline was
        # not saved, it is the one an earlier version saved, with the messages in Portuguese: still one finding each.
        child = self.root / 'conditional'
        (child / 'AGENTS.md').write_text('# Filho\n[Sumiu](sumiu.md) e [Outro](outro.md)\n', encoding='utf-8')
        self.ws.open(str(self.root))
        self.ws.open(str(child))
        self.ws.adopt_reference()
        saved = self.ws.references[str(child)]['audit']['findings']
        for item in saved:
            item['message'] = portuguese(item['message'], json.loads(item.pop(readings.PHRASE)) if readings.PHRASE in item else None)
        self.assertIn('Destino não encontrado: sumiu.md', [item['message'] for item in saved])
        (child / 'AGENTS.md').write_text('# Filho\n', encoding='utf-8')
        delta = self.ws.refresh()['delta']
        # Two findings on one line, told apart by their target: each listed once, in the words of the outer baseline.
        self.assertEqual([(item['code'], item['target'], item['message']) for item in delta['findings']['resolved']],
                         [('broken', 'outro.md', 'Target not found: outro.md'), ('broken', 'sumiu.md', 'Target not found: sumiu.md')])
        self.assertEqual(delta['findings']['totals'], {'new': 0, 'resolved': 2})
        self.assertEqual(delta['findings']['byCode']['broken']['resolved'], 2)

    def nested_baselines(self, first, second, third, limits=None):
        """The resolved findings of a project and the one inside it whose baselines are of two moments: both open and
        their baselines set (`first`), then `second`, and the inner project forgotten and opened again, so its first
        reading is its baseline; then `third`. `limits`: constants of the scanner for every reading."""
        import scanner
        with ExitStack() as stack:
            for name, value in (limits or {}).items():
                stack.enter_context(patch.object(scanner, name, value))
            parent = self.base / 'pai'
            child = parent / 'filho'
            self.write(parent / 'AGENTS.md', '# Pai\n[filho](filho/AGENTS.md)\n')
            self.write(child / 'AGENTS.md', '# Filho\n')
            first(child)
            self.ws.open(str(parent))
            self.ws.open(str(child))
            self.ws.adopt_reference()
            second(child)
            self.ws.forget(str(child), close=True)
            self.ws.open(str(child))
            third(child)
            delta = self.ws.refresh()['delta']
        self.assertEqual([item['context'] for item in delta['roots']], ['same', 'same'])
        return delta['findings']

    @staticmethod
    def write(path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text) if isinstance(text, bytes) else path.write_text(text, encoding='utf-8')

    def test_two_findings_of_one_code_on_one_line_each_in_the_baseline_of_one_nested_root_are_both_resolved(self):
        # One observation is in the baseline of the outer project, another of the same code, on the same line of the
        # same file, in the baseline of the inner one: both are resolved, though nothing but their code, file and line
        # is in the id of `aae audit`. Before, the second one was left out of the list, the counts and byCode.
        named = lambda folder, name: Path(os.fsdecode(os.path.join(os.fsencode(folder), name)))
        cases = {
            # Two names that are not UTF-8 in one folder: told apart by the message only.
            'unreadable': (lambda child: self.write(named(child / 'docs', b'x\xff.md'), b'x'),
                           lambda child: (named(child / 'docs', b'x\xff.md').rename(child / 'docs' / 'x.md'),
                                          self.write(named(child / 'docs', b'y\xfe.md'), b'y')),
                           lambda child: named(child / 'docs', b'y\xfe.md').rename(child / 'docs' / 'y.md'),
                           None, ['x\\xff.md', 'y\\xfe.md']),
            # On the folder of the inner root: the inventory limit, then the text budget (the one with counts).
            'limit': (lambda child: [self.write(child / 'extra' / f'n{index:02d}' / 'a.md', 'x\n') for index in range(20)],
                      lambda child: (shutil.rmtree(child / 'extra'), self.write(child / 'grande.md', 'texto ' * 600)),
                      lambda child: (child / 'grande.md').unlink(),
                      {'MAX_FILES': 12, 'MAX_TEXT_TOTAL': 2000}, ['Inventory limit reached in filho', 'Text budget of the scan reached']),
            # One file: an invalid scope declaration, then an invalid manifest (the message only, again).
            'manifest': (lambda child: self.write(child / 'agent-architecture.json', json.dumps({'scope': {'version': 1, 'entries': ['/x.md']}})),
                         lambda child: self.write(child / 'agent-architecture.json', '{"objects": 3}'),
                         lambda child: (child / 'agent-architecture.json').unlink(),
                         None, ['Invalid scope declaration, ignored', 'Invalid manifest']),
            # One pattern, of one kind and then of another.
            'scope-unused-pattern': (lambda child: self.write(child / 'agent-architecture.json', json.dumps({'scope': {'version': 1, 'runtimeWorkspace': ['nunca/']}})),
                                     lambda child: self.write(child / 'agent-architecture.json', json.dumps({'scope': {'version': 1, 'localFiles': ['nunca/']}})),
                                     lambda child: (child / 'agent-architecture.json').unlink(),
                                     None, ['(runtimeWorkspace: nunca/)', '(localFiles: nunca/)']),
            # One link, a member of a manifest and then of another one nested in it.
            'manifest-mismatch': (lambda child: (self.write(child / 'sub' / 'a.md', '# a\n[b](b.md)\n'), self.write(child / 'sub' / 'b.md', '# b\n'),
                                                 self.write(child / 'agent-architecture.json', json.dumps(
                                                     {'linkedRelationships': True, 'objects': [{'path': 'sub/a.md'}, {'path': 'sub/b.md'}], 'relationships': []}))),
                                  lambda child: ((child / 'agent-architecture.json').unlink(), self.write(child / 'sub' / 'agent-architecture.json', json.dumps(
                                      {'linkedRelationships': True, 'objects': [{'path': 'a.md'}, {'path': 'b.md'}], 'relationships': []}))),
                                  lambda child: self.write(child / 'sub' / 'a.md', '# a\n'),
                                  None, ['manifest ../agent-architecture.json:', 'manifest agent-architecture.json:']),
        }
        for code, (first, second, third, limits, words) in cases.items():
            with self.subTest(code=code):
                self.setUp()
                findings = self.nested_baselines(first, second, third, limits)
                resolved = [item['message'] for item in findings['resolved'] if item['code'] == code]
                # Each observation is there (a name not UTF-8 is seen by the walk of each root, so twice: as before).
                self.assertEqual([word for word in words if not any(word in message for message in resolved)], [])
                self.assertEqual(findings['byCode'][code]['resolved'], len(resolved))
                self.assertEqual(findings['totals']['resolved'], len(findings['resolved']))

    def test_one_finding_in_both_nested_baselines_is_listed_once(self):
        # Control: the link of a nested manifest, in both baselines of the same moment; the manifest of the finding is
        # written relative to each root, and is the same file. The same with an invalid manifest and a size limit.
        def first(child):
            self.write(child / 'sub' / 'a.md', '# a\n[b](b.md)\n')
            self.write(child / 'sub' / 'b.md', '# b\n')
            self.write(child / 'sub' / 'agent-architecture.json', json.dumps(
                {'linkedRelationships': True, 'objects': [{'path': 'a.md'}, {'path': 'b.md'}], 'relationships': []}))
            self.write(child / 'ruim' / 'agent-architecture.json', '{"objects": 3}')
            self.write(child / 'grande.md', 'x' * (1024 * 1024 + 1))

        def fix(child):
            self.write(child / 'sub' / 'a.md', '# a\n')
            self.write(child / 'ruim' / 'agent-architecture.json', '{"objects": []}')
            self.write(child / 'grande.md', 'x\n')
        child = self.root / 'conditional'
        (child / 'AGENTS.md').write_text('# Filho\n[m](ruim/agent-architecture.json) [g](grande.md)\n', encoding='utf-8')
        first(child)
        self.ws.open(str(self.root))
        self.ws.open(str(child))
        self.ws.adopt_reference()
        fix(child)
        resolved = self.ws.refresh()['delta']['findings']['resolved']
        self.assertEqual(sorted(item['code'] for item in resolved if item['code'] != 'analysis-partial'), ['limit', 'manifest', 'manifest-mismatch'])

    def test_a_finding_told_apart_by_its_message_is_listed_once_for_each_version_that_saved_it(self):
        # The cost of the message in the key of `unreadable` and `manifest`: the same finding, in a baseline saved by a
        # version that wrote Portuguese and in one of this version, is listed once for each. A finding of another
        # code is listed once: here the limit of a file too large.
        child = self.root / 'conditional'
        (child / 'AGENTS.md').write_text('# Filho\n[g](grande.md)\n', encoding='utf-8')
        self.write(child / 'grande.md', 'x' * (1024 * 1024 + 1))
        named = Path(os.fsdecode(os.path.join(os.fsencode(child / 'docs'), b'n\xff.md')))
        self.write(named, b'n')
        self.ws.open(str(self.root))
        self.ws.open(str(child))
        self.ws.adopt_reference()
        reference = self.ws.references[str(child)]
        reference.pop('phrases', None)
        for item in reference['audit']['findings']:
            item['message'] = portuguese(item['message'], json.loads(item.pop(readings.PHRASE)) if readings.PHRASE in item else None)
        named.rename(child / 'docs' / 'n.md')
        self.write(child / 'grande.md', 'x\n')
        resolved = self.ws.refresh()['delta']['findings']['resolved']
        self.assertEqual(sorted((item['code'], item['message'][:30]) for item in resolved if item['code'] in ('limit', 'unreadable')), [
            ('limit', 'File listed, but not analyzed:'),
            # A name not UTF-8 is seen by the walk of each root: twice in each baseline, as before.
            ('unreadable', 'A name that is not valid UTF-8'), ('unreadable', 'A name that is not valid UTF-8'),
            ('unreadable', 'Nome que não é UTF-8 válido, d'), ('unreadable', 'Nome que não é UTF-8 válido, d')])

    def test_a_nested_root_below_an_excluded_folder_is_read_only_by_itself(self):
        # The walk of the outer root never enters node_modules: the files there are the nested root's own.
        nested = self.root / 'node_modules' / 'pkg'
        nested.mkdir(parents=True)
        (nested / 'AGENTS.md').write_text('# Pacote\n[X](x.md)\n[Ausente](ausente.md)\n', encoding='utf-8')
        (nested / 'x.md').write_text('# X\n', encoding='utf-8')
        self.ws.open(str(self.root))
        delta = self.ws.open(str(nested))['delta']
        self.assertEmpty(delta)
        self.assertEqual(sorted(self.ws.current[str(self.root)]['files']), sorted(readings.read(scan([str(self.root)]), 'x')[str(self.root)]['files']))
        # A real change in the outer root still shows, credited to it; one in the nested root, to the nested root.
        self.edit('AGENTS.md', '[Obsoleto](obsoleto/ausente.md)', '[Novo](noise/rascunho.md)')
        (nested / 'x.md').write_text('# X alterado\n', encoding='utf-8')
        delta = self.ws.refresh()['delta']
        self.assertEqual([item['path'] for item in delta['files']['changed']], [self.path('AGENTS.md'), str(nested / 'x.md')])
        self.assertEqual({item['path']: item['root'] for item in delta['files']['changed']},
                         {self.path('AGENTS.md'): str(self.root), str(nested / 'x.md'): str(nested)})
        # The outer reference was read alone: its relations are compared only in that context.
        self.assertEqual([item['context'] for item in delta['roots']], ['changed', 'same'])
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})
        self.ws.adopt_reference()
        self.edit('AGENTS.md', '[Novo](noise/rascunho.md)', '[Outro](noise/outro.md)')
        delta = self.ws.refresh()['delta']
        self.assertEqual(delta['relations']['totals'], {'added': 1, 'removed': 1})
        self.ws.adopt_reference()
        # Closing the nested root after adopting removes nothing from the outer root.
        closed = self.ws.close(str(nested))['delta']
        self.assertEmpty(closed)
        self.assertEqual(closed['files']['uncompared'], 0)
        # Opening it again with a saved reference of the outer root alone adds nothing either.
        self.assertEmpty(self.ws.open(str(nested))['delta'])
        restarted = Workspace(self.base / 'state').snapshot()['delta']
        self.assertEqual([item['referenceOrigin'] for item in restarted['roots']], ['persisted', 'persisted'])
        self.assertEmpty(restarted)

    def test_a_reference_saved_with_the_inside_of_such_a_nested_root_drops_it_when_loaded(self):
        # A reference saved with the inside of the nested root: its files, relations and findings.
        nested = self.root / 'node_modules' / 'pkg'
        nested.mkdir(parents=True)
        (nested / 'AGENTS.md').write_text('# Pacote\n[X](x.md)\n[Ausente](ausente.md)\n', encoding='utf-8')
        (nested / 'x.md').write_text('# X\n', encoding='utf-8')
        with patch.object(readings, '_unwalked', lambda relative: False):
            self.ws.open(str(self.root))
            self.ws.open(str(nested))
            self.ws.adopt_reference()
        store = readings.ReferenceStore(self.base / 'state')
        saved = store.load_file(str(self.root))
        self.assertIsNotNone(saved[0])
        self.assertIn('node_modules/pkg/x.md', self.ws.references[str(self.root)]['files'])
        workspace = Workspace(self.base / 'state')
        restarted = workspace.snapshot()['delta']
        self.assertEqual([item['referenceOrigin'] for item in restarted['roots']], ['persisted', 'persisted'])
        self.assertEmpty(restarted)
        self.assertEqual(sorted(saved[0]['files']), sorted(workspace.current[str(self.root)]['files']))

    def test_two_nested_roots_below_excluded_folders_keep_the_outer_comparison(self):
        first, second = self.root / 'node_modules' / 'p1', self.root / 'noise' / 'build' / 'p2'
        inner = first / 'sub'  # nested in p1 and reached by its walk: p1's own, not the outer root's
        for folder in (first, second, inner):
            folder.mkdir(parents=True)
            (folder / 'AGENTS.md').write_text('# Pacote\n[X](x.md)\n', encoding='utf-8')
            (folder / 'x.md').write_text('# X\n', encoding='utf-8')
        self.ws.open(str(self.root))
        reference = dict(self.ws.references[str(self.root)]['files'])
        for folder in (first, second, inner):
            self.assertEmpty(self.ws.open(str(folder))['delta'])
        self.assertEqual(self.ws.current[str(self.root)]['files'], reference)
        self.assertEqual(sorted(self.ws.current[str(first)]['files']), ['AGENTS.md', 'sub/AGENTS.md', 'sub/x.md', 'x.md'])
        self.ws.adopt_reference()
        for folder in (inner, second, first):
            self.assertEmpty(self.ws.close(str(folder))['delta'])
        self.assertEqual(self.ws.current[str(self.root)]['files'], reference)

    def test_a_nested_root_the_outer_walk_reaches_stays_in_the_outer_reading(self):
        # Control: outside an excluded folder, the outer root reads the nested files itself, opened or not.
        child = self.root / 'conditional'
        self.ws.open(str(self.root))
        reference = dict(self.ws.references[str(self.root)]['files'])
        self.assertIn('conditional/incidente.md', reference)
        self.assertEmpty(self.ws.open(str(child))['delta'])
        self.assertEqual(self.ws.current[str(self.root)]['files'], reference)
        self.ws.adopt_reference()
        self.assertEmpty(self.ws.close(str(child))['delta'])
        (child / 'incidente.md').write_text('# Incidente alterado\n', encoding='utf-8')
        self.assertEqual([item['root'] for item in self.ws.refresh()['delta']['files']['changed']], [str(self.root)])

    def test_a_reference_into_an_excluded_folder_keeps_the_outer_comparison(self):
        # The outer root names a file of the nested root; that file is read only by the nested root.
        nested = self.root / 'node_modules' / 'pkg'
        nested.mkdir(parents=True)
        (nested / 'x.md').write_text('# X\n', encoding='utf-8')
        self.edit('AGENTS.md', '[Obsoleto](obsoleto/ausente.md)', '[Pacote](node_modules/pkg/x.md)')
        self.ws.open(str(self.root))
        self.assertEmpty(self.ws.open(str(nested))['delta'])
        self.ws.adopt_reference()
        self.assertEmpty(self.ws.close(str(nested))['delta'])

    def test_lists_are_bounded_with_totals(self):
        self.ws.open(str(self.root))
        for index in range(7):
            (self.root / f'extra-{index}.md').write_text(f'# Extra {index}\n[Contrato](core/contrato.md)\n', encoding='utf-8')
        with patch.object(readings, 'LIMIT', 3):
            delta = self.ws.refresh()['delta']
        self.assertEqual((len(delta['files']['added']), delta['files']['totals']['added']), (3, 7))
        self.assertEqual((len(delta['relations']['added']), delta['relations']['totals']['added']), (3, 7))
        self.assertEqual((len(delta['findings']['new']), delta['findings']['totals']['new']), (3, 7))  # seven new orphan candidates

    def test_scanner_hashes_analysed_texts_and_counts_signals(self):
        model = scan([str(self.root)])
        nodes = {node['id']: node for node in model['nodes']}
        data = (self.root / 'AGENTS.md').read_bytes()
        self.assertEqual(nodes[self.path('AGENTS.md')]['sha256'], hashlib.sha256(data).hexdigest())
        self.assertNotIn('sha256', nodes[self.path('diagram.png')])
        self.assertNotIn('sha256', nodes[self.path('obsoleto/ausente.md')])
        repeated = [signal for signal in model['signals'] if signal['code'] == 'repeated-reference']
        self.assertEqual([signal['count'] for signal in repeated], [2])
        (self.root / 'hub.md').write_text('# Hub\n' + ''.join(f'[{index}](d{index}.md)\n' for index in range(13)), encoding='utf-8')
        (self.root / 'loop.md').write_text('# Loop\n[Hub](hub.md)\n', encoding='utf-8')
        (self.root / 'd0.md').write_text('[Loop](loop.md)\n', encoding='utf-8')
        model = scan([str(self.root)])
        counts = {signal['code']: signal['count'] for signal in model['signals'] if signal['code'] in {'high-fanout', 'cycle'}}
        self.assertEqual(counts, {'high-fanout': 13, 'cycle': 3})


class ReadingDeltaHttpTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-reading-delta-http-')
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.root = base / 'pacote'
        self.root.mkdir()
        (self.root / 'AGENTS.md').write_text('# Pacote\n[Guia](guia.md)\n', encoding='utf-8')
        (self.root / 'guia.md').write_text('# Guia\n', encoding='utf-8')
        static = base / 'static'
        static.mkdir()
        (static / 'index.html').write_text('<title>delta</title>')
        clock_patch = patch.object(readings, 'now', clock())
        clock_patch.start()
        self.addCleanup(clock_patch.stop)
        self.ws = Workspace(base / 'state')
        self.ws.open(str(self.root))
        handler = make_handler(self.ws, static, 'delta-token')
        handler.log_message = lambda *args: None
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method, route, body=None, token='delta-token', status=200):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        headers = {'Host': f'127.0.0.1:{self.server.server_port}', 'X-AAE-Token': token}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        connection.request(method, route, payload, headers)
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        self.assertEqual(response.status, status, data)
        return data

    def test_api_keeps_the_reference_until_the_user_adopts_the_current_reading(self):
        reference = self.request('GET', '/api/workspace')['delta']['reference']
        (self.root / 'AGENTS.md').write_text('# Pacote\n[Guia](guia.md)\n[Novo](novo.md)\n', encoding='utf-8')
        refreshed = self.request('POST', '/api/refresh', {})['delta']
        self.assertEqual(refreshed['relations']['added'][0]['line'], 3)
        self.request('POST', '/api/note', {'node': str(self.root / 'guia.md'), 'body': 'nota'})
        self.assertEqual(self.request('GET', '/api/workspace')['delta'], refreshed)
        again = self.request('POST', '/api/refresh', {})['delta']
        self.assertEqual((again['reference'], again['relations']['totals']), (reference, {'added': 1, 'removed': 0}))
        self.request('POST', '/api/reference', {}, token='wrong', status=403)
        self.assertEqual(self.ws.delta['reference'], reference)
        adopted = self.request('POST', '/api/reference', {})['delta']
        self.assertEqual(adopted['reference']['at'], again['current']['at'])
        self.assertEqual(adopted['relations']['totals'], EMPTY)


if __name__ == '__main__':
    unittest.main()
