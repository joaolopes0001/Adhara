"""Editing permission and routes over HTTP (server/main.py, server/workspace.py, server/editing.py).

Every filesystem is a disposable temporary: HOME is a folder inside the fixture, the
protection variable is removed and both state directories are temporaries, so no real
directory of the user is read or written. The server runs in a thread of the test process.
"""
import errno
import fcntl
import gzip
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import pathlib
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
import types
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'server'))
import editing
from main import make_handler
from protected import ENVIRONMENT, STATE_FILE, configure_state_dir
import workspace as workspace_module
from workspace import StateWriteError, Workspace
from tests.server_pack import english, portuguese

TOKEN = 'token-sintetico-de-teste'
ROUTES = ['/api/edit/enable', '/api/edit/disable', '/api/edit/read', '/api/edit/save']
# The frozen contract: every code an edit route may answer, by status.
CODES = {403: {'session', 'edit-not-granted', 'protected', 'app-state'},
         409: {'conflict', 'missing', 'folder-changed', 'unconfirmed'},
         413: {'too-large'},
         400: {'not-in-workspace', 'not-editable-type', 'not-regular', 'hardlink', 'other-owner', 'other-group',
               'read-only-file', 'binary', 'not-utf8', 'mixed-eol', 'invalid-text', 'write-failed'}}


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Fixture:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-editing-http-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.home = self.base / 'home'
        self.home.mkdir()
        environment = {key: value for key, value in os.environ.items() if key != ENVIRONMENT}
        environment['HOME'] = str(self.home)
        variables = patch.dict(os.environ, environment, clear=True)
        variables.start()
        self.addCleanup(variables.stop)
        self.state = self.base / 'state'
        configure_state_dir(self.state)
        self.addCleanup(configure_state_dir, None)
        # The request log goes to stderr: kept here, both to keep the output clean and to inspect it.
        self.log = io.StringIO()
        stderr = patch('sys.stderr', new=self.log)
        stderr.start()
        self.addCleanup(stderr.stop)
        self.loja = self.base / 'loja'
        (self.loja / 'docs').mkdir(parents=True)
        (self.loja / 'AGENTS.md').write_text('# Loja\n[Guia](docs/guia.md)\n')
        self.doc = self.loja / 'docs' / 'guia.md'
        self.doc.write_bytes(b'# Guia\n\nTexto.\n')
        (self.loja / 'dados.json').write_text('{}\n')
        self.inner = self.loja / 'pagamentos'
        (self.inner / 'docs').mkdir(parents=True)
        (self.inner / 'CLAUDE.md').write_text('# Pagamentos\n[Regras](docs/regras.md)\n')
        self.rule = self.inner / 'docs' / 'regras.md'
        self.rule.write_text('# Regras\n')
        self.ws = Workspace(self.state)
        self.ws.open(str(self.loja))
        self.server = None
        self.serve(self.ws)

    def serve(self, workspace):
        """(Re)start the server on `workspace`: a restart of the app is a new Workspace from the same state."""
        if self.server is not None:
            self.stop()
        self.ws = workspace
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(workspace, self.base, TOKEN))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=5)
            self.server = None

    def call(self, route, body=None, method='POST', token=TOKEN, headers=None, raw=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        try:
            sent = {} if token is None else {'X-AAE-Token': token}
            if method == 'POST':
                sent['Content-Type'] = 'application/json'
            sent.update(headers or {})
            data = raw if raw is not None else json.dumps(body if body is not None else {}).encode() if method == 'POST' else None
            connection.request(method, route, body=data, headers=sent)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def claimed(self, route, length):
        """A POST that announces `length` bytes and sends none: the server must answer without reading them."""
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=30)
        try:
            connection.putrequest('POST', route)
            for name, value in [('X-AAE-Token', TOKEN), ('Content-Type', 'application/json'), ('Content-Length', str(length))]:
                connection.putheader(name, value)
            connection.endheaders()
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def snapshot(self):
        status, snapshot = self.call('/api/workspace', method='GET')
        self.assertEqual(status, 200)
        return snapshot

    def enable(self, root=None):
        return self.call('/api/edit/enable', {'root': str(root or self.loja)})

    def disable(self, root=None):
        return self.call('/api/edit/disable', {'root': str(root or self.loja)})

    def read(self, path=None):
        return self.call('/api/edit/read', {'path': str(path or self.doc)})

    def save(self, text, path=None, base=None):
        path = Path(path or self.doc)
        return self.call('/api/edit/save', {'path': str(path), 'baseSha256': base or sha(path.read_bytes()), 'text': text})

    def assertRefusal(self, answer, status, code):
        """An edit refusal: the status of its code, exactly `{error, code}` (and `errorPhrase`, the phrase of a
        sentence made with parameters, which reads as the sentence), a sentence, no technical text."""
        got, body = answer
        self.assertEqual((got, body.get('code')), (status, code), body)
        self.assertEqual(set(body) - {'errorPhrase'}, {'error', 'code'})
        if 'errorPhrase' in body:
            self.assertEqual(english(body['errorPhrase']), body['error'])
        self.assertIn(code, CODES[status])
        self.assertEqual(editing.STATUS.get(code, 400) if code != 'session' else 403, status)
        self.assertIsInstance(body['error'], str)
        self.assertTrue(body['error'].endswith('.'), body['error'])
        self.assertNotRegex(body['error'], r'Errno|Traceback|Error\b|Exception')
        return body['error']

    def assertGranted(self, *roots):
        self.assertEqual(set(self.snapshot()['editing']), {str(root) for root in roots})


