"""Persistent reference readings: saved per root in the state directory, loaded as untrusted input."""
import gzip
import hashlib
import http.client
import itertools
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import tracemalloc
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import delta as readings
from main import make_handler
import scanner
from tests.create_audit_lab import create_lab
from workspace import Workspace
from tests.server_pack import portuguese

MARKER = 'MARCADOR_CONTEUDO_SINTETICO_7f3a'
AGENTS = f'# Agente sintético\n{MARKER} no corpo da entrada.\n[Contrato {MARKER}](core/contrato.md)\n[Obsoleto](obsoleto/ausente.md)\n'


def clock():
    counter = itertools.count()
    return lambda: f'2026-10-01T18:{next(counter):02d}:00-03:00'


class SavedReferenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-saved-reference-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'atlas'
        for name, text in {'AGENTS.md': AGENTS, 'core/contrato.md': f'# Contrato\n{MARKER}\n', 'notas/rascunho.md': '# Rascunho\n'}.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
        self.state = self.base / 'state'
        clock_patch = patch.object(readings, 'now', clock())
        clock_patch.start()
        self.addCleanup(clock_patch.stop)
        self.ws = Workspace(self.state)

    def saved(self, root=None):
        return self.state / 'references' / (hashlib.sha256(str(root or self.root).encode()).hexdigest() + '.json.gz')

    def document(self, root=None):
        return json.loads(gzip.decompress(self.saved(root).read_bytes()))

    def write(self, document, root=None):
        self.saved(root).write_bytes(gzip.compress(json.dumps(document).encode()))

    def edit(self, old, new):
        entry = self.root / 'AGENTS.md'
        text = entry.read_text(encoding='utf-8')
        self.assertIn(old, text)
        entry.write_text(text.replace(old, new, 1), encoding='utf-8')

    def assertSavedAt(self, at):
        document = self.document()
        self.assertEqual((document['kind'], document['format'], document['root']), ('aae-reference', 1, str(self.root)))
        self.assertEqual(document['reference']['at'], at)

    def assertIgnored(self, delta, fragment):
        self.assertEqual(delta['roots'][0]['referenceOrigin'], 'first-reading')
        self.assertEqual([item['code'] for item in delta['warnings'] if item['code'] == 'reference-ignored'], ['reference-ignored'])
        warning = next(item for item in delta['warnings'] if item['code'] == 'reference-ignored')
        self.assertEqual(warning['root'], str(self.root))
        self.assertIn(fragment, warning['message'])
        self.assertIn('This scan became the baseline', warning['message'])
        # A Portuguese interface words the warning, reason included, as the server did before.
        said = portuguese(warning['message'])
        self.assertRegex(said, r'^Referência salva ignorada: [a-zà-ú][^.]+\. Esta leitura passou a ser a referência\.$')
        self.assertNotIn(fragment, said)
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})

    def test_restart_restores_the_case_already_compared_with_the_saved_reference(self):
        first = self.ws.open(str(self.root))['delta']
        self.assertTrue(first['roots'][0]['referenceSaved'])
        self.assertSavedAt(first['reference']['at'])
        self.assertEqual(stat.S_IMODE(self.saved().stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.saved().parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.ws.state_file.stat().st_mode), 0o600)
        self.edit('[Obsoleto](obsoleto/ausente.md)', '[Novo](notas/rascunho.md)')
        # "Restart": a new Workspace over the same state directory restores the open case at startup.
        restarted = Workspace(self.state)
        delta = restarted.snapshot()['delta']
        self.assertEqual(delta['roots'], [{'path': str(self.root), 'name': 'atlas', 'referenceAt': first['reference']['at'],
                                           'referenceOrigin': 'persisted', 'referenceSaved': True, 'context': 'same'}])
        self.assertEqual(delta['warnings'], [])
        self.assertEqual(delta['reference']['at'], first['reference']['at'])
        self.assertEqual([(item['raw'], item['line']) for item in delta['relations']['added']], [('notas/rascunho.md', 4)])
        self.assertEqual([(item['raw'], item['line']) for item in delta['relations']['removed']], [('obsoleto/ausente.md', 4)])
        # The reference findings came from the file: the link fixed one and reached the draft.
        self.assertEqual(sorted(item['code'] for item in delta['findings']['resolved']), ['broken', 'unreachable'])
        self.assertEqual([item['relative'] for item in delta['files']['changed']], ['AGENTS.md'])
        # Rereading after the restart keeps comparing with the saved reference, without rewriting it.
        before = self.saved().stat().st_mtime_ns, self.saved().read_bytes()
        again = restarted.refresh()['delta']
        self.assertEqual((again['reference']['at'], again['relations']['totals']), (first['reference']['at'], {'added': 1, 'removed': 1}))
        self.assertEqual((self.saved().stat().st_mtime_ns, self.saved().read_bytes()), before)

    def test_adopting_rewrites_the_saved_reference(self):
        self.ws.open(str(self.root))
        self.edit('[Obsoleto](obsoleto/ausente.md)', '')
        current = self.ws.refresh()['delta']['current']['at']
        adopted = self.ws.adopt_reference()['delta']
        self.assertEqual((adopted['roots'][0]['referenceOrigin'], adopted['roots'][0]['referenceSaved']), ('user', True))
        self.assertSavedAt(current)
        restarted = Workspace(self.state).snapshot()['delta']
        self.assertEqual((restarted['reference']['at'], restarted['roots'][0]['referenceOrigin']), (current, 'persisted'))
        self.assertEqual(restarted['relations']['totals'], {'added': 0, 'removed': 0})

    def test_forgetting_erases_the_saved_reference_closing_keeps_it(self):
        at = self.ws.open(str(self.root))['delta']['reference']['at']
        self.ws.close(str(self.root))
        self.assertTrue(self.saved().is_file())
        restarted = Workspace(self.state)
        self.assertEqual(restarted.open(str(self.root))['delta']['reference']['at'], at)
        restarted.close(str(self.root))
        snapshot = restarted.forget(str(self.root))
        self.assertEqual(snapshot['restoreErrors'], [])
        self.assertFalse(self.saved().exists())
        # The forgotten reference is gone from memory too: the case starts a new one, saved again.
        reopened = restarted.open(str(self.root))['delta']
        self.assertEqual(reopened['roots'][0]['referenceOrigin'], 'first-reading')
        self.assertGreater(reopened['reference']['at'], at)
        self.assertSavedAt(reopened['reference']['at'])

    def test_saved_reference_holds_no_document_content(self):
        self.ws.open(str(self.root))
        self.edit('# Agente sintético\n', f'# Agente sintético\n[Mais {MARKER}](core/contrato.md)\n')
        self.ws.refresh()
        self.ws.adopt_reference()
        compressed = self.saved().read_bytes()
        expanded = gzip.decompress(compressed)
        for data in (compressed, expanded):
            self.assertNotIn(MARKER.encode(), data)
        self.assertNotIn('[Contrato', expanded.decode())
        reference = self.document()['reference']
        self.assertEqual(set(reference), {'version', 'root', 'name', 'at', 'reader', 'files', 'relations', 'unlisted', 'listed', 'audit', 'context', 'phrases'})
        self.assertEqual(set(reference['relations'][0]), {'origin', 'source', 'target', 'kind', 'raw', 'line', 'evidenceHash', 'status', 'edge'})

    def test_invalid_saved_files_are_ignored_with_a_warning_and_replaced(self):
        self.ws.open(str(self.root))
        good = self.saved().read_bytes()
        document = json.loads(gzip.decompress(good))
        self.ws.close(str(self.root))
        reference = document['reference']
        other = {**document, 'root': str(self.base / 'outro'), 'reference': {**reference, 'root': str(self.base / 'outro')}}
        bad_line = {**document, 'reference': {**reference, 'relations': [{**reference['relations'][0], 'line': '3'}]}}
        escaping = {**document, 'reference': {**reference, 'files': {'../fora.md': {'sha256': None, 'bytes': 1}}}}
        bad_finding = {**document, 'reference': {**reference, 'audit': {**reference['audit'], 'findings': [{'id': 'x', 'code': 'broken'}]}}}
        cases = {
            'corrompido': (lambda: self.saved().write_bytes(b'not gzip at all'), 'corrupted'),
            'truncado': (lambda: self.saved().write_bytes(good[:len(good) // 2]), 'corrupted'),
            'json': (lambda: self.saved().write_bytes(gzip.compress(b'{"kind": "aae-reference", ')), 'corrupted'),
            'profundo': (lambda: self.saved().write_bytes(gzip.compress(b'[' * 100000 + b']' * 100000)), 'corrupted'),
            'nan': (lambda: self.saved().write_bytes(gzip.compress(json.dumps({**document, 'x': float('nan')}).encode())), 'corrupted'),
            'outra raiz': (lambda: self.write(other), 'another root'),
            'formato': (lambda: self.write({**document, 'format': 2}), 'incompatible format version'),
            'versão': (lambda: self.write({**document, 'reference': {**reference, 'version': 99}}), 'incompatible format version'),
            'tipos': (lambda: self.write(bad_line), 'invalid types or values'),
            'caminho': (lambda: self.write(escaping), 'invalid types or values'),
            'achado': (lambda: self.write(bad_finding), 'invalid types or values'),
        }
        for label, (corrupt, fragment) in cases.items():
            with self.subTest(case=label):
                corrupt()
                workspace = Workspace(self.state)
                delta = workspace.open(str(self.root))['delta']
                self.assertIgnored(delta, fragment)
                # The new reference replaced the invalid file.
                self.assertTrue(delta['roots'][0]['referenceSaved'])
                self.assertEqual(self.document()['reference']['at'], delta['reference']['at'])
                workspace.close(str(self.root))

    def test_size_caps_hold_before_and_after_decompression(self):
        self.ws.open(str(self.root))
        self.ws.close(str(self.root))
        with patch.object(readings, 'MAX_STORED', 64):
            self.assertIgnored(Workspace(self.state).open(str(self.root))['delta'], 'ceiling of 32 MiB')
        # A small file that expands far beyond the cap is cut while decompressing, not after.
        self.saved().write_bytes(gzip.compress(b' ' * (64 * 1024 * 1024), compresslevel=9))
        self.assertLess(self.saved().stat().st_size, 1024 * 1024)
        tracemalloc.start()
        try:
            with patch.object(readings, 'MAX_EXPANDED', 1024 * 1024):
                reference, problem = readings.ReferenceStore(self.state).load(str(self.root))
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertIsNone(reference)
        self.assertIn('128 MiB uncompressed', problem)
        self.assertLess(peak, 8 * 1024 * 1024)
        # Above the cap when saving: kept in memory only, with a warning.
        with patch.object(readings, 'MAX_STORED', 64):
            delta = Workspace(self.state).open(str(self.root))['delta']
        self.assertFalse(delta['roots'][0]['referenceSaved'])
        self.assertIn('ceiling of 32 MiB compressed', next(item['message'] for item in delta['warnings'] if item['code'] == 'reference-not-saved'))

    def test_links_fifos_and_hardlinks_in_the_store_are_never_followed(self):
        self.ws.open(str(self.root))
        good = self.saved().read_bytes()
        self.ws.close(str(self.root))
        elsewhere = self.base / 'elsewhere'
        elsewhere.mkdir()
        (elsewhere / 'valid.json.gz').write_bytes(good)
        def symlink():
            self.saved().unlink()
            self.saved().symlink_to(elsewhere / 'valid.json.gz')
        def fifo():
            self.saved().unlink()
            os.mkfifo(self.saved())
        def hardlink():
            self.saved().unlink()
            os.link(elsewhere / 'valid.json.gz', self.saved())
        for label, prepare, fragment in (('symlink', symlink, 'symbolic link'), ('fifo', fifo, 'is not an ordinary file'),
                                         ('hardlink', hardlink, 'hard link')):
            with self.subTest(case=label):
                prepare()
                workspace = Workspace(self.state)
                delta = workspace.open(str(self.root))['delta']
                self.assertIgnored(delta, fragment)
                # The new reference replaced the entry itself; the outside file is untouched.
                self.assertTrue(self.saved().is_file() and not self.saved().is_symlink())
                self.assertEqual((elsewhere / 'valid.json.gz').read_bytes(), good)
                workspace.close(str(self.root))
        # A directory in place of the file: ignored, and the new reference cannot be saved there.
        self.saved().unlink()
        self.saved().mkdir()
        delta = Workspace(self.state).open(str(self.root))['delta']
        self.assertIgnored(delta, 'is not an ordinary file')
        self.assertFalse(delta['roots'][0]['referenceSaved'])
        self.assertEqual([item['code'] for item in delta['warnings']], ['reference-ignored', 'reference-not-saved'])

    def test_linked_store_directory_is_neither_read_nor_written(self):
        self.ws.open(str(self.root))
        self.ws.close(str(self.root))
        outside = self.base / 'outside-store'
        (self.state / 'references').rename(outside)
        (self.state / 'references').symlink_to(outside, target_is_directory=True)
        before = {path.name: path.read_bytes() for path in outside.iterdir()}
        delta = Workspace(self.state).open(str(self.root))['delta']
        self.assertIgnored(delta, 'is not an ordinary directory')
        self.assertFalse(delta['roots'][0]['referenceSaved'])
        self.assertEqual({path.name: path.read_bytes() for path in outside.iterdir()}, before)

    def test_write_failure_keeps_the_reference_in_memory_with_a_warning(self):
        with patch('delta.os.write', side_effect=OSError(28, 'No space left on device')):
            delta = self.ws.open(str(self.root))['delta']
        self.assertFalse(delta['roots'][0]['referenceSaved'])
        warning = next(item for item in delta['warnings'] if item['code'] == 'reference-not-saved')
        self.assertIn('disk full', warning['message'])
        self.assertIn('only until the server restarts', warning['message'])
        self.assertEqual(portuguese(warning['message']), f'Referência não salva no diretório de estado do aplicativo ({self.state}): '
                                                         'falha de gravação (disco cheio). Ela vale só até reiniciar o servidor.')
        self.assertFalse(self.saved().exists())
        self.assertEqual(list((self.state / 'references').iterdir()), [])  # no temporary left behind
        # The reading keeps working against the in-memory reference; the warning stays with it.
        self.edit('[Obsoleto](obsoleto/ausente.md)', '')
        again = self.ws.refresh()['delta']
        self.assertEqual(again['relations']['totals'], {'added': 0, 'removed': 1})
        self.assertEqual(again['warnings'], delta['warnings'])
        # Adopting tries again and, once it works, the warning is gone.
        adopted = self.ws.adopt_reference()['delta']
        self.assertEqual((adopted['warnings'], adopted['roots'][0]['referenceSaved']), ([], True))

    def state_file(self):
        return json.loads((self.state / 'workspace.json').read_text(encoding='utf-8'))

    def refuse_update(self, workspace):
        """Adopt a changed reading while the store cannot write: the update is refused, the earlier file stays."""
        self.edit('[Obsoleto](obsoleto/ausente.md)', '')
        workspace.refresh()
        with patch('delta.os.write', side_effect=OSError(28, 'No space left on device')):
            return workspace.adopt_reference()['delta']

    def test_a_refused_update_is_still_said_after_a_restart_until_a_reference_is_saved(self):
        self.ws.open(str(self.root))
        good = self.saved().read_bytes()
        refused = self.refuse_update(self.ws)
        warning = next(item for item in refused['warnings'] if item['code'] == 'reference-not-saved')
        self.assertIn('disk full', warning['message'])
        self.assertIn('Afterwards, the comparison goes back to the baseline saved before, with a warning.', warning['message'])
        self.assertTrue(portuguese(warning['message']).endswith('falha de gravação (disco cheio). Ela vale só até reiniciar o servidor. '
                                                                'Depois, a comparação volta à referência salva antes, com um aviso.'))
        self.assertEqual(self.saved().read_bytes(), good)
        refusal = self.state_file()['referenceRefusals'][str(self.root)]
        self.assertEqual(refusal['file'], hashlib.sha256(good).hexdigest())
        # The reason is kept as the sentence and as its phrase, so the warning of a restart is worded in any language.
        self.assertEqual((refusal['reason'], refusal['phrase']),
                         ('write failure (disk full)', {'phrase': 'write failure ({cause})', 'params': {'cause': {'phrase': 'disk full'}}}))
        # After a restart the earlier saved reference is back, and it says why.
        for _ in range(2):
            delta = Workspace(self.state).snapshot()['delta']
            self.assertEqual((delta['roots'][0]['referenceOrigin'], delta['relations']['totals']), ('persisted', {'added': 0, 'removed': 1}))
            self.assertEqual([item['code'] for item in delta['warnings']], ['reference-update-not-saved'])
            self.assertIn('disk full', delta['warnings'][0]['message'])
            self.assertEqual(portuguese(delta['warnings'][0]['message']),
                             f'A última atualização desta referência não foi salva no diretório de estado do aplicativo ({self.state}): '
                             'falha de gravação (disco cheio). A comparação usa a referência salva antes dela; este aviso sai quando uma nova referência for salva.')
        # Closing and reopening keeps it; a reference saved at last clears it, also after a restart.
        workspace = Workspace(self.state)
        workspace.close(str(self.root))
        self.assertEqual([item['code'] for item in workspace.open(str(self.root))['delta']['warnings']], ['reference-update-not-saved'])
        adopted = workspace.adopt_reference()['delta']
        self.assertEqual((adopted['warnings'], adopted['roots'][0]['referenceSaved']), ([], True))
        self.assertNotIn('referenceRefusals', self.state_file())
        self.assertEqual(Workspace(self.state).snapshot()['delta']['warnings'], [])
        # Forgetting the case erases its refusal with its reference.
        with patch('delta.os.write', side_effect=OSError(28, 'No space left on device')):
            workspace.adopt_reference()
        self.assertIn(str(self.root), self.state_file()['referenceRefusals'])
        workspace.close(str(self.root))
        workspace.forget(str(self.root))
        self.assertNotIn('referenceRefusals', self.state_file())

    def test_a_refusal_in_the_same_second_as_the_saved_reading_is_still_said(self):
        # Reading times have one-second resolution: every reading of this test has the same time.
        with patch.object(readings, 'now', lambda: '2026-10-01T18:00:00-03:00'):
            workspace = Workspace(self.state)
            workspace.open(str(self.root))
            self.refuse_update(workspace)
            delta = Workspace(self.state).snapshot()['delta']
        self.assertEqual([item['code'] for item in delta['warnings']], ['reference-update-not-saved'])

    @unittest.skipIf(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root ignores directory permissions')
    def test_a_saved_retry_whose_refusal_cannot_be_cleared_brings_no_warning_back(self):
        # Real permissions: the store refuses the update, then the retry of the same reading is saved while the
        # state directory refuses the write that clears the refusal.
        self.ws.open(str(self.root))
        self.edit('[Obsoleto](obsoleto/ausente.md)', '')
        self.ws.refresh()
        store = self.state / 'references'
        self.addCleanup(store.chmod, 0o700)
        self.addCleanup(self.state.chmod, 0o700)
        store.chmod(0o500)
        refused = self.ws.adopt_reference()['delta']
        self.assertIn('no permission', next(item['message'] for item in refused['warnings'] if item['code'] == 'reference-not-saved'))
        self.assertIn(str(self.root), self.state_file()['referenceRefusals'])
        store.chmod(0o700)
        self.state.chmod(0o500)
        retry = self.ws.adopt_reference()['delta']
        self.assertEqual((retry['warnings'], retry['roots'][0]['referenceSaved']), ([], True))
        self.state.chmod(0o700)
        self.assertIn(str(self.root), self.state_file()['referenceRefusals'])  # left over, naming the replaced file
        delta = Workspace(self.state).snapshot()['delta']
        self.assertEqual(delta['warnings'], [])
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})

    def test_a_refusal_that_cannot_be_kept_in_the_state_says_so(self):
        self.ws.open(str(self.root))
        self.edit('[Obsoleto](obsoleto/ausente.md)', '')
        self.ws.refresh()
        with patch('delta.os.write', side_effect=OSError(28, 'No space left on device')), \
                patch.object(Workspace, 'save', side_effect=OSError(28, 'No space left on device')):
            refused = self.ws.adopt_reference()['delta']
        message = next(item['message'] for item in refused['warnings'] if item['code'] == 'reference-not-saved')
        self.assertIn('goes back to the baseline saved before, without a warning', message)
        self.assertEqual(Workspace(self.state).snapshot()['delta']['warnings'], [])

    def test_a_refusal_promises_no_return_when_the_saved_file_is_invalid(self):
        self.ws.open(str(self.root))
        self.saved().write_bytes(b'corrompido')
        refused = self.refuse_update(self.ws)
        message = next(item['message'] for item in refused['warnings'] if item['code'] == 'reference-not-saved')
        self.assertTrue(message.endswith('It holds only until the server restarts.'), message)
        self.assertNotIn('referenceRefusals', self.state_file())
        delta = Workspace(self.state).snapshot()['delta']
        self.assertEqual(delta['roots'][0]['referenceOrigin'], 'first-reading')
        self.assertEqual([item['code'] for item in delta['warnings']], ['reference-ignored'])

    @unittest.skipIf(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root ignores directory permissions')
    def test_starting_with_a_reference_that_cannot_be_saved_does_not_rewrite_the_state(self):
        other = self.base / 'outro'
        other.mkdir()
        (other / 'AGENTS.md').write_text('# Outro\n', encoding='utf-8')
        self.ws.open(str(self.root))
        self.ws.open(str(other))
        written = (self.state / 'workspace.json').read_bytes()
        # The other project is away (an unmounted disk) and no reference of this one can be saved at start.
        other.rename(self.base / 'outro-fora')
        self.saved().unlink()
        store = self.state / 'references'
        self.addCleanup(store.chmod, 0o700)
        store.chmod(0o500)
        started = Workspace(self.state)
        self.assertFalse(started.snapshot()['delta']['roots'][0]['referenceSaved'])
        self.assertEqual((self.state / 'workspace.json').read_bytes(), written)
        store.chmod(0o700)
        (self.base / 'outro-fora').rename(other)
        self.assertEqual([item['path'] for item in Workspace(self.state).model['roots']], [str(self.root), str(other)])

    def test_a_stale_or_invalid_refusal_in_the_state_is_not_shown(self):
        self.ws.open(str(self.root))
        state = self.state_file()
        for label, refusals in (('another saved file', {str(self.root): {'reason': 'disco cheio', 'file': '0' * 64}}),
                                ('time instead of file', {str(self.root): {'reason': 'disco cheio', 'at': '2099-01-01T00:00:00-03:00'}}),
                                ('invalid entry', {str(self.root): {'reason': 3, 'file': 'x'}}), ('invalid field', ['x'])):
            with self.subTest(case=label):
                (self.state / 'workspace.json').write_text(json.dumps({**state, 'referenceRefusals': refusals}), encoding='utf-8')
                workspace = Workspace(self.state)
                self.assertEqual(workspace.snapshot()['delta']['warnings'], [])
                self.assertEqual(workspace.restore_errors, [])

    @unittest.skipIf(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root ignores directory permissions')
    def test_unwritable_store_directory_keeps_the_reference_in_memory(self):
        store = self.state / 'references'
        store.mkdir(mode=0o700)
        store.chmod(0o500)
        self.addCleanup(store.chmod, 0o700)
        delta = self.ws.open(str(self.root))['delta']
        self.assertFalse(delta['roots'][0]['referenceSaved'])
        self.assertIn('no permission', next(item['message'] for item in delta['warnings'] if item['code'] == 'reference-not-saved'))
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})
        self.assertEqual(Workspace(self.state).snapshot()['delta']['roots'][0]['referenceOrigin'], 'first-reading')

    def test_state_directory_inside_an_opened_root_is_not_written(self):
        workspace = Workspace(self.root / '.aae-state')
        delta = workspace.open(str(self.root))['delta']
        self.assertFalse(delta['roots'][0]['referenceSaved'])
        self.assertIn('inside an open folder', next(item['message'] for item in delta['warnings'] if item['code'] == 'reference-not-saved'))
        self.assertFalse((self.root / '.aae-state' / 'references').exists())

    def test_protected_location_is_still_refused_for_the_state(self):
        protected = self.base / 'protected'
        protected.mkdir()
        with patch.dict(os.environ, {'AAE_PROTECTED_PATHS': str(protected)}):
            with self.assertRaises(ValueError):
                Workspace(protected / 'state')
        self.assertEqual(list(protected.iterdir()), [])

    def test_a_root_replaced_by_a_link_does_not_load_any_reference(self):
        other = self.base / 'outro'
        other.mkdir()
        (other / 'AGENTS.md').write_text('# Outro\n', encoding='utf-8')
        self.ws.open(str(self.root))
        self.root.rename(self.base / 'atlas-movido')
        self.root.symlink_to(other, target_is_directory=True)
        # The case open at shutdown is not restored through the link, so no reference is loaded for it.
        restarted = Workspace(self.state)
        self.assertIsNone(restarted.snapshot()['delta'])
        self.assertTrue(restarted.snapshot()['restoreErrors'])
        # Opening the link resolves to the other directory, with a reference of its own.
        delta = restarted.open(str(self.root))['delta']
        self.assertEqual([item['path'] for item in delta['roots']], [str(other)])
        self.assertEqual((delta['roots'][0]['referenceOrigin'], delta['warnings']), ('first-reading', []))
        self.assertTrue(self.saved(other).is_file())
        self.assertTrue(self.saved().is_file())  # the reference of the original path is kept for its case


# Targets that POSIX normpath leaves with two leading slashes: a bare `//`, a network-style path, a protocol-relative URL.
DOUBLE_SLASH = '# Entrada\nUse `//` como separador.\nVeja `//servidor/pasta/arquivo.md`.\n[x](//cdn.exemplo/lib.js)\n'
ODD_TARGETS = [
    '[a](docs//dupla//barra.md)', '[b](./docs/./x.md)', '[c](../fora/x.md)', '[d](<docs/com espaço.md>)', '[e](docs/ação/ünï.md)',
    '[f](/etc/fora-da-raiz.md)', '[g](..../x.md)', '[h](file:///etc/x.md)', '[i](file://servidor/x.md)', '[j](docs/x.md#ancora)',
    '[k](docs/x.md:12)', '[l](docs/x.md#L12)', '`//`', '`///tres`', '`////quatro`', '`//servidor/pasta/a.md`', '[m](//cdn/x.js)',
    '[n](/)', '[o](//)', '[p](.)', '[q](..)', '[r](docs/../../..//x)', '`' + '../' * 40 + 'x.md`', '`docs/x.md:3`', '[s](docs/...)',
    '[t](docs/)', '[u](...)', '`/../x.md`', '`//../x.md`', '`//./x.md`', '@//arroba.md', '[[//wiki]]', '`.//x.md`',
    '[v](docs/x.md?q=1)', '[w](docs/%20x.md)', '[y](docs/x.md "título")', '`docs//x.md#L3`',
]


def scanner_findings(model):
    return readings.audit_report.audit(model)['findings']


class SavedReferenceRoundTripTests(unittest.TestCase):
    """Paths outside the root written with two leading slashes are stored with one, so these saved references load
    and show no change against the same reading."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-reference-roundtrip-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)

    def tree(self, name, files):
        root = self.base / name
        for relative, text in files.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
        return root

    def assertRoundTrip(self, roots):
        model = scanner.scan([str(root) for root in roots])
        current = readings.read(model, readings.now())
        state = Path(tempfile.mkdtemp(prefix='state-', dir=self.base))
        store = readings.ReferenceStore(state)
        for root, compact in current.items():
            with self.subTest(root=Path(root).name):
                self.assertIsNone(store.save(root, compact))
                loaded, problem = store.load(root)
                self.assertIsNone(problem)
                delta = readings.compare({root: loaded}, {root: compact}, model)
                self.assertEqual(delta['files']['totals'], {'added': 0, 'removed': 0, 'changed': 0})
                self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})
                # compare-audit is inconclusive, not failing, when the reading itself is partial or inconclusive.
                incomplete = compact['audit']['partial'] or compact['audit']['status'] == 'inconclusive'
                self.assertEqual((delta['findings']['totals'], delta['findings']['status']),
                                 ({'new': 0, 'resolved': 0}, 'inconclusive' if incomplete else 'pass'))
        return model, current

    def test_double_slash_targets_survive_a_restart(self):
        root = self.tree('barras', {'AGENTS.md': DOUBLE_SLASH})
        model, current = self.assertRoundTrip([root])
        targets = {edge['raw']: edge['target'] for edge in model['edges']}
        # The reader keeps its target as written (normpath); only the compact reference is canonical.
        self.assertEqual(targets['//'], '//')
        self.assertEqual(targets['//servidor/pasta/arquivo.md'], '//servidor/pasta/arquivo.md')
        stored = {item['raw']: item['target'] for item in current[str(root)]['relations']}
        self.assertEqual((stored['//'], stored['//servidor/pasta/arquivo.md']), ('/', '/servidor/pasta/arquivo.md'))
        # As the app does it: the next server process compares with the saved reference.
        state = self.base / 'state'
        Workspace(state).open(str(root))
        delta = Workspace(state).open(str(root))['delta']
        self.assertEqual((delta['roots'][0]['referenceOrigin'], delta['warnings']), ('persisted', []))
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})

    def test_double_slash_manifest_source_round_trips(self):
        manifest = {'objects': [], 'relationships': [{'source': '//fora/origem.md', 'target': 'AGENTS.md'}]}
        root = self.tree('manifesto', {'AGENTS.md': '# Entrada\n', 'agent-architecture.json': json.dumps(manifest)})
        model, current = self.assertRoundTrip([root])
        self.assertIn('//fora/origem.md', {edge['source'] for edge in model['edges']})
        self.assertIn('/fora/origem.md', {item['source'] for item in current[str(root)]['relations']})

    def test_audit_lab_roots_round_trip(self):
        lab = create_lab(self.base / 'lab')
        roots = sorted(path for path in lab.iterdir() if path.is_dir())
        self.assertGreater(len(roots), 1)
        self.assertRoundTrip(roots)
        for root in roots:
            self.assertRoundTrip([root])

    def test_odd_targets_in_volume_round_trip(self):
        files = {'docs/x.md': '# x\n', 'docs/com espaço.md': '# e\n', 'docs/ação/ünï.md': '# u\n', 'docs/...': 'pontos\n', '...': 'pontos\n'}
        text = '# Entrada\n' + '\n'.join(ODD_TARGETS * 3) + '\n'
        root = self.tree('esquisitos', {**files, 'AGENTS.md': text, 'docs/x.md': '# x\n' + '\n'.join(ODD_TARGETS) + '\n'})
        nested = self.tree('esquisitos/docs', {})
        model, current = self.assertRoundTrip([root, nested])
        self.assertTrue(any(edge['target'].startswith('//') for edge in model['edges']))
        self.assertGreater(len(current[str(root)]['relations']), len(ODD_TARGETS))

    def test_nul_in_written_text_round_trips_as_a_visible_marker(self):
        # A NUL written in a reference stays in `raw` of a relation and in `target` and `message` of a finding.
        manifest = {'objects': [], 'relationships': [{'source': 'AGENTS.md', 'target': 'guia.md', 'type': 'usa\u0000'},
                                                     {'source': 'AGENTS.md', 'target': 'b\u0000.md'}]}
        text = '# Entrada\n[x](a\x00b.md)\n[Guia](guia.md#a\x00b)\n`docs/\x00.md`\n'
        root = self.tree('nulo', {'AGENTS.md': text, 'guia.md': '# Guia\n', 'agent-architecture.json': json.dumps(manifest)})
        model, current = self.assertRoundTrip([root])
        self.assertTrue(any('\x00' in edge['raw'] for edge in model['edges']))
        compact = current[str(root)]
        self.assertNotIn('\\u0000', json.dumps(compact))
        self.assertIn('guia.md#a␀b', {item['raw'] for item in compact['relations']})
        self.assertIn('usa␀', {item['raw'] for item in compact['relations']})
        self.assertTrue({'a␀b.md', 'b␀.md'} <= {item.get('target') for item in compact['audit']['findings']})
        # The reader and the CLI keep the text as written; only the compact reading carries the marker.
        self.assertTrue(any('\x00' in str(item.get('target')) for item in scanner_findings(model)))

    def test_nul_marker_never_merges_two_written_texts(self):
        # A real ␀ written in a document and a NUL are different texts: turning one into the other is a change, also
        # next to the escape mark (`c␀d` against `c␛<NUL>d`) and in the type of a manifest relationship.
        manifest = lambda kind: json.dumps({'objects': [], 'relationships': [{'source': 'AGENTS.md', 'target': 'guia.md', 'type': kind}]})
        root = self.tree('injetiva', {'guia.md': '# Guia\n', 'AGENTS.md': '# E\n[Guia](guia.md#a␀b)\n[Esc](guia.md#c␀d)\n',
                                      'agent-architecture.json': manifest('usa␀')})
        _, before = self.assertRoundTrip([root])
        reference = before[str(root)]
        (root / 'AGENTS.md').write_text('# E\n[Guia](guia.md#a\x00b)\n[Esc](guia.md#c␛\x00d)\n', encoding='utf-8')
        (root / 'agent-architecture.json').write_text(manifest('usa\u0000'), encoding='utf-8')
        model = scanner.scan([str(root)])
        current = readings.read(model, readings.now())
        state = self.base / 'state-injetiva'
        state.mkdir()
        store = readings.ReferenceStore(state)
        self.assertIsNone(store.save(str(root), reference))
        loaded, problem = store.load(str(root))
        self.assertIsNone(problem)
        for label, side in (('memória', reference), ('disco', loaded)):
            with self.subTest(reference=label):
                delta = readings.compare({str(root): side}, current, model)
                self.assertEqual(delta['relations']['totals'], {'added': 3, 'removed': 3})
                # The delta shows each text as written: the NUL as in the model, the real ␀ as it was.
                self.assertEqual(sorted(item['raw'] for item in delta['relations']['added']),
                                 ['guia.md#a\x00b', 'guia.md#c␛\x00d', 'usa\x00'])
                self.assertEqual(sorted(item['raw'] for item in delta['relations']['removed']), ['guia.md#a␀b', 'guia.md#c␀d', 'usa␀'])

    def test_new_finding_with_a_nul_is_found_in_the_model(self):
        # The panel finds the model observation of a delta finding by (code, node, line, target): the same text on both sides.
        root = self.tree('marca', {'AGENTS.md': '# E\n[g](guia.md)\n', 'guia.md': '# G\n'})
        reference = readings.read(scanner.scan([str(root)]), readings.now())[str(root)]
        state = self.base / 'state-marca'
        state.mkdir()
        store = readings.ReferenceStore(state)
        self.assertIsNone(store.save(str(root), reference))
        (root / 'AGENTS.md').write_text('# E\n[g](guia.md)\n[x](a\x00b.md)\n`docs/\x00.md`\n', encoding='utf-8')
        model = scanner.scan([str(root)])
        current = readings.read(model, readings.now())
        issues = {(item['code'], item['node'], item.get('line'), item.get('target')) for item in model['issues']}
        for label, side in (('memória', reference), ('disco', store.load(str(root))[0])):
            with self.subTest(reference=label):
                new = [item for item in readings.compare({str(root): side}, current, model)['findings']['new'] if '\x00' in str(item.get('target'))]
                self.assertEqual(len(new), 2)
                self.assertTrue(all((item['code'], item['node'], item.get('line'), item.get('target')) in issues for item in new))

    def test_names_ending_in_a_line_break_round_trip(self):
        # A target written with an encoded line break, and files whose names end in one (a bare one, '.\n', '..\n').
        files = {'AGENTS.md': '# Entrada\n[x](docs/%0A)\n[y](docs/a%0A)\n[z](%2E%2E%0A)\n', 'docs/x.md': '# x\n',
                 '\n': 'quebra\n', '.\n': 'ponto\n', '..\n': 'pontos\n', 'docs/a\n': 'a\n'}
        root = self.tree('quebras', files)
        model, current = self.assertRoundTrip([root])
        compact = current[str(root)]
        self.assertTrue({'\n', '.\n', '..\n', 'docs/a\n'} <= set(compact['files']))
        self.assertIn('docs/\n', {item['target'] for item in compact['relations']})

    def test_findings_above_the_cap_are_kept_up_to_it_and_left_uncompared(self):
        broken = ''.join(f'[q{index}](ausente-{index}.md)\n' for index in range(8))
        root = self.tree('teto', {'AGENTS.md': '# Entrada\n' + broken})
        state = self.base / 'state-teto'
        with patch.object(readings.audit_report, 'MAX_IMPORTED_FINDINGS', 5):
            model = scanner.scan([str(root)])
            total = len(readings.audit_report.audit(model)['findings'])
            self.assertGreater(total, 5)
            compact = readings.read(model, readings.now())[str(root)]
            self.assertEqual((len(compact['audit']['findings']), compact['audit']['omitted']), (5, total - 5))
            self.assertRoundTrip([root])
            Workspace(state).open(str(root))
            # One broken link more and one less, among the first findings: neither is affirmed new or resolved.
            text = (root / 'AGENTS.md').read_text(encoding='utf-8')
            (root / 'AGENTS.md').write_text(text.replace('[q0](ausente-0.md)\n', '[n](nova-ausente.md)\n'), encoding='utf-8')
            delta = Workspace(state).open(str(root))['delta']
            unlimited = readings.compare({str(root): compact}, readings.read(scanner.scan([str(root)]), readings.now()), model)
        self.assertEqual((delta['roots'][0]['referenceOrigin'], delta['warnings']), ('persisted', []))
        findings = delta['findings']
        self.assertNotIn('error', findings)
        self.assertEqual(findings['totals'], {'new': 0, 'resolved': 0})
        self.assertEqual(findings['uncompared'], 2)
        self.assertEqual((unlimited['findings']['totals'], unlimited['findings']['uncompared']), ({'new': 0, 'resolved': 0}, 2))
        self.assertEqual(delta['relations']['totals'], {'added': 1, 'removed': 1})
        note = next(item for item in findings['context'] if item['code'] == 'findings-truncated')
        self.assertEqual((note['root'], note['sides']), (str(root), ['before', 'after']))
        self.assertIn('only the first 5', note['message'])
        self.assertIn('só as 5 primeiras', portuguese(note['message']))
        # Under the cap nothing is marked: the same tree with the real cap.
        reading = readings.read(scanner.scan([str(root)]), readings.now())[str(root)]
        self.assertNotIn('omitted', reading['audit'])
        self.assertNotIn('findings-truncated', [item['code'] for item in readings.compare({str(root): reading}, {str(root): reading}, model)['findings']['context']])

    def test_save_never_writes_a_reference_that_would_not_load(self):
        root = self.tree('guarda', {'AGENTS.md': '# Entrada\n[Guia](guia.md)\n', 'guia.md': '# Guia\n'})
        compact = readings.read(scanner.scan([str(root)]), readings.now())[str(root)]
        state = self.base / 'state-guarda'
        state.mkdir()
        store = readings.ReferenceStore(state)
        self.assertIsNone(store.save(str(root), compact))
        saved = state / 'references' / readings.ReferenceStore.name(str(root))
        good = saved.read_bytes()
        relation = compact['relations'][0]
        for label, broken in (('caminho', {**compact, 'relations': [{**relation, 'target': '../x'}]}),
                              ('nulo', {**compact, 'relations': [{**relation, 'raw': 'a\x00b'}]}),
                              ('tipo', {**compact, 'relations': [{**relation, 'line': '3'}]}),
                              ('nan', {**compact, 'audit': {**compact['audit'], 'findings': [{'id': '0' * 16, 'code': 'x', 'severity': 'warning',
                                                                                              'message': 'm', 'n': float('nan')}]}})):
            with self.subTest(case=label):
                problem = store.save(str(root), broken)
                self.assertIsNotNone(problem)
                self.assertIn('would not pass validation', problem)
                self.assertEqual(saved.read_bytes(), good)  # the previous file is kept as it was
                self.assertEqual([path.name for path in saved.parent.iterdir()], [saved.name])  # no temporary left behind
        # Through the app: kept in memory only, with the reason in the warning.
        other = self.base / 'state-guarda-app'
        with patch.object(readings, '_visible', lambda value: value):
            nul = self.tree('guarda-nulo', {'AGENTS.md': '# Entrada\n[Guia](guia.md#a\x00b)\n', 'guia.md': '# Guia\n'})
            delta = Workspace(other).open(str(nul))['delta']
        self.assertFalse(delta['roots'][0]['referenceSaved'])
        self.assertIn('would not pass validation', next(item['message'] for item in delta['warnings'] if item['code'] == 'reference-not-saved'))
        self.assertFalse((other / 'references' / readings.ReferenceStore.name(str(nul))).exists())
        # The guard checks the reference already in memory: the serialized text is not parsed back.
        with patch.object(readings.json, 'loads', side_effect=AssertionError('reparsed')):
            self.assertIsNone(store.save(str(root), compact))

    def test_tampered_paths_are_still_refused(self):
        root = self.tree('adulterado', {'AGENTS.md': '# Entrada\n[Guia](guia.md)\n', 'guia.md': '# Guia\n'})
        model = scanner.scan([str(root)])
        compact = readings.read(model, readings.now())[str(root)]
        state = self.base / 'state-adulterado'
        state.mkdir()
        store = readings.ReferenceStore(state)
        self.assertIsNone(store.save(str(root), compact))
        saved = state / 'references' / readings.ReferenceStore.name(str(root))
        document = json.loads(gzip.decompress(saved.read_bytes()))
        relation = document['reference']['relations'][0]
        # '//x' is also what a reference saved before the canonical form holds: still refused, never loosened.
        # A final line break does not hide an empty, '.' or '..' segment before it.
        for target in ('//x', '//', '/a//b', '///x', '../x', 'a/../b', 'a/./b', 'a\x00b', '/a\x00b', 5, None, ['a'],
                       '', '../x\n', 'a/./b\n', 'a//b\n', '/a//b\n', 'a/\n/../b', '\n/../x'):
            with self.subTest(target=target):
                tampered = {**document, 'reference': {**document['reference'], 'relations': [{**relation, 'target': target}]}}
                saved.write_bytes(gzip.compress(json.dumps(tampered).encode()))
                self.assertEqual(store.load(str(root)), (None, readings.INVALID))
        # The mark of findings left out above the cap: a positive count, or absent.
        audit = document['reference']['audit']
        for omitted in (0, -1, '3', True, 1.5, None, [1]):
            with self.subTest(omitted=omitted):
                tampered = {**document, 'reference': {**document['reference'], 'audit': {**audit, 'omitted': omitted}}}
                saved.write_bytes(gzip.compress(json.dumps(tampered).encode()))
                self.assertEqual(store.load(str(root)), (None, readings.INVALID))
        # Only a full list has findings left out: a mark next to fewer findings than the cap would silence the new ones.
        tampered = {**document, 'reference': {**document['reference'], 'audit': {**audit, 'omitted': 1}}}
        saved.write_bytes(gzip.compress(json.dumps(tampered).encode()))
        self.assertEqual(store.load(str(root)), (None, readings.INVALID))
        tampered = {**document, 'reference': {**document['reference'], 'audit': {**audit, 'omitted': 3}}}
        saved.write_bytes(gzip.compress(json.dumps(tampered).encode()))
        with patch.object(readings.audit_report, 'MAX_IMPORTED_FINDINGS', len(audit['findings'])):
            self.assertEqual(store.load(str(root))[0]['audit']['omitted'], 3)
        # A reference without the mark, as every one saved before it, loads without it.
        saved.write_bytes(gzip.compress(json.dumps(document).encode()))
        self.assertNotIn('omitted', store.load(str(root))[0]['audit'])


class SavedReferenceHttpTests(unittest.TestCase):
    def test_api_after_restart_shows_the_saved_reference_and_its_origin(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-saved-reference-http-')
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        root = base / 'pacote'
        root.mkdir()
        (root / 'AGENTS.md').write_text('# Pacote\n[Guia](guia.md)\n', encoding='utf-8')
        (root / 'guia.md').write_text('# Guia\n', encoding='utf-8')
        static = base / 'static'
        static.mkdir()
        (static / 'index.html').write_text('<title>referência</title>')
        clock_patch = patch.object(readings, 'now', clock())
        clock_patch.start()
        self.addCleanup(clock_patch.stop)
        at = Workspace(base / 'state').open(str(root))['delta']['reference']['at']
        (root / 'AGENTS.md').write_text('# Pacote\n[Guia](guia.md)\n[Novo](novo.md)\n', encoding='utf-8')
        handler = make_handler(Workspace(base / 'state'), static, 'saved-reference-token')
        handler.log_message = lambda *args: None
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
        connection.request('GET', '/api/workspace', headers={'Host': f'127.0.0.1:{server.server_port}', 'X-AAE-Token': 'saved-reference-token'})
        response = connection.getresponse()
        delta = json.loads(response.read())['delta']
        connection.close()
        self.assertEqual(response.status, 200)
        self.assertEqual((delta['reference']['at'], delta['roots'][0]['referenceOrigin'], delta['roots'][0]['referenceSaved']), (at, 'persisted', True))
        self.assertEqual((delta['warnings'], delta['relations']['totals']), ([], {'added': 1, 'removed': 0}))


if __name__ == '__main__':
    unittest.main()
