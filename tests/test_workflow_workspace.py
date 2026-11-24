"""Maintenance and recovery workflows over disposable roots and a real HTTP server."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from main import make_handler
from workspace import Workspace, blueprint


class WorkflowWorkspaceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-workflow-storage-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'fictional-agent'
        self.root.mkdir()
        self.entry = self.root / 'AGENTS.md'
        self.entry.write_text('# Agent\n[Policy](policy.md)\n', encoding='utf-8')
        self.policy = self.root / 'policy.md'
        self.policy.write_text('# Policy version one\n', encoding='utf-8')
        self.state = self.base / 'state'
        self.ws = Workspace(self.state)
        self.ws.open(str(self.root))
        static = self.base / 'static'
        static.mkdir()
        (static / 'index.html').write_text('<title>Synthetic workflow</title>')
        handler = make_handler(self.ws, static, 'workflow-fixture-token')
        handler.log_message = lambda *args: None
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, route, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {'X-AAE-Token': 'workflow-fixture-token'}
        encoded = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            encoded = json.dumps(body).encode('utf-8')
        try:
            connection.request('POST' if body is not None else 'GET', '/api/' + route, encoded, headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_refresh_after_file_maintenance_replaces_evidence_and_preserves_notes(self):
        self.ws.note(str(self.policy), 'Review after maintenance')
        before_ids = {edge['id'] for edge in self.ws.model['edges']}
        self.policy.unlink()
        replacement = self.root / 'policy-v2.md'
        replacement.write_text('# Policy version two\n', encoding='utf-8')
        self.entry.write_text('# Agent\n\n[Policy v2](policy-v2.md)\n', encoding='utf-8')
        status, missing = self.request('content?' + urlencode({'path': str(self.policy)}))
        self.assertEqual(status, 400)
        self.assertIn('error', missing)
        status, refreshed = self.request('refresh', {})
        self.assertEqual(status, 200)
        self.assertEqual([(e['source'], e['target'], e['line'], e['evidence']) for e in refreshed['edges']],
                         [(str(self.entry), str(replacement), 3, '[Policy v2](policy-v2.md)')])
        self.assertFalse(before_ids & {e['id'] for e in refreshed['edges']})
        self.assertNotIn(str(self.policy), {n['path'] for n in refreshed['nodes']})
        self.assertEqual(refreshed['notes'][str(self.policy)], 'Review after maintenance')
        self.assertEqual(Workspace(self.state).snapshot()['notes'], refreshed['notes'])
        self.assertEqual(self.request('content?' + urlencode({'path': str(replacement)}))[1]['text'], '# Policy version two\n')

    def test_moved_root_remains_unavailable_without_redirecting_saved_case(self):
        self.ws.note(str(self.entry), 'Original path annotation')
        moved = self.base / 'moved-agent'
        self.root.rename(moved)
        status, refreshed = self.request('refresh', {})
        self.assertEqual(status, 200)
        self.assertEqual(refreshed['roots'], [])
        # The note on the moved path still belongs to the saved case, unavailable or not.
        self.assertEqual(refreshed['savedCases'], [{'path': str(self.root), 'name': self.root.name, 'available': False, 'notes': 1}])
        self.assertTrue(refreshed['restoreErrors'])
        self.root.symlink_to(moved, target_is_directory=True)
        restarted = Workspace(self.state).snapshot()
        self.assertEqual(restarted['roots'], [])
        self.assertFalse(restarted['savedCases'][0]['available'])
        status, opened = self.request('open', {'path': str(moved)})
        self.assertEqual(status, 200)
        self.assertEqual([r['path'] for r in opened['roots']], [str(moved)])
        self.assertEqual([r['path'] for r in opened['savedCases']], [str(self.root), str(moved)])
        self.assertEqual(opened['notes'][str(self.entry)], 'Original path annotation')
        self.assertNotIn(str(moved / 'AGENTS.md'), opened['notes'])

    def test_unavailable_and_symlinked_previews_return_errors_then_recover(self):
        outside = self.base / 'outside.md'
        outside.write_text('Synthetic outside text', encoding='utf-8')
        route = 'content?' + urlencode({'path': str(self.policy)})
        for target in [outside, self.policy, self.base / 'absent.md']:
            with self.subTest(target=target):
                self.policy.unlink()
                self.policy.symlink_to(target)
                status, error = self.request(route)
                self.assertEqual(status, 400)
                self.assertIn('error', error)
                self.assertNotIn('text', error)
                self.assertEqual(self.request('workspace')[0], 200)
        self.policy.unlink()
        self.policy.mkdir()
        self.assertEqual(self.request(route)[0], 400)
        self.policy.rmdir()
        self.policy.write_text('# Recovered policy\n', encoding='utf-8')
        self.assertEqual(self.request(route), (200, {'text': '# Recovered policy\n', 'truncated': False}))

    def test_http_trace_rejects_truthy_nonboolean_conventions(self):
        child = self.root / 'nested' / 'AGENTS.md'
        child.parent.mkdir()
        child.write_text('# Nested entry without explicit link\n')
        self.ws.refresh()
        request = {'start': str(self.entry), 'end': str(child)}
        self.assertFalse(self.request('trace', request)[1]['found'])
        self.assertTrue(self.request('trace', {**request, 'conventions': True})[1]['found'])
        for value in ['false', 'true', 1, 0, None, [], {}]:
            with self.subTest(value=value):
                status, error = self.request('trace', {**request, 'conventions': value})
                self.assertEqual(status, 400)
                self.assertIn('error', error)
        self.assertFalse(self.request('trace', {**request, 'conventions': False})[1]['found'])

    def test_create_reports_existing_result_when_state_commit_fails(self):
        payload = {'parent': str(self.base), 'name': 'created-agent',
                   'primitives': [{'name': 'worker', 'type': 'agent'}], 'relationships': []}
        expected = blueprint(payload)
        destination = self.base / payload['name']
        snapshot = self.ws.snapshot()
        saved = self.ws.state_file.read_bytes()
        with patch('workspace.os.replace', side_effect=OSError('Synthetic state disk failure')):
            status, error = self.request('create', payload)
        self.assertEqual(status, 400)
        self.assertIn(str(destination), error['error'])
        self.assertIn('created', error['error'].lower())
        self.assertIn('Add folder', error['error'])
        self.assertEqual(self.ws.snapshot(), snapshot)
        self.assertEqual(self.ws.state_file.read_bytes(), saved)
        self.assertEqual({str(p.relative_to(destination)): p.read_text() for p in destination.rglob('*') if p.is_file()}, expected)
        retry_status, _ = self.request('create', payload)
        self.assertEqual(retry_status, 400)
        status, recovered = self.request('open', {'path': str(destination)})
        self.assertEqual(status, 200)
        self.assertIn(str(destination), {r['path'] for r in recovered['roots']})
        self.assertEqual(Workspace(self.state).snapshot()['roots'], recovered['roots'])

    def test_invalid_http_shapes_do_not_change_state_or_lose_service(self):
        before = self.ws.snapshot()
        saved = self.ws.state_file.read_bytes()
        cases = [('open', {'path': {}}), ('close', {'path': []}), ('forget', {'path': None}),
                 ('note', {'node': [], 'body': 'bad'}), ('note', {'node': str(self.entry), 'body': None}),
                 ('trace', {'start': [], 'end': str(self.policy)}),
                 ('trace', {'start': str(self.entry), 'end': str(self.policy), 'direction': {}}),
                 ('create', {'parent': str(self.base), 'name': '../escape', 'primitives': []}),
                 ('open', {}), ('note', {})]
        for route, payload in cases:
            with self.subTest(route=route, payload=payload):
                status, error = self.request(route, payload)
                self.assertEqual(status, 400)
                self.assertIn('error', error)
        self.assertEqual(self.request('workspace'), (200, before))
        self.assertEqual(self.ws.state_file.read_bytes(), saved)

    def test_creation_failure_before_writing_never_claims_a_created_directory(self):
        payload = {'parent': str(self.base / 'missing-parent'), 'name': 'never-created',
                   'primitives': [{'name': 'worker', 'type': 'agent'}]}
        before = self.ws.snapshot()
        status, error = self.request('create', payload)
        self.assertEqual(status, 400)
        self.assertNotIn('Folder created', error['error'])
        self.assertFalse((self.base / 'missing-parent').exists())
        self.assertEqual(self.ws.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
