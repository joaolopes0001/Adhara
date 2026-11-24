"""Order of the open projects: validation, persistence, preservation and HTTP."""
import json
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


class ReorderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.state = self.folder / 'state'
        self.a, self.b, self.c = (self.project(n) for n in 'abc')
        self.ws = Workspace(self.state)
        for path in (self.a, self.b, self.c):
            self.ws.open(path)

    def project(self, name):
        path = self.folder / name
        path.mkdir()
        (path / 'AGENTS.md').write_text('# Synthetic entry\n', encoding='utf-8')
        return str(path)

    @staticmethod
    def roots(snapshot):
        return [r['path'] for r in snapshot['roots']]

    def test_valid_permutation_changes_model_and_persists_across_restart(self):
        snapshot = self.ws.reorder([self.c, self.a, self.b])
        self.assertEqual(self.roots(snapshot), [self.c, self.a, self.b])
        self.assertEqual(json.loads(self.ws.state_file.read_text())['roots'], [self.c, self.a, self.b])
        self.assertEqual(self.roots(self.ws.snapshot()), [self.c, self.a, self.b])
        self.assertEqual(self.roots(Workspace(self.state).snapshot()), [self.c, self.a, self.b])
        # The saved projects keep the order in which they were opened.
        self.assertEqual([c['path'] for c in snapshot['savedCases']], [self.a, self.b, self.c])
        # The same order a fresh scan would produce.
        self.assertEqual([n['id'] for n in snapshot['nodes']], [n['id'] for n in Workspace(self.state).snapshot()['nodes']])

    def test_identical_order_is_a_noop_without_rescan(self):
        from unittest.mock import patch
        with patch('workspace.scan') as scanner:
            snapshot = self.ws.reorder([self.a, self.b, self.c])
        scanner.assert_not_called()
        self.assertEqual(self.roots(snapshot), [self.a, self.b, self.c])

    def test_invalid_orders_are_refused_without_changing_anything(self):
        outside = self.project('outside')
        before = (self.ws.state_file.read_text(), self.roots(self.ws.snapshot()))
        cases = {
            'ausente': [self.a, self.b],
            'extra': [self.a, self.b, self.c, outside],
            'duplicada': [self.a, self.a, self.b],
            'duplicada completa': [self.a, self.b, self.c, self.a],
            'relativo': [self.a, self.b, 'c'],
            'não aberta': [self.a, self.b, outside],
            'vazia': [],
            'não lista': 'abc',
            'ausente do corpo': None,
            'item não texto': [self.a, self.b, 3],
            'item vazio': [self.a, self.b, ''],
            'nulo': [self.a, self.b, '\x00'],
        }
        for name, order in cases.items():
            with self.subTest(name), self.assertRaises(ValueError) as error:
                self.ws.reorder(order)
            self.assertTrue(str(error.exception))
        self.assertEqual(before, (self.ws.state_file.read_text(), self.roots(self.ws.snapshot())))

    def test_refresh_close_and_open_preserve_chosen_order(self):
        self.ws.reorder([self.b, self.c, self.a])
        self.assertEqual(self.roots(self.ws.refresh()), [self.b, self.c, self.a])
        d = self.project('d')
        self.assertEqual(self.roots(self.ws.open(d)), [self.b, self.c, self.a, d])
        self.assertEqual(self.roots(self.ws.close(self.c)), [self.b, self.a, d])
        self.assertEqual(self.roots(Workspace(self.state).snapshot()), [self.b, self.a, d])

    def test_references_by_root_are_unaffected_and_delta_stays_consistent(self):
        references = {root: ref['origin'] for root, ref in self.ws.references.items()}
        snapshot = self.ws.reorder([self.c, self.b, self.a])
        self.assertEqual({root: ref['origin'] for root, ref in self.ws.references.items()}, references)
        self.assertEqual({r['path'] for r in snapshot['delta']['roots']}, {self.a, self.b, self.c})
        self.assertEqual(snapshot['delta']['files']['totals'], self.ws.delta['files']['totals'])
        self.assertFalse(any(snapshot['delta']['files']['totals'].values()))

    def test_reorder_rereads_disk_like_refresh(self):
        # Reordering rereads the disk, so external edits enter the delta as in a refresh.
        Path(self.a, 'novo.md').write_text('# Novo\n', encoding='utf-8')
        Path(self.b, 'AGENTS.md').write_text('# Synthetic entry, edited\n', encoding='utf-8')
        snapshot = self.ws.reorder([self.b, self.a, self.c])
        totals = snapshot['delta']['files']['totals']
        self.assertEqual((totals['added'], totals['changed'], totals['removed']), (1, 1, 0))
        self.assertEqual(self.ws.refresh()['delta']['files']['totals'], totals)
        self.assertEqual(self.roots(self.ws.snapshot()), [self.b, self.a, self.c])

    def test_unavailable_root_is_reported_but_order_of_the_rest_kept(self):
        import shutil
        shutil.rmtree(self.b)
        snapshot = self.ws.reorder([self.c, self.b, self.a])
        self.assertEqual(self.roots(snapshot), [self.c, self.a])
        self.assertTrue(snapshot['restoreErrors'])

    def test_http_route_guard_and_errors(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.ws, self.folder, 'tok'))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def post(body, token='tok', headers=None):
            req = Request(f'http://127.0.0.1:{server.server_port}/api/reorder', data=json.dumps(body).encode(),
                          headers={'Content-Type': 'application/json', 'X-AAE-Token': token, **(headers or {})})
            with urlopen(req, timeout=5) as response:
                return json.load(response)
        snapshot = post({'order': [self.b, self.a, self.c]})
        self.assertEqual(self.roots(snapshot), [self.b, self.a, self.c])
        for body, token, headers, status in [({'order': [self.a, self.b, self.c]}, 'ruim', None, 403),
                                             ({'order': [self.a, self.b, self.c]}, 'tok', {'Origin': 'http://evil.example'}, 403),
                                             ({'order': [self.a, self.b, self.c]}, 'tok', {'Host': 'evil.example'}, 403),
                                             ({'order': [self.a]}, 'tok', None, 400),
                                             ({}, 'tok', None, 400)]:
            with self.subTest(body=body, token=token, headers=headers), self.assertRaises(HTTPError) as error:
                post(body, token, headers)
            self.assertEqual(error.exception.code, status)
            error.exception.close()
        self.assertEqual(self.roots(self.ws.snapshot()), [self.b, self.a, self.c])


if __name__ == '__main__':
    unittest.main()
