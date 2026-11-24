import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from scanner import scan, find_path
from workspace import Workspace, blueprint, create_directory
from main import make_handler
from tests.server_pack import portuguese


class ScannerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, text):
        target = self.project / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        return str(target)

    def test_explicit_references_provenance_incoming_and_shortest_path(self):
        a = self.write('AGENTS.md', '# Agent\n[Memory](memory/context.md)\n[Rules][policy]\n[policy]: rules.md\n`missing.md`\nhttps://example.com/a\n')
        b = self.write('memory/context.md', '[Rules](../rules.md)\n')
        c = self.write('rules.md', '# Rules\n')
        model = scan([str(self.project)])
        ab = next(e for e in model['edges'] if e['source'] == a and e['target'] == b)
        self.assertEqual(ab['line'], 2)
        self.assertEqual(ab['evidence'], '[Memory](memory/context.md)')
        self.assertEqual({e['source'] for e in model['edges'] if e['target'] == c}, {a, b})
        self.assertEqual(find_path(model, a, c)['nodes'], [a, c])
        self.assertFalse(find_path(model, c, a)['found'])
        self.assertTrue(find_path(model, c, a, 'undirected')['steps'][0]['reverse'])
        self.assertEqual(find_path(model, a, a)['steps'], [])
        # A bare name in backticks that matches no file is a name, not a broken path.
        self.assertEqual([(i['code'], i['line'], i['target']) for i in model['issues'] if i['code'] in {'broken', 'unresolved-name'}],
                         [('unresolved-name', 5, 'missing.md')])

    def test_markdown_encodings_wiki_import_balanced_and_no_prose_guess(self):
        a = self.write('CLAUDE.md', '[Space](<a b.md>)\n[Balanced](guide_(v2).md)\n[[one]]\n@sub/AGENTS.md\njust missing.md in prose\n[Web](https://example.com)\n[Anchor](#heading)\n')
        for file in ['a b.md', 'guide_(v2).md', 'one.md', 'sub/AGENTS.md']:
            self.write(file, '# Test')
        model = scan([str(self.project)])
        explicit = [e for e in model['edges'] if e['source'] == a and e['kind'] != 'scope']
        self.assertEqual(len(explicit), 4)
        self.assertTrue(all(next(n for n in model['nodes'] if n['id'] == e['target'])['status'] == 'resolved' for e in explicit))

    def test_nested_roots_deduplicate_and_record_levels(self):
        a = self.write('AGENTS.md', '# Parent')
        b = self.write('child/deeper/CLAUDE.md', '# Child')
        model = scan([str(self.project), str(self.project / 'child/deeper')])
        self.assertEqual(len(model['nodes']), len({n['id'] for n in model['nodes']}))
        self.assertEqual(model['roots'][1]['level'], 2)
        self.assertEqual(model['roots'][1]['parent'], str(self.project))
        child = next(n for n in model['nodes'] if n['id'] == b)
        self.assertEqual(len(child['roots']), 2)
        self.assertEqual(child['root'], str(self.project / 'child/deeper'))
        self.assertFalse(find_path(model, a, b)['found'])
        self.assertTrue(find_path(model, a, b, conventions=True)['found'])

    def test_symlinks_exclusions_external_and_no_source_writes(self):
        self.write('AGENTS.md', '[Outside](../secret.md)\n[Excluded](node_modules/x.md)\n[Link](link.md)')
        self.write('node_modules/x.md', 'ignored')
        secret = self.root / 'secret.md'
        secret.write_text('PRIVATE OUTSIDE')
        (self.project / 'link.md').symlink_to(secret)
        before = {str(p): (p.lstat().st_size, p.lstat().st_mtime_ns) for p in self.project.rglob('*')}
        ws = Workspace(self.root / 'state')
        model = ws.open(str(self.project))
        outside = next(n for n in model['nodes'] if n['id'] == str(secret))
        self.assertEqual(outside['status'], 'external')
        self.assertFalse(any(i['code'] == 'broken' for i in model['issues']))
        with self.assertRaises(ValueError): ws.content(str(secret))
        with self.assertRaises(ValueError): ws.content(str(self.project / 'link.md'))
        ws.note(str(self.project / 'AGENTS.md'), 'Local comment')
        after = {str(p): (p.lstat().st_size, p.lstat().st_mtime_ns) for p in self.project.rglob('*')}
        self.assertEqual(before, after)
        restored = Workspace(self.root / 'state')
        self.assertEqual(restored.snapshot()['notes'][str(self.project / 'AGENTS.md')], 'Local comment')

    def test_limits_and_invalid_manifest_are_visible(self):
        self.write('AGENTS.md', '123456789012345')
        self.write('agent-architecture.json', '{invalid')
        with patch('scanner.MAX_BYTES', 10):
            model = scan([str(self.project)])
        self.assertTrue(any(i['code'] == 'limit' for i in model['issues']))
        self.assertTrue(any(i['code'] == 'manifest' for i in model['issues']))

    def test_create_preview_roundtrip_links_and_reachability(self):
        payload = {'parent': str(self.root), 'name': 'new-project', 'primitives': [{'name': 'worker', 'type': 'agent'}, {'name': 'context', 'type': 'memory'}], 'relationships': [{'source': 'worker', 'target': 'context', 'type': 'reads'}]}
        preview = blueprint(payload)
        path = Path(create_directory(payload))
        self.assertEqual({str(p.relative_to(path)): p.read_text() for p in path.rglob('*') if p.is_file()}, preview)
        model = scan([str(path)])
        # Only Markdown: no manifest, so no logical object and no declared or manifest relation.
        self.assertEqual(model['objects'], [])
        self.assertFalse(any(e['kind'] in ('declared', 'manifest') for e in model['edges']))
        self.assertTrue(any(e['kind'] == 'markdown' and e['target'] == str(path / 'memory/context.md') for e in model['edges']))
        self.assertTrue(find_path(model, str(path / 'AGENTS.md'), str(path / 'memory/context.md'))['found'])
        self.assertFalse(any(i['code'] == 'broken' for i in model['issues']))
        with self.assertRaises(FileExistsError): create_directory(payload)
        with patch.dict(os.environ, {'AAE_PROTECTED_PATHS': str(self.root)}):
            with self.assertRaises(ValueError): create_directory({**payload, 'name': 'protected'})
        with self.assertRaises(ValueError): blueprint({**payload, 'name': '../escape'})

    def test_invalid_object_and_ambiguous_wiki_audited(self):
        self.write('AGENTS.md', '[[same]]')
        self.write('x/same.md', '# One')
        self.write('y/same.md', '# Two')
        self.write('agent-architecture.json', '{"objects":[{}]}')
        model = scan([str(self.project)])
        self.assertTrue(any(i['code'] == 'ambiguous' for i in model['issues']))
        self.assertTrue(any(i['code'] == 'manifest' for i in model['issues']))

    def test_multiple_roots_share_inventory_budget(self):
        self.write('AGENTS.md', '# Large root')
        for i in range(10): self.write(f'f{i}.txt', 'Example')
        other = self.root / 'other'
        other.mkdir()
        (other / 'CLAUDE.md').write_text('# Other root')
        with patch('scanner.MAX_FILES', 8):
            model = scan([str(self.project), str(other)])
        self.assertIn(str(other / 'CLAUDE.md'), {n['id'] for n in model['nodes']})
        self.assertTrue(any(i['code'] == 'limit' for i in model['issues']))


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.ws = Workspace(cls.root / 'state')
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(cls.ws, cls.root, 'test-token'))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, route, data=None, **headers):
        return urlopen(Request(self.url + route, data=json.dumps(data).encode() if data is not None else None, headers={'Content-Type': 'application/json', **headers}), timeout=5)

    def test_auth_host_and_cross_origin_guards(self):
        self.assertEqual(json.load(self.request('/api/session'))['token'], 'test-token')
        for headers in ({}, {'X-AAE-Token': 'test-token', 'Origin': 'https://attacker.example'}, {'X-AAE-Token': 'test-token', 'Host': 'attacker.example'}, {'X-AAE-Token': 'test-token', 'Sec-Fetch-Site': 'cross-site'}):
            with self.assertRaises(HTTPError) as exc: self.request('/api/workspace', **headers)
            self.assertEqual(exc.exception.code, 403)
        self.assertEqual(json.load(self.request('/api/workspace', **{'X-AAE-Token': 'test-token'}))['roots'], [])

    def test_default_parent_is_the_home_directory(self):
        # The parent offered by "Nova arquitetura" must exist on any machine.
        session = json.load(self.request('/api/session'))
        self.assertEqual(session['defaultParent'], str(Path.home()))
        self.assertTrue(Path(session['defaultParent']).is_dir())

    def failure(self, route, data=None):
        with self.assertRaises(HTTPError) as exc:
            self.request(route, data, **{'X-AAE-Token': 'test-token'})
        with exc.exception as response:
            return response.code, json.load(response)['error']

    def test_system_errors_reach_the_interface_in_the_words_of_the_server_without_paths(self):
        base = self.root / 'erros'
        (base / 'nova').mkdir(parents=True)
        (base / 'arquivo.md').write_text('# Arquivo')
        locked = base / 'trancada'
        locked.mkdir()
        locked.chmod(0)
        self.addCleanup(locked.chmod, 0o700)
        architecture = {'parent': str(base), 'name': 'nova', 'primitives': [{'name': 'a', 'type': 'agent'}], 'relationships': []}
        cases = {
            'já existe': ('/api/create', architecture, 'already exists'),
            'não existe': ('/api/open', {'path': str(base / 'ausente' / 'pasta')}, 'does not exist'),
            'campo ausente': ('/api/open', {}, 'Required field missing: path'),
            'não é diretório': (f'/api/directories?path={base}/arquivo.md/x', None, 'is not a folder'),
            'sem permissão': (f'/api/directories?path={locked}', None, 'No permission'),
            'tipo inválido': ('/api/note', {'node': [], 'body': ''}, 'Invalid request'),
        }
        stderr = __import__('io').StringIO()
        with patch('sys.stderr', stderr):
            for label, (route, data, expected) in cases.items():
                with self.subTest(label):
                    code, message = self.failure(route, data)
                    self.assertEqual(code, 400)
                    self.assertIn(expected, message)
                    for raw in ('Errno', 'No such file', 'File exists', 'Permission denied', 'unhashable', "'path'"):
                        self.assertNotIn(raw, message)
                    self.assertNotIn(str(self.root), message.replace(str(base / 'ausente' / 'pasta'), ''))
        # The technical detail goes to the server log only, without the path.
        log = stderr.getvalue()
        self.assertIn('FileExistsError', log)
        self.assertIn('PermissionError', log)
        self.assertNotIn(str(base), log)


    def test_long_names_and_link_loops_have_their_own_messages(self):
        base = self.root / 'nomes'
        base.mkdir()
        (base / 'laco').symlink_to(base / 'laco')
        with patch('sys.stderr', __import__('io').StringIO()):
            code, message = self.failure('/api/open', {'path': str(base / ('x' * 300))})
            self.assertEqual(code, 400)
            self.assertIn('too long', message)
            code, message = self.failure('/api/open', {'path': str(base / 'laco' / 'a')})
        self.assertEqual(code, 400)
        # Python before 3.13 reports the loop while resolving the path, as an invalid path.
        self.assertTrue('loop of symbolic links' in message or message == 'Invalid folder path.', message)