class GrantTests(Fixture, unittest.TestCase):
    def test_session_says_what_is_editable(self):
        status, session = self.call('/api/session', method='GET', token=None)
        self.assertEqual(status, 200)
        self.assertEqual(session['edit'], {'extensions': ['.markdown', '.md'], 'maxBytes': 256 * 1024})

    def test_enable_read_save_disable(self):
        self.assertEqual(self.snapshot()['editing'], {})
        self.assertRefusal(self.read(), 403, 'edit-not-granted')
        self.assertRefusal(self.save('# Antes de ligar\n'), 403, 'edit-not-granted')
        self.assertEqual(self.doc.read_bytes(), b'# Guia\n\nTexto.\n')
        status, answer = self.enable()
        self.assertEqual(status, 200)
        self.assertEqual(set(answer), {'editing'})
        self.assertEqual(set(answer['editing']), {str(self.loja)})
        self.assertEqual(set(answer['editing'][str(self.loja)]), {'at'})
        self.assertEqual(self.snapshot()['editing'], answer['editing'])
        status, read = self.read()
        self.assertEqual(status, 200)
        self.assertEqual(read, {'path': str(self.doc), 'text': '# Guia\n\nTexto.\n', 'sha256': sha(b'# Guia\n\nTexto.\n'),
                                'bytes': 15, 'eol': 'lf', 'bom': False})
        status, saved = self.save('# Guia\n\nTexto novo.\n', base=read['sha256'])
        self.assertEqual(status, 200)
        self.assertEqual(saved, {'path': str(self.doc), 'sha256': sha(b'# Guia\n\nTexto novo.\n'), 'bytes': 20,
                                 'previousSha256': read['sha256'], 'unchanged': False, 'durable': True})
        self.assertEqual(self.doc.read_bytes(), b'# Guia\n\nTexto novo.\n')
        status, again = self.save('# Guia\n\nTexto novo.\n')
        self.assertEqual((status, again['unchanged']), (200, True))
        self.assertEqual(self.disable(), (200, {'editing': {}}))
        self.assertRefusal(self.save('# Depois de desligar\n'), 403, 'edit-not-granted')
        self.assertEqual(self.doc.read_bytes(), b'# Guia\n\nTexto novo.\n')
        # Disabling what is disabled is not an error, and writes nothing.
        state = self.ws.state_file.read_bytes()
        self.assertEqual(self.disable(), (200, {'editing': {}}))
        self.assertEqual(self.disable(self.base / 'nunca-aberto'), (200, {'editing': {}}))
        self.assertEqual(self.ws.state_file.read_bytes(), state)

    def test_another_connection_sees_the_grant_and_its_removal(self):
        status, session = self.call('/api/session', method='GET', token=None)
        self.enable()
        status, snapshot = self.call('/api/workspace', method='GET', token=session['token'])
        self.assertEqual(set(snapshot['editing']), {str(self.loja)})
        self.call('/api/edit/disable', {'root': str(self.loja)}, token=session['token'])
        self.assertEqual(self.snapshot()['editing'], {})

    def test_disabled_in_another_connection_refuses_the_next_save(self):
        self.enable()
        status, read = self.read()
        self.assertEqual(self.disable()[0], 200)  # Another window.
        self.assertRefusal(self.save('# Meu texto\n', base=read['sha256']), 403, 'edit-not-granted')
        self.assertEqual(self.doc.read_bytes(), b'# Guia\n\nTexto.\n')

    def test_the_grant_survives_a_restart_and_closing_and_forgetting_erases_it(self):
        self.enable()
        stored = json.loads(self.ws.state_file.read_text())['editing']
        self.assertEqual(set(stored), {str(self.loja)})
        self.assertEqual(set(stored[str(self.loja)]), {'at', 'dev', 'ino'})
        self.serve(Workspace(self.state))
        self.assertGranted(self.loja)
        self.assertEqual(self.read()[0], 200)
        # Closed: no longer shown (only opened roots are), still stored, and back when reopened.
        self.call('/api/close', {'path': str(self.loja)})
        self.assertEqual(self.snapshot()['editing'], {})
        self.assertIn(str(self.loja), json.loads(self.ws.state_file.read_text())['editing'])
        self.call('/api/open', {'path': str(self.loja)})
        self.assertGranted(self.loja)
        self.assertEqual(self.read()[0], 200)
        # Forgotten: erased.
        self.call('/api/close', {'path': str(self.loja)})
        self.assertEqual(self.call('/api/forget', {'path': str(self.loja)})[0], 200)
        self.assertNotIn('editing', json.loads(self.ws.state_file.read_text()))
        self.call('/api/open', {'path': str(self.loja)})
        self.assertEqual(self.snapshot()['editing'], {})
        self.assertRefusal(self.read(), 403, 'edit-not-granted')

    def test_enabling_again_keeps_one_record(self):
        self.enable()
        first = json.loads(self.ws.state_file.read_text())['editing']
        self.enable()
        second = json.loads(self.ws.state_file.read_text())['editing']
        self.assertEqual(set(second), {str(self.loja)})
        self.assertEqual({key: second[str(self.loja)][key] for key in ('dev', 'ino')},
                         {key: first[str(self.loja)][key] for key in ('dev', 'ino')})

    def test_enable_refuses_a_root_not_opened_and_a_protected_one(self):
        state = self.ws.state_file.read_bytes()
        outside = self.base / 'fora'
        outside.mkdir()
        for root in [outside, self.loja / 'docs', f'{self.loja}/', 'loja', None, 5]:
            with self.subTest(root=root):
                answer = self.call('/api/edit/enable', {'root': root if root is None or root == 5 else str(root)})
                self.assertRefusal(answer, 400, 'not-in-workspace')
        alias = self.base / 'atalho'
        alias.symlink_to(self.loja, target_is_directory=True)
        for entry in [self.loja, alias, self.base]:
            with self.subTest(protected=entry), patch.dict(os.environ, {ENVIRONMENT: str(entry)}):
                message = self.assertRefusal(self.enable(), 403, 'protected')
                self.assertTrue(message.endswith(editing.PROTECTED_TRADE), message)
        # A broken configuration is not "this project is on the list": no trade text.
        with patch.dict(os.environ, {ENVIRONMENT: 'relativo/caminho'}):
            message = self.assertRefusal(self.enable(), 403, 'protected')
            self.assertNotIn(editing.PROTECTED_TRADE, message)
        self.assertEqual(self.ws.state_file.read_bytes(), state)
        self.assertEqual(self.snapshot()['editing'], {})
        # A protected folder inside the root: the root can be granted, the files of that folder are refused one by one.
        with patch.dict(os.environ, {ENVIRONMENT: str(self.loja / 'docs')}):
            self.assertEqual(self.enable()[0], 200)
            self.assertRefusal(self.read(), 403, 'protected')
            self.assertEqual(self.read(self.loja / 'AGENTS.md')[0], 200)

    def test_enable_refuses_the_home_folder_and_the_folders_above_it(self):
        (self.home / 'CLAUDE.md').write_text('# Pessoal\n')
        for root in [self.home, self.base]:
            with self.subTest(root=root):
                self.call('/api/open', {'path': str(root)})
                message = self.assertRefusal(self.enable(root), 403, 'edit-not-granted')
                self.assertEqual(message, editing.WIDE)
                self.call('/api/close', {'path': str(root)})
        # A grant written into the state by hand (or by a version without this rule) is never honored.
        self.call('/api/open', {'path': str(self.home)})
        info = os.stat(self.home)
        state = json.loads(self.ws.state_file.read_text())
        state['editing'] = {str(self.home): {'at': '2026-11-15T10:00:00-03:00', 'dev': info.st_dev, 'ino': info.st_ino}}
        self.ws.state_file.write_text(json.dumps(state))
        self.serve(Workspace(self.state))
        self.assertEqual(self.snapshot()['editing'], {})
        self.assertEqual(self.assertRefusal(self.read(self.home / 'CLAUDE.md'), 403, 'edit-not-granted'), editing.WIDE)

    def test_another_folder_at_the_same_path_does_not_inherit_the_grant(self):
        self.enable()
        self.loja.rename(self.base / 'loja-antiga')
        shutil.copytree(self.base / 'loja-antiga', self.loja)  # A new clone at the same path, same files.
        self.assertEqual(self.call('/api/refresh', {})[0], 200)
        self.assertEqual(self.snapshot()['editing'], {})
        self.assertEqual(self.assertRefusal(self.read(), 403, 'edit-not-granted'), editing.CHANGED)
        self.assertRefusal(self.save('# Herdado\n'), 403, 'edit-not-granted')
        self.assertEqual(self.doc.read_bytes(), b'# Guia\n\nTexto.\n')
        self.assertEqual(self.enable()[0], 200)
        self.assertEqual(self.read()[0], 200)
        # Gone from disk, still opened until the next reading: refused, and the snapshot stops showing the grant.
        shutil.rmtree(self.loja)
        self.assertEqual(self.snapshot()['editing'], {})
        self.assertIn('no longer exists', self.assertRefusal(self.read(), 403, 'edit-not-granted'))

    def test_nested_projects_follow_the_most_specific_opened_root(self):
        self.call('/api/open', {'path': str(self.inner)})
        self.enable(self.loja)
        self.assertEqual(self.read()[0], 200)
        message = self.assertRefusal(self.read(self.rule), 403, 'edit-not-granted')
        self.assertIn(str(self.inner), message)
        self.assertRefusal(self.save('# Pela de fora\n', self.rule), 403, 'edit-not-granted')
        self.assertEqual(self.rule.read_text(), '# Regras\n')
        self.assertEqual(self.enable(self.inner)[0], 200)
        self.assertGranted(self.loja, self.inner)
        self.assertEqual(self.save('# Regras novas\n', self.rule)[0], 200)
        # Each grant is its own: disabling the outer root leaves the nested one enabled.
        self.disable(self.loja)
        self.assertRefusal(self.read(), 403, 'edit-not-granted')
        self.assertEqual(self.read(self.rule)[0], 200)
        # Closed, the nested project's files belong to the outer root again and follow its grant.
        self.disable(self.inner)
        self.enable(self.loja)
        self.call('/api/close', {'path': str(self.inner)})
        self.assertEqual(self.read(self.rule)[0], 200)
        # Reopened, the nested project decides again.
        self.call('/api/open', {'path': str(self.inner)})
        self.assertRefusal(self.read(self.rule), 403, 'edit-not-granted')

    def test_invalid_grants_in_the_saved_state_are_dropped_with_a_warning(self):
        info = os.stat(self.loja)
        valid = {'at': '2026-11-15T10:00:00-03:00', 'dev': info.st_dev, 'ino': info.st_ino}
        state = json.loads(self.ws.state_file.read_text())
        state['editing'] = {str(self.loja): {**valid, 'extra': 'ignorado'}, 'relativo/raiz': valid, f'{self.loja}/': valid,
                            str(self.base / 'a'): {**valid, 'at': 5}, str(self.base / 'b'): {**valid, 'dev': '1'},
                            str(self.base / 'c'): {**valid, 'ino': True}, str(self.base / 'd'): 'sim',
                            str(self.base / 'e'): {**valid, 'dev': -1}}
        self.ws.state_file.write_text(json.dumps(state))
        restored = Workspace(self.state)
        self.assertIn('7 invalid editing permissions in the saved state were ignored.', restored.restore_errors)
        self.assertEqual([portuguese(text) for text in restored.restore_errors], ['7 permissões de edição inválidas no estado salvo foram ignoradas.'])
        self.assertEqual(restored.state['editing'], {str(self.loja): valid})
        self.assertEqual(restored.snapshot()['editing'], {str(self.loja): {'at': valid['at']}})
        state['editing'] = [str(self.loja)]
        self.ws.state_file.write_text(json.dumps(state))
        restored = Workspace(self.state)
        self.assertIn('An invalid editing permission in the saved state was ignored.', restored.restore_errors)
        self.assertEqual([portuguese(text) for text in restored.restore_errors], ['Uma permissão de edição inválida no estado salvo foi ignorada.'])
        self.assertNotIn('editing', restored.state)
        # Well formed, but for another folder than the one at that path: kept as it is, never honored.
        state['editing'] = {str(self.loja): {**valid, 'ino': info.st_ino + 1}}
        self.ws.state_file.write_text(json.dumps(state))
        self.serve(Workspace(self.state))
        self.assertEqual(self.ws.restore_errors, [])
        self.assertEqual(self.snapshot()['editing'], {})
        self.assertEqual(self.assertRefusal(self.read(), 403, 'edit-not-granted'), editing.CHANGED)

    def test_a_dangling_link_in_the_protection_list_keeps_editing_elsewhere(self):
        dangling = self.base / 'disco'
        dangling.symlink_to(self.base / 'disco-desmontado')
        self.state.joinpath(STATE_FILE).write_text(f'{dangling}\n')
        self.assertEqual(self.enable()[0], 200)
        status, read = self.read()
        self.assertEqual(status, 200)
        self.assertEqual(self.save('# Gravado\n', base=read['sha256'])[0], 200)
        self.assertEqual(self.doc.read_text(), '# Gravado\n')


