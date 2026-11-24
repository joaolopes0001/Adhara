"""Saved cases remain app-owned metadata when their roots are closed."""
import json
import io
import os
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from main import make_handler
from scanner import scan
from workspace import Workspace, blueprint, create_directory


class SavedCasesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.state = self.folder / 'state'
        self.first = self.project('first')
        self.second = self.project('second')
        self.ws = Workspace(self.state)

    def project(self, name):
        path = self.folder / name
        path.mkdir(parents=True)
        (path / 'AGENTS.md').write_text('# Synthetic entry\n', encoding='utf-8')
        return str(path)

    def paths(self, snapshot, field):
        return [root['path'] for root in snapshot[field]]

    def test_close_restart_reopen_preserves_saved_case_and_notes_without_writes(self):
        entry = Path(self.first) / 'AGENTS.md'
        before = entry.stat().st_mtime_ns, entry.read_bytes()
        self.ws.open(self.first)
        self.ws.note(str(entry), 'Comentário persistente')
        self.ws.close(self.first)
        with patch('workspace.scan', wraps=scan) as scanner:
            restored = Workspace(self.state)
            self.assertEqual(scanner.call_args.args, ([],))
        snapshot = restored.snapshot()
        self.assertEqual(snapshot['roots'], [])
        self.assertEqual(snapshot['savedCases'], [{'name': 'first', 'path': self.first, 'available': True, 'notes': 1}])
        reopened = restored.open(self.first)
        self.assertEqual(reopened['notes'][str(entry)], 'Comentário persistente')
        self.assertEqual(before, (entry.stat().st_mtime_ns, entry.read_bytes()))

    def test_replace_deduplicates_preserves_library_and_validates_before_mutation(self):
        self.ws.open(self.first)
        snapshot = self.ws.open(self.second, replace=True)
        self.assertEqual(self.paths(snapshot, 'roots'), [self.second])
        self.assertEqual(self.paths(snapshot, 'savedCases'), [self.first, self.second])
        self.ws.open(self.second + '/.')
        self.assertEqual(len(self.ws.snapshot()['roots']), 1)
        before = self.ws.snapshot()
        disk = self.ws.state_file.read_bytes()
        for value in ['', None, 123, [], 'bad\x00path', str(self.folder / 'missing'), str(Path(self.first) / 'AGENTS.md')]:
            with self.subTest(path=value), self.assertRaises((ValueError, OSError)):
                self.ws.open(value, replace=True)
            self.assertEqual(self.ws.snapshot(), before)
            self.assertEqual(self.ws.state_file.read_bytes(), disk)
        for value in ['false', 1, None, []]:
            with self.subTest(replace=value), self.assertRaises(ValueError):
                self.ws.open(self.first, replace=value)
        self.assertEqual(self.ws.snapshot(), before)

    def test_legacy_migration_keeps_missing_cases_and_notes(self):
        missing = str(self.folder / 'missing')
        self.ws.state_file.write_text(json.dumps({'roots': [self.first, missing, self.first], 'notes': {'file': 'Keep'}}))
        restored = Workspace(self.state)
        snapshot = restored.snapshot()
        self.assertEqual(self.paths(snapshot, 'roots'), [self.first])
        self.assertEqual(self.paths(snapshot, 'savedCases'), [self.first, missing])
        self.assertFalse(snapshot['savedCases'][1]['available'])
        self.assertEqual(snapshot['notes'], {'file': 'Keep'})
        self.assertTrue(snapshot['restoreErrors'])
        restored.close(self.first)
        again = Workspace(self.state)
        self.assertEqual(self.paths(again.snapshot(), 'savedCases'), [self.first, missing])
        self.assertEqual(again.snapshot()['roots'], [])

    def test_forget_requires_closed_case_preserves_notes_and_files(self):
        self.ws.open(self.first)
        node = str(Path(self.first) / 'AGENTS.md')
        self.ws.note(node, 'Keep even when forgotten')
        with self.assertRaises(ValueError):
            self.ws.forget(self.first)
        self.ws.close(self.first)
        snapshot = self.ws.forget(self.first)
        self.assertEqual(snapshot['savedCases'], [])
        self.assertEqual(snapshot['notes'][node], 'Keep even when forgotten')
        self.assertTrue(Path(node).is_file())
        self.assertEqual(Workspace(self.state).snapshot()['savedCases'], [])

    def test_missing_open_root_refresh_keeps_case_and_other_root(self):
        self.ws.open(self.first)
        self.ws.open(self.second)
        (Path(self.first) / 'AGENTS.md').unlink()
        Path(self.first).rmdir()
        refreshed = self.ws.refresh()
        self.assertEqual(self.paths(refreshed, 'roots'), [self.second])
        self.assertFalse(refreshed['savedCases'][0]['available'])
        self.assertTrue(refreshed['restoreErrors'])
        Path(self.first).mkdir()
        self.assertTrue(self.ws.snapshot()['savedCases'][0]['available'])
        self.assertEqual(self.paths(self.ws.open(self.first, replace=True), 'roots'), [self.first])
        self.assertEqual(self.ws.snapshot()['restoreErrors'], [])

    def test_saved_identity_does_not_follow_replaced_directory_symlink(self):
        self.ws.open(self.first)
        Path(self.first).rename(self.folder / 'moved-first')
        Path(self.first).symlink_to(self.second, target_is_directory=True)
        self.assertFalse(self.ws.snapshot()['savedCases'][0]['available'])
        with patch('workspace.scan', wraps=scan) as scanner:
            restored = Workspace(self.state)
            self.assertEqual(scanner.call_args.args, ([],))
        snapshot = restored.snapshot()
        self.assertEqual(self.paths(snapshot, 'savedCases'), [self.first])
        self.assertEqual(snapshot['roots'], [])
        self.assertFalse(snapshot['savedCases'][0]['available'])
        snapshot = self.ws.close(self.first)
        self.assertEqual(snapshot['roots'], [])
        self.assertEqual(self.ws.forget(self.first)['savedCases'], [])

    def test_deep_state_json_does_not_crash_restoration(self):
        self.ws.state_file.write_text('[' * 1100 + '0' + ']' * 1100)
        snapshot = Workspace(self.state).snapshot()
        self.assertEqual(snapshot['roots'], [])
        self.assertTrue(snapshot['restoreErrors'])

    def test_additive_open_does_not_redirect_other_roots_after_symlink_change(self):
        self.ws.open(self.first)
        Path(self.first).rename(self.folder / 'moved-first')
        Path(self.first).symlink_to(self.second, target_is_directory=True)
        third = self.project('third')
        snapshot = self.ws.open(third)
        self.assertEqual(self.paths(snapshot, 'roots'), [third])
        self.assertEqual(self.paths(snapshot, 'savedCases'), [self.first, third])
        self.assertFalse(any(node['path'].startswith(self.second + '/') for node in snapshot['nodes']))
        self.assertTrue(snapshot['restoreErrors'])

    def test_limit_applies_to_open_roots_only_and_nested_roots_stay_deduplicated(self):
        roots = [self.first, self.second] + [self.project(f'case-{i}') for i in range(11)]
        for root in roots[:12]:
            self.ws.open(root)
        with self.assertRaises(ValueError):
            self.ws.open(roots[12])
        snapshot = self.ws.open(roots[12], replace=True)
        self.assertEqual(len(snapshot['savedCases']), 13)
        self.assertEqual(len(snapshot['roots']), 1)
        child = self.project('first/child')
        self.ws.open(self.first, replace=True)
        snapshot = self.ws.open(child)
        self.assertEqual(snapshot['roots'][1]['parent'], self.first)
        self.assertEqual(snapshot['roots'][1]['level'], 1)
        self.assertEqual(len(snapshot['nodes']), len({node['id'] for node in snapshot['nodes']}))

    def test_invalid_saved_shapes_and_excess_roots_do_not_crash_startup(self):
        for state in [[], None, {'roots': 'bad', 'notes': []}, {'roots': [None, {}, ''], 'notes': {'good': 'text', 'bad': []}}]:
            with self.subTest(state=state):
                self.ws.state_file.write_text(json.dumps(state))
                restored = Workspace(self.state)
                self.assertEqual(restored.snapshot()['roots'], [])
                self.assertTrue(restored.snapshot()['restoreErrors'])
        roots = [self.project(f'restore-{i}') for i in range(13)]
        self.ws.state_file.write_text(json.dumps({'roots': roots, 'notes': {}}))
        restored = Workspace(self.state).snapshot()
        self.assertEqual(len(restored['roots']), 12)
        self.assertEqual(len(restored['savedCases']), 13)
        self.assertTrue(restored['restoreErrors'])

    def test_save_failure_does_not_apply_partial_workspace_or_note_change(self):
        self.ws.open(self.first)
        before = self.ws.snapshot()
        with patch('workspace.os.replace', side_effect=OSError('Synthetic full disk')):
            with self.assertRaises(OSError):
                self.ws.open(self.second, replace=True)
            with self.assertRaises(OSError):
                self.ws.note(str(Path(self.first) / 'AGENTS.md'), 'Not saved')
        self.assertEqual(self.ws.snapshot(), before)
        self.assertEqual(list(self.state.glob('.workspace-*')), [])

    def test_create_requires_explicit_parent_and_protects_destination_itself(self):
        payload = {'name': 'new-case', 'primitives': [{'name': 'worker', 'type': 'agent'}]}
        for parent in ['', None, [], 1]:
            with self.subTest(parent=parent), self.assertRaises(ValueError):
                create_directory({**payload, 'parent': parent})
        with patch.dict(os.environ, {'AAE_PROTECTED_PATHS': str(self.folder / 'new-case')}):
            with self.assertRaises(ValueError):
                create_directory({**payload, 'parent': str(self.folder)})
        self.assertFalse((self.folder / 'new-case').exists())

    def test_blueprint_invalid_json_fields_return_validation_errors(self):
        valid = {'name': 'new-case', 'primitives': [{'name': 'worker', 'type': 'agent'}]}
        for payload in [[], {**valid, 'primitives': [{'name': 'worker', 'type': []}]},
                        {**valid, 'relationships': [{'source': [], 'target': 'worker'}]},
                        {**valid, 'relationships': [{'source': 'worker', 'target': 'worker', 'type': []}]}]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                blueprint(payload)

    def test_authenticated_http_saved_cases_lifecycle_and_invalid_replace(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.ws, self.folder, 'test-token'))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            def request(route, body=None, token='test-token'):
                req = Request(f'http://127.0.0.1:{server.server_port}/api/{route}',
                              data=json.dumps(body).encode() if body is not None else None,
                              headers={'Content-Type': 'application/json', 'X-AAE-Token': token})
                with urlopen(req, timeout=5) as response:
                    return json.load(response)
            log = io.StringIO()
            with redirect_stderr(log):
                listing = request('directories?' + urlencode({'path': self.first, 'token': 'synthetic-query-secret'}))
                request('open', {'path': self.first})
                request('note', {'node': str(Path(self.first) / 'AGENTS.md'), 'body': 'synthetic-private-note'})
                request('content?' + urlencode({'path': str(Path(self.first) / 'AGENTS.md')}))
                with self.assertRaises(HTTPError) as invalid_listing:
                    request('directories?' + urlencode({'path': str(self.folder / 'synthetic-missing-path')}))
                invalid_listing.exception.close()
            self.assertEqual(listing['path'], self.first)
            logged = log.getvalue()
            self.assertIn('"GET /api/directories" 200', logged)
            self.assertIn('"GET /api/directories" 400', logged)
            for private_value in [self.first, 'synthetic-query-secret', 'test-token', 'synthetic-private-note', 'synthetic-missing-path', 'Synthetic entry']:
                self.assertNotIn(private_value, logged)
            request('open', {'path': self.first})
            snapshot = request('open', {'path': self.second, 'replace': True})
            self.assertEqual(self.paths(snapshot, 'roots'), [self.second])
            for route, body, token, status in [('forget', {'path': self.first}, 'bad', 403),
                                               ('open', {'path': self.first, 'replace': 'false'}, 'test-token', 400),
                                               ('forget', {'path': self.second}, 'test-token', 400),
                                               ('workspace', None, 'não-ascii', 403)]:
                with self.subTest(route=route, token=token), self.assertRaises(HTTPError) as error:
                    request(route, body, token)
                self.assertEqual(error.exception.code, status)
                error.exception.close()
            request('close', {'path': self.second})
            request('forget', {'path': self.first})
            snapshot = request('workspace')
            self.assertEqual(snapshot['roots'], [])
            self.assertEqual(self.paths(snapshot, 'savedCases'), [self.second])
            with self.assertRaises(HTTPError) as error:
                request('directories?path=~aae-nonexistent-user')
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
            deep_request = Request(f'http://127.0.0.1:{server.server_port}/api/open',
                                   data=('[' * 1100 + '0' + ']' * 1100).encode(),
                                   headers={'Content-Type': 'application/json', 'X-AAE-Token': 'test-token'})
            with self.assertRaises(HTTPError) as error:
                urlopen(deep_request, timeout=5)
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
            self.assertEqual(request('workspace')['roots'], [])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