@unittest.skipIf(os.geteuid() == 0, 'root writes in a directory without write permission')
class StateErrorTests(unittest.TestCase):
    """A failed write of the app state says so and names the state directory, never a path the user typed."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        base = Path(temp.name)
        self.state = base / 'state'
        self.project = base / 'loja'
        self.project.mkdir()
        (self.project / 'AGENTS.md').write_text('# Loja\n')
        self.ws = Workspace(self.state)
        self.ws.open(str(self.project))
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.ws, base, 'tok'))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.url = f'http://127.0.0.1:{server.server_port}'
        self.addCleanup(lambda: self.state.exists() and self.state.chmod(0o700))
        self.log = __import__('io').StringIO()
        stderr = patch('sys.stderr', self.log)
        stderr.start()
        self.addCleanup(stderr.stop)

    def post(self, route, data):
        request = Request(self.url + route, data=json.dumps(data).encode(),
                          headers={'Content-Type': 'application/json', 'X-AAE-Token': 'tok'})
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error as response:
                return response.code, json.load(response)

    def test_state_write_errors_name_the_state_directory(self):
        note = {'node': str(self.project / 'AGENTS.md'), 'body': 'Nota'}
        self.state.chmod(0o500)
        code, body = self.post('/api/note', note)
        self.assertEqual(code, 400)
        self.assertEqual(body['error'], f'Could not write to the state directory of the app ({self.state}): no permission.')
        # The answer brings the phrase of the sentence, and a Portuguese interface words it as the server did before.
        self.assertEqual(body['errorPhrase'], {'phrase': 'Could not write to the state directory of the app ({directory}): {reason}.',
                                               'params': {'directory': str(self.state), 'reason': {'phrase': 'no permission'}}})
        self.assertEqual(portuguese(body['error'], body['errorPhrase']), f'Não foi possível gravar no diretório de estado do aplicativo ({self.state}): sem permissão.')
        self.state.chmod(0o700)
        # The reference of Alterações, in the state directory too: a warning that names it.
        (self.state / 'references').chmod(0o500)
        code, body = self.post('/api/reference', {})
        (self.state / 'references').chmod(0o700)
        self.assertEqual(code, 200)
        warning = next(item for item in body['delta']['warnings'] if item['code'] == 'reference-not-saved')
        self.assertIn(f'Baseline not saved in the state directory of the app ({self.state}):', warning['message'])
        self.assertIn(f'Referência não salva no diretório de estado do aplicativo ({self.state}):', portuguese(warning['message'], warning['messagePhrase']))
        __import__('shutil').rmtree(self.state)
        code, body = self.post('/api/note', note)
        self.assertEqual(code, 400)
        self.assertEqual(body['error'], f'Could not write to the state directory of the app ({self.state}): the directory does not exist.')
        self.assertEqual(portuguese(body['error'], body['errorPhrase']), f'Não foi possível gravar no diretório de estado do aplicativo ({self.state}): o diretório não existe.')
        self.assertIn('PermissionError [Errno 13]', self.log.getvalue())
        self.assertIn('FileNotFoundError [Errno 2]', self.log.getvalue())
        self.assertNotIn('path given', self.log.getvalue())

if __name__ == '__main__':
    unittest.main()