class HTTPBoundaryTests(Fixture, unittest.TestCase):
    def bodies(self):
        return {'/api/edit/enable': {'root': str(self.loja)}, '/api/edit/disable': {'root': str(self.loja)},
                '/api/edit/read': {'path': str(self.doc)},
                '/api/edit/save': {'path': str(self.doc), 'baseSha256': sha(self.doc.read_bytes()), 'text': '# Fora\n'}}

    def test_session_origin_host_and_fetch_site_on_every_edit_route(self):
        self.enable()
        before, state = self.doc.read_bytes(), self.ws.state_file.read_bytes()
        for route, body in self.bodies().items():
            for token in [None, '', 'outro-token']:
                with self.subTest(route=route, token=token):
                    answer = self.call(route, body, token=token)
                    self.assertEqual(answer, (403, {'error': 'Invalid session. Reopen the app.', 'code': 'session'}))
                    self.assertRefusal(answer, 403, 'session')
            for headers in [{'Origin': 'http://evil.example'}, {'Host': 'evil.example'}, {'Sec-Fetch-Site': 'cross-site'}]:
                with self.subTest(route=route, headers=headers):
                    self.assertEqual(self.call(route, body, headers=headers), (403, {'error': 'Unauthorized origin.'}))
        self.assertEqual(self.doc.read_bytes(), before)
        self.assertEqual(self.ws.state_file.read_bytes(), state)
        self.assertGranted(self.loja)
        # The routes that existed answer the same code.
        self.assertEqual(self.call('/api/workspace', method='GET', token='outro-token')[1]['code'], 'session')
        self.assertEqual(self.call('/api/refresh', {}, token='outro-token')[1]['code'], 'session')

    def test_body_limits_and_malformed_requests(self):
        self.enable()
        before = self.doc.read_bytes()
        for route in ROUTES:
            for headers, raw in [({'Content-Type': 'text/plain'}, b'{}'), ({}, b'{quebrado'), ({}, b'[]'), ({}, b'\xff')]:
                with self.subTest(route=route, raw=raw, headers=headers):
                    status, answer = self.call(route, raw=raw, headers=headers)
                    self.assertEqual(status, 400)
                    self.assertIn('error', answer)
        # Above 2 MiB a save is refused before its body is read; the other routes keep 256,000 bytes.
        self.assertEqual(self.claimed('/api/edit/save', 2 * 1024 * 1024 + 1),
                         (413, {'error': editing.MESSAGES['too-large'], 'code': 'too-large'}))
        for route in ROUTES[:3]:
            with self.subTest(route=route):
                status, answer = self.claimed(route, 256001)
                self.assertEqual(status, 400)
                self.assertIn('too large', answer['error'])
        self.assertEqual(self.doc.read_bytes(), before)
        # Between the two limits, a save: 256 KiB of a control character, which JSON escapes as six bytes.
        text = '\x01' * editing.MAX_BYTES
        payload = json.dumps({'path': str(self.doc), 'baseSha256': sha(before), 'text': text}).encode()
        self.assertTrue(256000 < len(payload) < 2 * 1024 * 1024, len(payload))
        status, saved = self.call('/api/edit/save', raw=payload)
        self.assertEqual((status, saved['bytes']), (200, editing.MAX_BYTES))
        self.assertEqual(self.doc.read_bytes(), text.encode())
        # One character more fits the body and not the core: too large after decoding.
        payload = json.dumps({'path': str(self.doc), 'baseSha256': saved['sha256'], 'text': text + 'x'}).encode()
        self.assertRefusal(self.call('/api/edit/save', raw=payload), 413, 'too-large')
        self.assertEqual(self.doc.read_bytes(), text.encode())

    def test_get_on_the_edit_routes_is_not_found(self):
        for route in ROUTES:
            with self.subTest(route=route):
                self.assertEqual(self.call(route, method='GET'), (404, {'error': 'Route not found.'}))

    def test_fields_missing_or_of_the_wrong_type_are_refused_with_a_code(self):
        self.enable()
        before, digest = self.doc.read_bytes(), sha(self.doc.read_bytes())
        cases = [('/api/edit/enable', {}, 400, 'not-in-workspace'), ('/api/edit/enable', {'root': 5}, 400, 'not-in-workspace'),
                 ('/api/edit/disable', {}, 400, 'not-in-workspace'), ('/api/edit/disable', {'root': ['x']}, 400, 'not-in-workspace'),
                 ('/api/edit/read', {}, 400, 'not-in-workspace'), ('/api/edit/read', {'path': 5}, 400, 'not-in-workspace'),
                 ('/api/edit/read', {'path': 'docs/guia.md'}, 400, 'not-in-workspace'),
                 ('/api/edit/read', {'path': f'{self.loja}/docs/../docs/guia.md'}, 400, 'not-in-workspace'),
                 ('/api/edit/save', {'baseSha256': digest, 'text': '# x\n'}, 400, 'not-in-workspace'),
                 ('/api/edit/save', {'path': str(self.doc), 'text': '# x\n'}, 400, 'invalid-text'),
                 ('/api/edit/save', {'path': str(self.doc), 'baseSha256': 5, 'text': '# x\n'}, 400, 'invalid-text'),
                 ('/api/edit/save', {'path': str(self.doc), 'baseSha256': digest.upper(), 'text': '# x\n'}, 400, 'invalid-text'),
                 ('/api/edit/save', {'path': str(self.doc), 'baseSha256': digest}, 400, 'invalid-text'),
                 ('/api/edit/save', {'path': str(self.doc), 'baseSha256': digest, 'text': ['# x']}, 400, 'invalid-text'),
                 ('/api/edit/save', {'path': str(self.doc), 'baseSha256': digest, 'text': '# x\r\n'}, 400, 'invalid-text'),
                 ('/api/edit/save', {'path': str(self.doc), 'baseSha256': digest, 'text': '# \ud800\n'}, 400, 'invalid-text')]
        for route, body, status, code in cases:
            with self.subTest(route=route, body=body):
                self.assertRefusal(self.call(route, body), status, code)
        self.assertEqual(self.doc.read_bytes(), before)
        self.assertGranted(self.loja)

    def test_every_refusal_has_a_code_of_the_contract_and_a_message(self):
        files = {'protected-paths.txt': b'# x\n', 'binario.md': b'# x\x00y\n', 'latin1.md': b'caf\xe9\n',
                 'misto.md': b'a\r\nb\n', 'grande.md': b'x' * (300 * 1024), 'duplo.md': b'# Dois nomes\n',
                 'fixo.md': b'# Fixo\n', 'some.md': b'# Some\n'}
        for name, data in files.items():
            (self.loja / name).write_bytes(data)
        os.link(self.loja / 'duplo.md', self.base / 'outro-nome.md')
        os.chmod(self.loja / 'fixo.md', 0o444)
        self.call('/api/refresh', {})
        (self.loja / 'some.md').unlink()
        self.assertRefusal(self.read(), 403, 'edit-not-granted')
        self.enable()
        cases = [('protected-paths.txt', 403, 'app-state'), ('dados.json', 400, 'not-editable-type'),
                 ('binario.md', 400, 'binary'), ('latin1.md', 400, 'not-utf8'), ('misto.md', 400, 'mixed-eol'),
                 ('grande.md', 413, 'too-large'), ('duplo.md', 400, 'hardlink'), ('fixo.md', 400, 'read-only-file'),
                 ('some.md', 409, 'missing'), ('ausente.md', 400, 'not-in-workspace')]
        for name, status, code in cases:
            with self.subTest(name=name):
                self.assertRefusal(self.read(self.loja / name), status, code)
                self.assertRefusal(self.save('# x\n', self.loja / name, base='0' * 64), status, code)
        self.assertRefusal(self.save('# x\n', base='0' * 64), 409, 'conflict')
        with patch.dict(os.environ, {ENVIRONMENT: str(self.loja / 'docs')}):
            self.assertRefusal(self.read(), 403, 'protected')
        self.assertEqual(self.doc.read_bytes(), b'# Guia\n\nTexto.\n')
        for name, data in files.items():
            if name != 'some.md':
                self.assertEqual((self.loja / name).read_bytes(), data)

    def test_unconfirmed_answers_the_message_of_the_core_as_it_is(self):
        """A cleaner removes the temporary right before the rename: the outcome is unknown, never "nothing saved"."""
        self.enable()
        status, read = self.read()
        folder, real_resolve, removed = self.doc.parent, pathlib.Path.resolve, []
        def cleaner(path, *args, **kwargs):
            result = real_resolve(path, *args, **kwargs)
            if str(path) == str(folder):  # Step 21, the last call before the rename.
                for name in os.listdir(folder):
                    if name.startswith('.aae-edit-'):
                        os.unlink(folder / name)
                        removed.append(name)
            return result
        with patch.object(pathlib.Path, 'resolve', cleaner):
            status, answer = self.save('# Meu texto\n', base=read['sha256'])
        self.assertEqual(len(removed), 1)
        self.assertEqual(status, 409)
        self.assertEqual(set(answer), {'error', 'code', 'errorPhrase'})
        self.assertEqual(answer['code'], 'unconfirmed')
        self.assertEqual(answer['error'], f'Could not confirm whether the file was replaced ({os.strerror(errno.ENOENT)}). '
                                          'Read the file again before saving again. The temporary file of this save was named '
                                          f'{removed[0]}; if it is still in the folder, it was not deleted.')
        self.assertNotIn('Nothing was saved', answer['error'])
        # The sentence comes with its phrase, and a Portuguese interface words it as the server did before.
        self.assertEqual(english(answer['errorPhrase']), answer['error'])
        self.assertEqual(answer['errorPhrase']['params'], {'cause': os.strerror(errno.ENOENT), 'temporary': removed[0]})
        said = portuguese(answer['error'], answer['errorPhrase'])
        self.assertEqual(said, f'Não foi possível confirmar se o arquivo foi trocado ({os.strerror(errno.ENOENT)}). '
                               'Releia o arquivo antes de gravar de novo. O temporário desta gravação se chamava '
                               f'{removed[0]}; se ele ainda estiver na pasta, não foi apagado.')
        self.assertNotIn('Nada foi gravado', said)
        self.assertEqual(self.doc.read_bytes(), b'# Guia\n\nTexto.\n')

    def hold_folder(self):
        held = os.open(self.doc.parent, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, held)
        fcntl.flock(held, fcntl.LOCK_EX)  # Another program, or another instance of the app.
        return held

    def saving(self, text, base, outcome):
        """A save in a thread; appends `(answer, seconds)` to `outcome`."""
        def run():
            started = time.monotonic()
            answer = self.save(text, base=base)
            outcome.append((answer, time.monotonic() - started))
        worker = threading.Thread(target=run)
        worker.start()
        return worker

    def test_a_save_waiting_for_a_held_folder_never_holds_the_other_routes(self):
        """Six saves on a folder another program holds do not stall GET /api/workspace."""
        self.enable()
        status, read = self.read()
        self.hold_folder()
        outcome = []
        with patch.object(editing, 'LOCK_WAIT', 1.0):
            workers = [self.saving('# Outro\n', read['sha256'], outcome) for _ in range(6)]
            time.sleep(0.2)
            for method, route, body in [('GET', '/api/workspace', None), ('POST', '/api/refresh', {}),
                                        ('POST', '/api/edit/read', {'path': str(self.doc)})]:
                with self.subTest(route=route):
                    started = time.monotonic()
                    self.assertEqual(self.call(route, body, method=method)[0], 200)
                    self.assertLess(time.monotonic() - started, 0.5)
            for worker in workers:
                worker.join(30)
        self.assertEqual(len(outcome), 6)
        for answer, seconds in outcome:
            self.assertEqual(self.assertRefusal(answer, 400, 'write-failed'), editing.BUSY)
            self.assertGreaterEqual(seconds, 1.0)
            self.assertLess(seconds, 2.5)  # Each save has its own budget; one after the other would take six seconds.
        self.assertEqual(self.doc.read_bytes(), b'# Guia\n\nTexto.\n')

    def test_a_folder_released_while_a_save_waits_is_saved(self):
        self.enable()
        status, read = self.read()
        held = self.hold_folder()
        outcome = []
        worker = self.saving('# Depois da espera\n', read['sha256'], outcome)
        time.sleep(0.3)
        fcntl.flock(held, fcntl.LOCK_UN)
        worker.join(30)
        (answer, seconds), = outcome
        self.assertEqual(answer[0], 200, answer)
        self.assertGreaterEqual(seconds, 0.3)
        self.assertEqual(self.doc.read_text(), '# Depois da espera\n')

    def test_every_attempt_of_a_waiting_save_checks_everything_again(self):
        """What changes between two attempts counts: nothing checked before the wait is used after it."""
        self.enable()
        status, read = self.read()
        held = self.hold_folder()
        outcome = []
        worker = self.saving('# Sem permissão\n', read['sha256'], outcome)
        time.sleep(0.2)
        self.assertEqual(self.disable()[0], 200)  # Another window, while the save waits.
        worker.join(30)
        self.assertRefusal(outcome.pop()[0], 403, 'edit-not-granted')
        self.enable()
        worker = self.saving('# Base velha\n', read['sha256'], outcome)
        time.sleep(0.2)
        self.doc.write_bytes(b'# Outro programa\n')  # Another program writes, and the app reads again.
        self.assertEqual(self.call('/api/refresh', {})[0], 200)
        fcntl.flock(held, fcntl.LOCK_UN)
        worker.join(30)
        self.assertRefusal(outcome.pop()[0], 409, 'conflict')
        self.assertEqual(self.doc.read_bytes(), b'# Outro programa\n')

    def test_a_temporary_swapped_before_the_rename_is_never_a_success(self):
        """Another program renames its own file over the temporary: the save is refused, not reported with the wrong hash."""
        self.enable()
        status, read = self.read()
        real_replace = os.replace
        def swap(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
            fd = os.open('alheio.part', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644, dir_fd=src_dir_fd)
            os.write(fd, b'ALHEIO\n')
            os.close(fd)
            os.rename('alheio.part', src, src_dir_fd=src_dir_fd, dst_dir_fd=src_dir_fd)
            return real_replace(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        with patch('editing.os.replace', side_effect=swap):
            answer = self.save('# Meu texto\n', base=read['sha256'])
        self.assertEqual(self.assertRefusal(answer, 409, 'unconfirmed'), editing.LANDING_UNCONFIRMED)
        self.assertNotIn('Nothing was saved', answer[1]['error'])
        self.assertEqual(self.doc.read_bytes(), b'ALHEIO\n')

    def test_a_temporary_with_a_second_name_outside_the_project_is_never_a_success(self):
        """A hard link of the temporary in a folder outside the project is refused."""
        self.enable()
        status, read = self.read()
        outside = self.base / 'fora'
        outside.mkdir()
        real_replace = os.replace
        def link(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
            os.link(src, outside / 'hl.md', src_dir_fd=src_dir_fd)
            return real_replace(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        with patch('editing.os.replace', side_effect=link):
            answer = self.save('# Meu texto\n', base=read['sha256'])
        self.assertEqual(self.assertRefusal(answer, 409, 'unconfirmed'), editing.LANDING_UNCONFIRMED)
        self.assertEqual(self.doc.stat().st_nlink, 2)
        self.assertRefusal(self.read(), 400, 'hardlink')  # The save already announced what the next read says.

    def test_a_waiting_save_backs_off_within_the_same_total_budget(self):
        """On a fake clock: the interval grows up to 250 ms, the budget stays the same, fewer attempts."""
        self.enable()
        self.hold_folder()
        base = sha(self.doc.read_bytes())
        def run():
            clock, slept, attempts = [1000.0], [], []
            def sleep(seconds):
                slept.append(seconds)
                clock[0] += seconds
            real_save = editing.save
            def counted(*args):
                attempts.append(clock[0])
                return real_save(*args)
            fake = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=sleep)
            with patch.object(workspace_module, 'time', fake), patch.object(editing, 'save', counted), \
                    self.assertRaises(editing.FolderBusy):
                self.ws.edit_save(str(self.doc), base, '# Outro\n')
            return slept, attempts
        slept, attempts = run()
        self.assertEqual([round(seconds, 6) for seconds in slept[:5]], [0.05, 0.1, 0.2, 0.25, 0.25])
        self.assertLessEqual(max(slept), editing.LOCK_RETRY_MAX)
        self.assertAlmostEqual(sum(slept), editing.LOCK_WAIT, places=6)
        self.assertAlmostEqual(attempts[-1] - attempts[0], editing.LOCK_WAIT, places=6)
        self.assertTrue(20 <= len(attempts) <= 25, len(attempts))
        with patch.object(editing, 'LOCK_RETRY_MAX', editing.LOCK_RETRY):  # A fixed interval, without backoff.
            fixed = len(run()[1])
        self.assertGreater(fixed, 4 * len(attempts))
        self.assertEqual(self.doc.read_bytes(), b'# Guia\n\nTexto.\n')

    def test_a_text_that_starts_with_a_bom_is_refused(self):
        """A leading U+FEFF does not put a permanent BOM on a file without one."""
        self.enable()
        status, read = self.read()
        self.assertIn('BOM', self.assertRefusal(self.save('﻿x\n', base=read['sha256']), 400, 'invalid-text'))
        self.assertEqual(self.doc.read_bytes(), b'# Guia\n\nTexto.\n')
        self.assertFalse(self.read()[1]['bom'])

    def test_a_path_that_cannot_be_a_file_is_not_in_workspace_even_without_a_grant(self):
        """Without a grant these are refused with a code other than `edit-not-granted`, which would offer to enable editing."""
        self.call('/api/open', {'path': str(self.inner)})
        for path in ['docs/guia.md', '/' + str(self.doc), str(self.loja), str(self.inner), f'{self.loja}/',
                     str(self.base / 'fora.md')]:
            with self.subTest(path=path):
                self.assertRefusal(self.read(path), 400, 'not-in-workspace')
                self.assertRefusal(self.save('# x\n', path, base='0' * 64), 400, 'not-in-workspace')
        self.assertRefusal(self.read(), 403, 'edit-not-granted')

    def test_the_snapshot_shows_no_grant_whose_editing_is_refused_now(self):
        """Protected after the grant, through an alias, by a broken list, or a grant written by hand."""
        self.enable()
        alias = self.base / 'atalho'
        alias.symlink_to(self.loja, target_is_directory=True)
        for entry in [self.loja, alias, self.base, 'relativo/quebrado']:
            with self.subTest(entry=entry), patch.dict(os.environ, {ENVIRONMENT: str(entry)}):
                self.assertEqual(self.snapshot()['editing'], {})
                self.assertRefusal(self.read(), 403, 'protected')
        self.assertGranted(self.loja)
        with patch.dict(os.environ, {ENVIRONMENT: str(self.loja / 'docs')}):
            self.assertGranted(self.loja)  # Only a folder inside is protected: its files are refused one by one.
        self.call('/api/open', {'path': str(self.inner)})
        info = os.stat(self.inner)
        state = json.loads(self.ws.state_file.read_text())
        state['editing'][str(self.inner)] = {'at': '2026-11-15T10:00:00-03:00', 'dev': info.st_dev, 'ino': info.st_ino}
        self.ws.state_file.write_text(json.dumps(state))
        with patch.dict(os.environ, {ENVIRONMENT: str(self.inner)}):
            self.serve(Workspace(self.state))
            self.assertGranted(self.loja)
            self.assertRefusal(self.read(self.rule), 403, 'protected')
        self.assertGranted(self.loja, self.inner)

    def abandon(self, route, body):
        """Send a request and go away with a reset, without reading the answer."""
        raw = json.dumps(body).encode()
        sock = socket.create_connection(('127.0.0.1', self.server.server_port), timeout=10)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
        sock.sendall((f'POST {route} HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\nX-AAE-Token: {TOKEN}\r\n'
                      f'Content-Type: application/json\r\nContent-Length: {len(raw)}\r\n\r\n').encode() + raw)
        return sock

    def test_a_client_that_goes_away_leaves_no_traceback_nor_paths_in_the_log(self):
        """The client resets the connection while the edit route works."""
        self.call('/api/open', {'path': str(self.inner)})
        self.enable()
        entered, go = threading.Event(), threading.Event()
        def slow(function):
            def call(*args, **kwargs):
                entered.set()
                go.wait(10)
                return function(*args, **kwargs)
            return call
        full = StateWriteError(self.state, OSError(errno.ENOSPC, os.strerror(errno.ENOSPC)))
        cases = [('/api/edit/read', {'path': str(self.rule)}),  # a refusal whose message names both roots
                 ('/api/edit/read', {'path': str(self.doc)}),  # an answer with the document
                 ('/api/edit/save', {'path': str(self.doc), 'baseSha256': '0' * 64, 'text': '# x\n'}),  # conflict
                 ('/api/edit/enable', {'root': str(self.inner)})]  # the state cannot be written: names the state folder
        with patch.object(editing, 'granting_root', slow(editing.granting_root)), \
                patch.object(editing, 'grant', slow(editing.grant)), patch.object(self.ws, 'save', side_effect=full):
            for count, (route, body) in enumerate(cases, 1):
                with self.subTest(route=route, body=body):
                    entered.clear()
                    go.clear()
                    client = self.abandon(route, body)
                    self.assertTrue(entered.wait(10))
                    client.close()
                    time.sleep(0.05)
                    go.set()
                    deadline = time.monotonic() + 10
                    while self.log.getvalue().count('Client disconnected') < count and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertEqual(self.log.getvalue().count('Client disconnected'), count)
        log = self.log.getvalue()
        self.assertNotIn('Traceback', log)
        for secret in [str(self.inner), str(self.loja), str(self.state), 'Refusal', 'This file']:
            self.assertNotIn(secret, log)
        self.assertEqual(self.doc.read_bytes(), b'# Guia\n\nTexto.\n')

    def test_the_server_log_records_neither_bodies_nor_content(self):
        marker = 'CONTEUDO-SINTETICO-FORA-DO-LOG'
        self.enable()
        status, read = self.read()
        self.save(f'# {marker}\n', base=read['sha256'])
        self.save(f'# {marker} 2\n', base='0' * 64)
        self.read()
        log = self.log.getvalue()
        self.assertIn('"POST /api/edit/save" 200', log)
        self.assertIn('"POST /api/edit/save" 409', log)
        for secret in [marker, str(self.doc), 'guia.md', read['sha256'], TOKEN]:
            self.assertNotIn(secret, log)

    def test_state_and_references_hold_no_document_content(self):
        marker = 'MARCADOR-DE-CONTEUDO-SINTETICO'
        self.enable()
        status, read = self.read()
        self.assertEqual(self.save(f'# Guia\n\n{marker}\n', base=read['sha256'])[0], 200)
        self.assertEqual(self.call('/api/refresh', {})[0], 200)
        self.assertEqual(self.call('/api/reference', {})[0], 200)
        self.disable()
        self.enable()
        self.assertIn(marker, self.doc.read_text())
        checked = 0
        for path in self.state.rglob('*'):
            if path.is_file():
                data = path.read_bytes()
                if path.suffix == '.gz':
                    data = gzip.decompress(data)
                self.assertNotIn(marker.encode(), data, path.name)
                checked += 1
        self.assertGreaterEqual(checked, 2)  # workspace.json and the saved reference at least.


if __name__ == '__main__':
    unittest.main()
