"""Forgetting a project: what it erases from the app state, and the two options of "Forget" in the interface.

Without options, `/api/forget` is what it always was: a closed project leaves the saved list, its Changes baseline,
its marks of "expected" and its editing permission are erased, and its notes stay. `close: true` closes an open
project in the same step; `notes: true` also erases the notes of the project (not those on a file that lies inside
another saved project). Nothing inside the project folder changes in any case.
"""
import hashlib
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from main import make_handler
from workspace import Workspace


def write(root, files):
    for name, text in files.items():
        path = Path(root, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')


def tree(root):
    """Every entry under `root` with its type, mode, size, times and bytes: what must not change."""
    entries = {}
    for folder, dirs, files in os.walk(root):
        for name in dirs + files:
            path = Path(folder, name)
            info = path.lstat()
            entries[str(path.relative_to(root))] = (
                info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino,
                path.read_bytes() if path.is_file() and not path.is_symlink() else None)
    info = Path(root).lstat()
    entries['.'] = (info.st_mode, info.st_mtime_ns, info.st_ctime_ns, info.st_ino)
    return entries


class ForgetProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.state = self.folder / 'state'
        self.loja = str(self.folder / 'loja')
        self.filho = str(self.folder / 'loja' / 'pagamentos')
        self.outro = str(self.folder / 'outro')
        write(self.loja, {'AGENTS.md': '# Loja\n[Guia](docs/guia.md)\n[Falta](docs/falta.md)\n',
                          'docs/guia.md': '# Guia\n',
                          'pagamentos/CLAUDE.md': '# Pagamentos\n[Regras](regras.md)\n',
                          'pagamentos/regras.md': '# Regras\n'})
        write(self.outro, {'AGENTS.md': '# Outro\n[x](sumido.md)\n'})
        self.ws = Workspace(self.state)

    def stored(self):
        return json.loads(self.ws.state_file.read_text(encoding='utf-8'))

    def baseline(self, root):
        return self.state / 'references' / (hashlib.sha256(os.fsencode(root)).hexdigest() + '.json.gz')

    def key(self, root, target):
        return next(issue['key'] for issue in self.ws.snapshot()['issues']
                    if issue['code'] == 'broken' and issue.get('target') == target and issue['node'].startswith(root + '/'))

    def annotate(self):
        """Notes on loja's files, on a file of the nested project, and on another project's file."""
        notes = {f'{self.loja}/AGENTS.md': 'nota da loja', f'{self.loja}/docs/guia.md': 'outra nota da loja',
                 f'{self.filho}/regras.md': 'nota do filho', f'{self.outro}/AGENTS.md': 'nota do outro'}
        for node, body in notes.items():
            self.ws.note(node, body)
        # A note cleared in the interface is an empty text: it is no note and is not counted.
        self.ws.note(f'{self.loja}/docs/falta.md', '')
        return notes

    def case(self, snapshot, path):
        return next(item for item in snapshot['savedCases'] if item['path'] == path)

    def prepare(self):
        """loja open with its nested project, outro open; a mark, a grant and notes on each kind of file."""
        self.ws.open(self.loja)
        self.ws.open(self.filho)
        self.ws.open(self.outro)
        notes = self.annotate()
        self.ws.expect(self.loja, self.key(self.loja, 'docs/falta.md'), True, 'de propósito')
        self.ws.expect(self.outro, self.key(self.outro, 'sumido.md'), True, 'do outro')
        self.ws.enable_editing(self.loja)
        self.ws.enable_editing(self.outro)
        self.assertTrue(self.baseline(self.loja).is_file())
        return notes

    def test_forget_without_options_is_what_it_was_and_keeps_the_notes(self):
        notes = self.prepare()
        before = self.ws.state_file.read_bytes()
        # An open project is refused, and nothing changes.
        with self.assertRaises(ValueError):
            self.ws.forget(self.loja)
        self.assertEqual(self.ws.state_file.read_bytes(), before)
        self.ws.close(self.loja)
        snapshot = self.ws.forget(self.loja)
        state = self.stored()
        self.assertNotIn(self.loja, state['savedCases'])
        self.assertNotIn(self.loja, state['expected'])
        self.assertNotIn(self.loja, state.get('editing', {}))
        self.assertFalse(self.baseline(self.loja).exists())
        # The notes stay, all of them: reopening the same folder shows them again.
        self.assertEqual({key: state['notes'][key] for key in notes}, notes)
        self.assertEqual(self.ws.open(self.loja)['notes'][f'{self.loja}/AGENTS.md'], 'nota da loja')
        # What belongs to the other projects is untouched.
        self.assertIn(self.outro, state['expected'])
        self.assertIn(self.outro, state['editing'])
        self.assertTrue(self.baseline(self.outro).is_file())
        self.assertEqual([root['path'] for root in snapshot['roots']], [self.filho, self.outro])

    def test_saved_cases_count_the_notes_that_forgetting_would_erase(self):
        self.prepare()
        snapshot = self.ws.snapshot()
        # loja: its two notes. The note in the nested project lies inside both saved projects, so forgetting either
        # one keeps it, and neither counts it. The empty one is no note.
        self.assertEqual(self.case(snapshot, self.loja)['notes'], 2)
        self.assertEqual(self.case(snapshot, self.filho)['notes'], 0)
        self.assertEqual(self.case(snapshot, self.outro)['notes'], 1)
        # Once the nested project is no longer saved, its file is loja's alone.
        self.ws.forget(self.filho, close=True)
        self.assertEqual(self.case(self.ws.snapshot(), self.loja)['notes'], 3)

    def test_close_and_notes_take_an_open_project_out_with_its_notes_in_one_step(self):
        notes = self.prepare()
        disk = {root: tree(root) for root in (self.loja, self.outro)}
        snapshot = self.ws.forget(self.loja, notes=True, close=True)
        self.assertEqual([root['path'] for root in snapshot['roots']], [self.filho, self.outro])
        self.assertNotIn(self.loja, [item['path'] for item in snapshot['savedCases']])
        state = self.stored()
        self.assertEqual(state['roots'], [self.filho, self.outro])
        self.assertNotIn(self.loja, state['expected'])
        self.assertNotIn(self.loja, state.get('editing', {}))
        self.assertFalse(self.baseline(self.loja).exists())
        # Erased: loja's own notes (and the empty one). Kept: the nested project's and the other project's.
        self.assertEqual(state['notes'], {f'{self.filho}/regras.md': 'nota do filho',
                                          f'{self.outro}/AGENTS.md': 'nota do outro'})
        self.assertEqual(snapshot['notes'], state['notes'])
        # Nothing inside the folders changed: bytes, modes, times and inodes of every entry.
        self.assertEqual({root: tree(root) for root in (self.loja, self.outro)}, disk)
        # A restart does not bring the project or its notes back.
        restarted = Workspace(self.state).snapshot()
        self.assertEqual([root['path'] for root in restarted['roots']], [self.filho, self.outro])
        self.assertNotIn(self.loja, [item['path'] for item in restarted['savedCases']])
        self.assertNotIn(f'{self.loja}/AGENTS.md', restarted['notes'])
        self.assertIn(f'{self.filho}/regras.md', restarted['notes'])
        self.assertEqual(len(notes), 4)

    def test_closing_with_the_notes_kept_brings_them_back_after_a_restart_and_a_new_add(self):
        self.prepare()
        self.ws.forget(self.loja, close=True)
        restarted = Workspace(self.state)
        self.assertNotIn(self.loja, [root['path'] for root in restarted.snapshot()['roots']])
        self.assertNotIn(self.loja, [item['path'] for item in restarted.snapshot()['savedCases']])
        reopened = restarted.open(self.loja)
        self.assertEqual(reopened['notes'][f'{self.loja}/AGENTS.md'], 'nota da loja')
        self.assertEqual(reopened['notes'][f'{self.loja}/docs/guia.md'], 'outra nota da loja')
        # The mark of "expected" and the baseline did not come back with it.
        self.assertNotIn(self.loja, reopened['expected'])
        self.assertEqual(next(root for root in reopened['delta']['roots'] if root['path'] == self.loja)['referenceOrigin'],
                         'first-reading')

    def test_forgetting_the_nested_project_keeps_every_note_inside_the_parent(self):
        self.prepare()
        snapshot = self.ws.forget(self.filho, notes=True, close=True)
        # The nested project's file is also inside loja, a saved project: its note stays and was not counted.
        self.assertEqual(snapshot['notes'][f'{self.filho}/regras.md'], 'nota do filho')
        self.assertEqual([root['path'] for root in snapshot['roots']], [self.loja, self.outro])

    def test_forgetting_the_parent_keeps_the_nested_project_open_with_its_notes(self):
        self.prepare()
        snapshot = self.ws.forget(self.loja, notes=True, close=True)
        self.assertIn(self.filho, [root['path'] for root in snapshot['roots']])
        self.assertIn(self.filho, [item['path'] for item in snapshot['savedCases']])
        self.assertEqual(snapshot['notes'][f'{self.filho}/regras.md'], 'nota do filho')

    def test_options_must_be_booleans_and_a_refusal_changes_nothing(self):
        self.prepare()
        before = self.ws.state_file.read_bytes(), self.ws.snapshot()
        for options in [{'notes': 'true'}, {'notes': 1}, {'close': 'false'}, {'close': None}, {'notes': []}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.ws.forget(self.loja, **options)
            self.assertEqual((self.ws.state_file.read_bytes(), self.ws.snapshot()), before)

    def test_the_route_takes_the_options_and_keeps_its_old_answer_without_them(self):
        self.prepare()
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.ws, self.folder, 'test-token'))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            def request(body):
                req = Request(f'http://127.0.0.1:{server.server_port}/api/forget', data=json.dumps(body).encode(),
                              headers={'Content-Type': 'application/json', 'X-AAE-Token': 'test-token'})
                with urlopen(req, timeout=5) as response:
                    return json.load(response)
            for body in [{'path': self.loja}, {'path': self.loja, 'close': 'true'}, {'path': self.loja, 'notes': 0}]:
                with self.subTest(body=body), self.assertRaises(HTTPError) as error:
                    request(body)
                self.assertEqual(error.exception.code, 400)
                self.assertIn('error', json.load(error.exception))
                error.exception.close()
            snapshot = request({'path': self.outro, 'close': True, 'notes': False})
            self.assertEqual(snapshot['notes'][f'{self.outro}/AGENTS.md'], 'nota do outro')
            snapshot = request({'path': self.loja, 'close': True, 'notes': True})
            self.assertNotIn(f'{self.loja}/AGENTS.md', snapshot['notes'])
            self.assertEqual([root['path'] for root in snapshot['roots']], [self.filho])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
