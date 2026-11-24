"""A symlink loop gets the same refusal on every supported Python (3.10+).

Before 3.13, `Path.resolve` raised RuntimeError on a loop; from 3.13 on, OSError (ELOOP) in strict
mode and no error otherwise. `server/compat.py` gives the old versions the new definition. The
tests run each case with the interpreter's own `Path.resolve` and again with the pre-3.13 one
simulated, so they fail without the fix on any version.
"""
import contextlib
import errno
import http.client
import io
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import compat
from main import SYSTEM_ERRORS, make_handler
from workspace import Workspace

from server import cli

LOOP = SYSTEM_ERRORS[errno.ELOOP]


def legacy_resolve(self, strict=False):
    """`Path.resolve` as Python 3.10 to 3.12 define it on POSIX."""
    def check_eloop(exc):
        if exc.errno == errno.ELOOP:
            raise RuntimeError(f'Symlink loop from {exc.filename!r}')
    try:
        resolved = os.path.realpath(self, strict=strict)
    except OSError as exc:
        check_eloop(exc)
        raise
    path = type(self)(resolved)
    if not strict:
        try:
            path.stat()
        except OSError as exc:
            check_eloop(exc)
    return path


@contextlib.contextmanager
def legacy_python(fixed):
    """Simulate the pre-3.13 `Path.resolve`; with `fixed`, apply the compatibility patch over it."""
    with mock.patch.object(pathlib.Path, 'resolve', legacy_resolve):
        if fixed:
            compat.patch()
        yield


class SymlinkLoopTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-compat-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'project'
        self.root.mkdir()
        (self.root / 'AGENTS.md').write_text('# Agent\n[Policy](policy.md)\n', encoding='utf-8')
        self.policy = self.root / 'policy.md'
        self.policy.write_text('# Policy\n', encoding='utf-8')
        self.loop = self.base / 'loop-a'
        self.loop.symlink_to(self.base / 'loop-b')
        (self.base / 'loop-b').symlink_to(self.loop)
        self.ws = Workspace(self.base / 'state')
        self.ws.open(str(self.root))
        self.policy.unlink()
        self.policy.symlink_to(self.policy)  # A document of the reading turned into a loop afterwards.
        static = self.base / 'static'
        static.mkdir()
        (static / 'index.html').write_text('<title>Synthetic</title>', encoding='utf-8')
        (static / 'self').symlink_to(static / 'self')
        handler = make_handler(self.ws, static, 'compat-token')
        handler.log_message = lambda *args: None
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.port = server.server_port
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

    def request(self, route, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        headers = {'X-AAE-Token': 'compat-token'}
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body).encode('utf-8')
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                connection.request('POST' if body is not None else 'GET', route, data, headers)
                response = connection.getresponse()
                return response.status, response.read()
        finally:
            connection.close()

    def assert_loop_refusals(self):
        cases = {
            'content': ('/api/content?' + urlencode({'path': str(self.policy)}), None),
            'open': ('/api/open', {'path': str(self.loop)}),
            'directories': ('/api/directories?' + urlencode({'path': str(self.loop)}), None),
            'create': ('/api/create', {'parent': str(self.loop), 'name': 'fresh', 'primitives': [{'name': 'main', 'type': 'agent'}]}),
        }
        for name, (route, body) in cases.items():
            with self.subTest(route=name):
                status, payload = self.request(route, body)
                self.assertEqual((status, json.loads(payload)), (400, {'error': LOOP}))
        with self.subTest(route='static'):
            self.assertEqual(self.request('/self'), (200, b'<title>Synthetic</title>'))
        with self.subTest(command='aae audit'):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                code = cli.main(['audit', '--root', str(self.loop)])
            self.assertEqual(code, 2)
            self.assertEqual([f['code'] for f in json.loads(out.getvalue())['findings']], ['invalid-input'])

    def test_loop_is_refused_with_the_interpreter_resolve(self):
        self.assert_loop_refusals()

    def test_loop_is_refused_with_the_pre_313_resolve(self):
        with legacy_python(fixed=True):
            self.assert_loop_refusals()

    def test_simulation_reproduces_the_pre_313_defect(self):
        """Guards the simulation itself: without the patch, the old resolve is a 500."""
        with legacy_python(fixed=False):
            status, payload = self.request('/api/content?' + urlencode({'path': str(self.policy)}))
        self.assertEqual(status, 500)
        self.assertIn('RuntimeError', json.loads(payload)['error'])

    def test_patch_matches_realpath_for_loops_and_missing_paths(self):
        with legacy_python(fixed=True):
            with self.assertRaises(OSError) as caught:
                self.loop.resolve(strict=True)
            self.assertEqual(caught.exception.errno, errno.ELOOP)
            self.assertEqual(str(self.loop.resolve()), os.path.realpath(self.loop))
            with self.assertRaises(FileNotFoundError):
                (self.base / 'absent').resolve(strict=True)
            self.assertEqual((self.base / 'absent' / '..' / 'x').resolve(), Path(os.path.realpath(self.base / 'x')))


if __name__ == '__main__':
    unittest.main()
